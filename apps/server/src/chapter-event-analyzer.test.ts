import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiResponsesChapterAnalyzer,
  parseChapterAnalysisEvents,
  type ChapterEvidenceAtom,
} from "./chapter-event-analyzer.js";

const atoms: ChapterEvidenceAtom[] = [
  { id: "evidence_a", byteStart: 100, byteEnd: 112, text: "吴邪进入墓道" },
  { id: "evidence_b", byteStart: 120, byteEnd: 132, text: "血尸突然出现" },
];

test("自动分析只把已冻结 evidenceId 映射为服务端字节范围", () => {
  assert.deepEqual(parseChapterAnalysisEvents(JSON.stringify({
    events: [{
      type: "causality",
      payload: { cause: "吴邪进入墓道", effect: "血尸出现" },
      evidenceIds: ["evidence_a", "evidence_b"],
    }],
  }), atoms), [{
    type: "causality",
    payload: { cause: "吴邪进入墓道", effect: "血尸出现" },
    sources: [{ byteStart: 100, byteEnd: 112 }, { byteStart: 120, byteEnd: 132 }],
  }]);
});

test("自动分析拒绝未知、重复 evidenceId 和模型字节偏移", () => {
  assert.throws(() => parseChapterAnalysisEvents(JSON.stringify({
    events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_missing"] }],
  }), atoms), /未知证据 ID/);
  assert.throws(() => parseChapterAnalysisEvents(JSON.stringify({
    events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_a", "evidence_a"] }],
  }), atoms), /重复引用/);
  assert.throws(() => parseChapterAnalysisEvents(JSON.stringify({
    events: [{ type: "location", payload: { name: "墓道" }, byteStart: 0, byteEnd: 1 }],
  }), atoms), /必须引用/);
});

const config = {
  baseUrl: "https://model.example/v1",
  apiKey: "key",
  model: "model",
  providerId: "provider",
};

function modelResponse(value: unknown) {
  return new Response(JSON.stringify({ output_text: typeof value === "string" ? value : JSON.stringify(value) }));
}

test("证据 ID 首答非法时只纠错一次并接受严格合法答复", async () => {
  const replies = [
    { events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_missing"] }] },
    { events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_a"] }] },
  ];
  const requests: string[] = [];
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async (_input, init) => {
    requests.push(String(init?.body));
    return modelResponse(replies.shift());
  }) as typeof fetch);

  assert.deepEqual(await analyzer({ chapterId: "chapter", atoms }), [{
    type: "location",
    payload: { name: "墓道" },
    sources: [{ byteStart: 100, byteEnd: 112 }],
  }]);
  assert.equal(requests.length, 2);
  assert.match(requests[1]!, /evidence_a/);
  assert.match(requests[1]!, /evidence_b/);
});

test("证据 ID 纠错答复仍非法时失败且不做第三次请求", async () => {
  let calls = 0;
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
    calls += 1;
    return modelResponse({ events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_missing"] }] });
  }) as typeof fetch);

  await assert.rejects(() => analyzer({ chapterId: "chapter", atoms }), /未知证据 ID/);
  assert.equal(calls, 2);
});

test("HTTP 和非 JSON 错误不触发证据纠错请求", async () => {
  for (const response of [new Response("failed", { status: 500 }), modelResponse("not-json")]) {
    let calls = 0;
    const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
      calls += 1;
      return response;
    }) as typeof fetch);
    await assert.rejects(() => analyzer({ chapterId: "chapter", atoms }));
    assert.equal(calls, 1);
  }
});

test("Abort 后不触发证据纠错请求", async () => {
  const controller = new AbortController();
  let calls = 0;
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
    calls += 1;
    controller.abort();
    return modelResponse({ events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_missing"] }] });
  }) as typeof fetch);

  await assert.rejects(() => analyzer({ chapterId: "chapter", atoms, signal: controller.signal }), /未知证据 ID/);
  assert.equal(calls, 1);
});
