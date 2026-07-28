import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_BOOK_PLAN_JOB_TYPE,
  createFullBookPlanJobHandler,
  fullBookPlanJobRequestHash,
  type FullBookPlanJobPayload,
} from "./full-book-plan-job-handler.js";
import {
  FULL_BOOK_PLAN_JOB_CONTRACT_VERSION,
  buildFullBookPlanIntervalRequests,
  type FullBookPlanBuildLimits,
} from "./full-book-plan-job.js";
import type { JobExecutionContext } from "./job-worker.js";

const config = {
  baseUrl: "https://model.invalid/v1", apiKey: "test", model: "model-a", providerId: "provider-a",
  protocol: "openai-response" as const,
};
const limits: FullBookPlanBuildLimits = {
  maxChaptersPerInterval: 1, maxEventsPerInterval: 1, maxInputBytesPerInterval: 1_000,
  maxFinalIntervals: 2, maxFinalInputBytes: 100_000,
};

function payload(): FullBookPlanJobPayload {
  const storyBible = { id: "bible_a", contentHash: "b".repeat(64) };
  const intervals = buildFullBookPlanIntervalRequests("book_a", storyBible, [0, 1].map((chapterIndex) => ({
    chapterId: `chapter_${chapterIndex}`, chapterIndex,
    sourceEvents: [{
      id: `event_${chapterIndex}`, contentHash: `${chapterIndex + 1}`.repeat(64), inputBytes: 10,
      chapterId: `chapter_${chapterIndex}`, chapterIndex,
      byteRanges: [{ byteStart: chapterIndex * 10, byteEnd: chapterIndex * 10 + 9 }],
    }],
  })), 2, { providerId: config.providerId, model: config.model }, limits);
  const frozen = { contractVersion: FULL_BOOK_PLAN_JOB_CONTRACT_VERSION, bookId: "book_a", storyBible,
    episodeCount: 2, intervals, limits } as const;
  return { ...frozen, providerId: config.providerId, model: config.model,
    requestHash: fullBookPlanJobRequestHash(frozen) };
}

function plan(events: string[]) {
  return { episodes: events.map((event, index) => ({
    index: index + 1, title: `第 ${index + 1} 集`, storyArc: "忠实覆盖原文事件",
    sourceEventIds: [event], recap: null, nextHook: null,
  })) };
}

function context(task: FullBookPlanJobPayload) {
  const checkpoints: string[] = [];
  const progress: number[] = [];
  return {
    checkpoints, progress,
    value: {
      job: { id: `job_${task.requestHash}`, type: FULL_BOOK_PLAN_JOB_TYPE, payload: task },
      reportProgress: (value: number) => { progress.push(value); },
      isCancellationRequested: () => false,
      throwIfCancellationRequested: () => undefined,
      getCheckpoint: () => undefined,
      commitCheckpoint: (stage: string, scopeKey: string) => {
        checkpoints.push(`${stage}:${scopeKey}`);
        return { checkpoint: { jobId: "job", stage, scopeKey, inputHash: scopeKey, completedAt: 1 },
          created: true, replaced: false };
      },
    } as unknown as JobExecutionContext,
  };
}

test("依次执行 interval 和独立 final，产出恰好 N 集的服务端验证计划", async () => {
  const task = payload();
  const calls: string[] = [];
  const responses = [plan(["event_0"]), plan(["event_1"]), plan(["event_0", "event_1"])];
  let index = 0;
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { input: string };
    const prompt = request.input.split("\n").at(-1)!;
    calls.push((JSON.parse(prompt) as { kind: string }).kind);
    return new Response(JSON.stringify({ output_text: JSON.stringify(responses[index++]) }), { status: 200 });
  };
  const execution = context(task);
  const result = await createFullBookPlanJobHandler(config, { fetchImpl: fetchImpl as typeof fetch })(execution.value) as {
    plan: { episodes: unknown[] }; validation: { episodeCount: number; intervalQuotas: unknown[] };
  };
  assert.deepEqual(calls, ["interval", "interval", "final"]);
  assert.equal(result.plan.episodes.length, 2);
  assert.equal(result.validation.episodeCount, 2);
  assert.equal(result.validation.intervalQuotas.length, 2);
  assert.deepEqual(execution.progress, [1 / 3, 2 / 3, 1]);
  assert.equal(execution.checkpoints.length, 3);
});

