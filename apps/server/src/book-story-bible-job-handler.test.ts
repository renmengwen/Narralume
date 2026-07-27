import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOK_STORY_BIBLE_JOB_TYPE,
  createBookStoryBibleJobHandler,
  storyBibleJobRequestHash,
  type BookStoryBibleJobPayload,
} from "./book-story-bible-job-handler.js";
import {
  BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION,
  buildStoryBibleIntervalRequests,
  type StoryBibleBuildLimits,
} from "./book-story-bible-job.js";
import type { JobExecutionContext } from "./job-worker.js";

const limits: StoryBibleBuildLimits = {
  maxChaptersPerInterval: 1, maxEventsPerInterval: 1, maxInputBytesPerInterval: 1_000,
  maxFinalIntervals: 2, maxFinalInputBytes: 100_000,
};
const config = {
  baseUrl: "https://model.invalid/v1", apiKey: "test", model: "model-a", providerId: "provider-a",
  protocol: "openai-response" as const,
};

function content(sourceEventId: string, chapterId: string) {
  return {
    characters: [], relationships: [], locations: [], organizations: [], items: [], concepts: [],
    timeline: [{ summary: "已验证事件", chapterIds: [chapterId], sourceEventIds: [sourceEventId] }],
    flashbacks: [], plotThreads: [], confusingFacts: [], spoilerRestrictions: [], properNouns: [],
  };
}

function payload(): BookStoryBibleJobPayload {
  const intervals = buildStoryBibleIntervalRequests("book_a", [0, 1].map((chapterIndex) => ({
    chapterId: `chapter_${chapterIndex}`, chapterIndex,
    sourceEvents: [{ id: `event_${chapterIndex}`, contentHash: `${chapterIndex + 1}`.repeat(64), inputBytes: 10 }],
  })), { providerId: config.providerId, model: config.model }, limits);
  const base = { contractVersion: BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION, bookId: "book_a", intervals, limits,
    forceRebuild: false } as const;
  return { ...base, providerId: config.providerId, model: config.model, requestHash: storyBibleJobRequestHash(base) };
}

function context(task: BookStoryBibleJobPayload) {
  const checkpoints: string[] = [];
  const progress: number[] = [];
  const value = {
    job: { id: `job_bible_${task.requestHash}`, type: BOOK_STORY_BIBLE_JOB_TYPE, payload: task },
    reportProgress: (item: number) => { progress.push(item); },
    isCancellationRequested: () => false,
    throwIfCancellationRequested: () => undefined,
    getCheckpoint: () => undefined,
    commitCheckpoint: (stage: string, scopeKey: string) => {
      checkpoints.push(`${stage}:${scopeKey}`);
      return { checkpoint: { jobId: "job", stage, scopeKey, inputHash: scopeKey, completedAt: 1 }, created: true, replaced: false };
    },
  } as unknown as JobExecutionContext;
  return { value, checkpoints, progress };
}

test("严格执行 interval 后独立 final，并将模型身份仅保存为溯源", async () => {
  const task = payload();
  const calls: Array<{ kind: string }> = [];
  const stored: Array<Record<string, unknown>> = [];
  let responseIndex = 0;
  const responses = [content("event_0", "chapter_0"), content("event_1", "chapter_1"), content("event_0", "chapter_0")];
  const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { input: string };
    const prompt = JSON.parse(request.input.slice(request.input.indexOf("\n") + 1)) as { kind: string };
    calls.push(prompt);
    return new Response(JSON.stringify({ output_text: JSON.stringify(responses[responseIndex++]) }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  const database = { prepare: () => ({ all: (...ids: string[]) => ids.map((id) => ({
    id, chapter_id: id.replace("event", "chapter"), event_index: 0, occurrence: 1,
    event_type: "plot", payload_json: JSON.stringify({ summary: id }),
  })) }) } as never;
  const createBible = ((_database: never, input: Record<string, unknown>) => {
    stored.push(input);
    return { id: `bible_${stored.length}`, contentHash: `${stored.length}`.repeat(64) };
  }) as never;
  const execution = context(task);
  const result = await createBookStoryBibleJobHandler(database, config, { fetchImpl: fetchImpl as typeof fetch, createBible })(execution.value);
  assert.deepEqual(calls.map((call) => call.kind), ["interval", "interval", "final"]);
  assert.equal(stored.length, 3);
  assert.deepEqual(stored.at(-1)?.parentBibleIds, ["bible_1", "bible_2"]);
  assert.equal(stored[0]?.providerId, config.providerId);
  assert.deepEqual(execution.progress, [1 / 3, 2 / 3, 1]);
  assert.equal(execution.checkpoints.length, 3);
  assert.deepEqual(result, { storyBibleId: "bible_3", contentHash: "3".repeat(64), intervalBibleIds: ["bible_1", "bible_2"] });
});

test("拒绝被篡改的冻结身份且不会调用模型", async () => {
  const task = payload();
  task.providerId = "switched-provider";
  let called = false;
  const handler = createBookStoryBibleJobHandler({} as never, config, {
    fetchImpl: (async () => { called = true; return new Response(); }) as typeof fetch,
  });
  await assert.rejects(() => handler(context(task).value), /身份不一致/);
  assert.equal(called, false);
});

test("模型伪造来源时在持久化前失败", async () => {
  const task = payload();
  let writes = 0;
  const database = { prepare: () => ({ all: (...ids: string[]) => ids.map((id) => ({
    id, chapter_id: id.replace("event", "chapter"), event_index: 0, occurrence: 1,
    event_type: "plot", payload_json: "{}",
  })) }) } as never;
  const fetchImpl = (async () => new Response(JSON.stringify({
    output_text: JSON.stringify(content("event_forged", "chapter_0")),
  }), { status: 200 })) as typeof fetch;
  const handler = createBookStoryBibleJobHandler(database, config, {
    fetchImpl, createBible: (() => { writes += 1; return { id: "x", contentHash: "1".repeat(64) }; }) as never,
  });
  await assert.rejects(() => handler(context(task).value), /未获准事件/);
  assert.equal(writes, 0);
});
