import assert from "node:assert/strict";
import test from "node:test";

import {
  FullBookPlanJobContractError,
  buildFullBookPlanFinalRequest,
  buildFullBookPlanIntervalRequests,
  parseFullBookPlanFinalResponse,
  parseFullBookPlanIntervalResponse,
  type FullBookPlanBuildLimits,
  type FullBookPlanChapterInput,
} from "./full-book-plan-job.js";

const limits: FullBookPlanBuildLimits = {
  maxChaptersPerInterval: 2,
  maxEventsPerInterval: 2,
  maxInputBytesPerInterval: 1_000,
  maxFinalIntervals: 10,
  maxFinalInputBytes: 100_000,
};
const bible = { id: "bible_1", contentHash: "b".repeat(64) };

function chapters(): FullBookPlanChapterInput[] {
  return [0, 1, 2, 3].map((chapterIndex) => ({
    chapterId: `chapter_${chapterIndex}`,
    chapterIndex,
    sourceEvents: [{
      id: `event_${chapterIndex}`,
      contentHash: `${chapterIndex}`.repeat(64),
      inputBytes: chapterIndex < 2 ? 100 : 200,
      chapterId: `chapter_${chapterIndex}`,
      chapterIndex,
      byteRanges: [{ byteStart: chapterIndex * 100, byteEnd: chapterIndex * 100 + 90 }],
    }],
  }));
}

function plan(start: number, count: number) {
  return {
    episodes: Array.from({ length: count }, (_, offset) => ({
      index: offset + 1,
      title: `第 ${offset + 1} 集`,
      storyArc: "忠实覆盖原文事件",
      sourceEventIds: [`event_${start + offset}`],
      recap: null,
      nextHook: null,
    })),
  };
}

test("确定性切分有界区间并分配正整数配额，总和恰好为 N", () => {
  const requests = buildFullBookPlanIntervalRequests(
    "book_1", bible, chapters(), 4, { providerId: "p1", model: "m1" }, limits,
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ identity }) => identity.episodeCount), [2, 2]);
  assert.equal(requests.reduce((sum, request) => sum + request.identity.episodeCount, 0), 4);
  assert.ok(requests.every((request) => request.identity.episodeCount > 0));
});

test("切换 provider/model 只改变 provenance，不改变 interval/final identity", () => {
  const first = buildFullBookPlanIntervalRequests(
    "book_1", bible, chapters(), 4, { providerId: "p1", model: "m1" }, limits,
  );
  const switched = buildFullBookPlanIntervalRequests(
    "book_1", bible, chapters(), 4, { providerId: "p2", model: "m2" }, limits,
  );
  assert.deepEqual(first.map(({ identityHash }) => identityHash), switched.map(({ identityHash }) => identityHash));
  assert.notDeepEqual(first.map(({ provenance }) => provenance), switched.map(({ provenance }) => provenance));
  const verifiedA = first.map((request, index) => parseFullBookPlanIntervalResponse(request, plan(index * 2, 2)));
  const verifiedB = switched.map((request, index) => parseFullBookPlanIntervalResponse(request, plan(index * 2, 2)));
  assert.equal(
    buildFullBookPlanFinalRequest("book_1", bible, 4, verifiedA, { providerId: "p1", model: "m1" }, limits).identityHash,
    buildFullBookPlanFinalRequest("book_1", bible, 4, verifiedB, { providerId: "p2", model: "m2" }, limits).identityHash,
  );
});

test("独立 final 请求交由 strict validator 收口且模型输出不含字节范围", () => {
  const requests = buildFullBookPlanIntervalRequests(
    "book_1", bible, chapters(), 4, { providerId: "p", model: "m" }, limits,
  );
  const verified = requests.map((request, index) => parseFullBookPlanIntervalResponse(request, plan(index * 2, 2)));
  const finalRequest = buildFullBookPlanFinalRequest(
    "book_1", bible, 4, verified, { providerId: "p", model: "m" }, limits,
  );
  const finalPlan = {
    episodes: chapters().map((_, index) => ({
      index: index + 1,
      title: `全书第 ${index + 1} 集`,
      storyArc: "忠实覆盖原文事件",
      sourceEventIds: [`event_${index}`],
      recap: null,
      nextHook: null,
    })),
  };
  assert.equal(finalRequest.kind, "final");
  assert.notEqual(finalRequest.identityHash, requests[0]!.identityHash);
  assert.doesNotThrow(() => parseFullBookPlanFinalResponse(finalRequest, finalPlan));
  assert.ok(!JSON.stringify(finalPlan).includes("byteStart"));
  assert.throws(
    () => parseFullBookPlanFinalResponse(finalRequest, { ...finalPlan, episodes: finalPlan.episodes.slice(0, 3) }),
    /恰好包含 4 集/,
  );
  finalRequest.intervalQuotas[0]!.episodeCount = 1;
  assert.throws(() => parseFullBookPlanFinalResponse(finalRequest, finalPlan), /最终请求身份无效/);
});

test("拒绝无法分配正整数配额、超限单章和被篡改的聚合输入", () => {
  const onePerInterval = { ...limits, maxChaptersPerInterval: 1 };
  assert.throws(
    () => buildFullBookPlanIntervalRequests(
      "book_1", bible, chapters(), 3, { providerId: "p", model: "m" }, onePerInterval,
    ),
    /区间数不能超过总集数/,
  );
  assert.throws(
    () => buildFullBookPlanIntervalRequests(
      "book_1", bible, chapters(), 5, { providerId: "p", model: "m" }, limits,
    ),
    /不能超过可唯一分配的来源事件数/,
  );
  const oversized = chapters();
  oversized[0]!.sourceEvents[0]!.inputBytes = 1_001;
  assert.throws(
    () => buildFullBookPlanIntervalRequests("book_1", bible, oversized, 4, { providerId: "p", model: "m" }, limits),
    /单章事件超过.*上限/,
  );
  const requests = buildFullBookPlanIntervalRequests(
    "book_1", bible, chapters(), 4, { providerId: "p", model: "m" }, limits,
  );
  const verified = requests.map((request, index) => parseFullBookPlanIntervalResponse(request, plan(index * 2, 2)));
  verified[0]!.content.episodes[0]!.title = "排队后篡改";
  assert.throws(
    () => buildFullBookPlanFinalRequest("book_1", bible, 4, verified, { providerId: "p", model: "m" }, limits),
    /已验证的区间/,
  );
});

test("错误类型稳定", () => {
  assert.throws(
    () => buildFullBookPlanIntervalRequests("bad id", bible, chapters(), 4, { providerId: "p", model: "m" }, limits),
    FullBookPlanJobContractError,
  );
});