test("冻结 identity 被篡改时在模型调用前失败", async () => {
  const task = payload();
  task.intervals[0]!.sourceEvents[0]!.contentHash = "f".repeat(64);
  let called = false;
  const handler = createFullBookPlanJobHandler(config, {
    fetchImpl: (async () => { called = true; return new Response(); }) as typeof fetch,
  });
  await assert.rejects(() => handler(context(task).value), /冻结身份不一致/);
  assert.equal(called, false);
});

test("伪造来源或破坏配额的模型结果在返回 Store 前失败", async () => {
  for (const forged of [plan(["event_forged"]), plan(["event_0", "event_1"])]) {
    const task = payload();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ output_text: JSON.stringify(forged) }), { status: 200 });
    }) as typeof fetch;
    await assert.rejects(() => createFullBookPlanJobHandler(config, { fetchImpl })(context(task).value));
    assert.equal(calls, 2);
  }
});

test("首答回显包装字段时仅纠错一次，并使用同一任务与精确 schema", async () => {
  const task = payload();
  const prompts: string[] = [];
  const responses = [
    { kind: "interval", identityHash: "x", start: 0, end: 0, episodeCount: 1, ...plan(["event_0"]) },
    plan(["event_0"]),
    plan(["event_1"]),
    plan(["event_0", "event_1"]),
  ];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { input: string };
    prompts.push(request.input);
    return new Response(JSON.stringify({ output_text: JSON.stringify(responses.shift()) }), { status: 200 });
  }) as typeof fetch;
  const result = await createFullBookPlanJobHandler(config, { fetchImpl })(context(task).value) as {
    plan: { episodes: unknown[] };
  };
  assert.equal(result.plan.episodes.length, 2);
  assert.equal(prompts.length, 4);
  assert.match(prompts[0]!, /唯一允许的输出 schema.*\{episodes:\[\{index:number,title:string,storyArc:string,sourceEventIds:string\[\],recap:string\|null,nextHook:string\|null\}\]\}/u);
  assert.match(prompts[1]!, /包含未知字段/u);
  assert.equal(prompts[0]!.split("\n").at(-1), prompts[1]!.split("\n").at(-1));
  assert.match(prompts[3]!, /逐项满足 request\.intervalQuotas/u);
});

test("纠错答仍非法时不发起第三次请求", async () => {
  const task = payload();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ output_text: JSON.stringify({ kind: "interval", ...plan(["event_0"]) }) }));
  }) as typeof fetch;
  await assert.rejects(() => createFullBookPlanJobHandler(config, { fetchImpl })(context(task).value), /未知字段/u);
  assert.equal(calls, 2);
});

test("HTTP、非 JSON 与 abort 错误不触发合同纠错", async () => {
  const cases: Array<{ fetchImpl: typeof fetch; message: RegExp }> = [
    { fetchImpl: (async () => new Response("bad gateway", { status: 502 })) as typeof fetch, message: /HTTP 502/u },
    { fetchImpl: (async () => new Response("not json")) as typeof fetch, message: /无效 JSON/u },
    { fetchImpl: (async () => { throw new DOMException("aborted", "AbortError"); }) as typeof fetch, message: /aborted/u },
  ];
  for (const item of cases) {
    let calls = 0;
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return item.fetchImpl(...args);
    }) as typeof fetch;
    await assert.rejects(() => createFullBookPlanJobHandler(config, { fetchImpl })(context(payload()).value), item.message);
    assert.equal(calls, 1);
  }
});
