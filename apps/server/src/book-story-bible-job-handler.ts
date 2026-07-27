import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  limitedJson,
  responseText,
  textModelRequest,
  type ChapterTextModelConfig,
} from "./chapter-event-analyzer.js";
import {
  BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION,
  buildStoryBibleFinalRequest,
  parseStoryBibleFinalResponse,
  parseStoryBibleIntervalResponse,
  type StoryBibleBuildLimits,
  type StoryBibleIntervalRequest,
} from "./book-story-bible-job.js";
import { createBookStoryBible } from "./book-story-bible-store.js";
import { JobCancelledError, type JobHandler } from "./job-worker.js";

export const BOOK_STORY_BIBLE_JOB_TYPE = "book_story_bible_build";

export interface BookStoryBibleJobPayload {
  contractVersion: typeof BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION;
  bookId: string;
  intervals: StoryBibleIntervalRequest[];
  limits: StoryBibleBuildLimits;
  forceRebuild: boolean;
  providerId: string;
  model: string;
  requestHash: string;
}

interface StoredBible {
  id: string;
  contentHash: string;
}

interface HandlerOptions {
  fetchImpl?: typeof fetch;
  createBible?: typeof createBookStoryBible;
}

const HASH = /^[0-9a-f]{64}$/u;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  throw new Error("故事圣经任务参数必须是有限 JSON");
}

export function storyBibleJobRequestHash(payload: Omit<BookStoryBibleJobPayload, "providerId" | "model" | "requestHash">) {
  return sha256(canonical({
    contractVersion: payload.contractVersion,
    bookId: payload.bookId,
    intervalIdentityHashes: payload.intervals.map((interval) => interval.identityHash),
    limits: payload.limits,
    forceRebuild: payload.forceRebuild,
  }));
}

function parsePayload(value: unknown, config: ChapterTextModelConfig): BookStoryBibleJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("故事圣经任务冻结参数无效");
  }
  const row = value as Record<string, unknown>;
  const expected = ["bookId", "contractVersion", "forceRebuild", "intervals", "limits", "model", "providerId", "requestHash"];
  if (Object.keys(row).sort().join(",") !== expected.sort().join(",") ||
      row.contractVersion !== BOOK_STORY_BIBLE_JOB_CONTRACT_VERSION || typeof row.bookId !== "string" ||
      !row.bookId.trim() || !Array.isArray(row.intervals) || row.intervals.length === 0 ||
      typeof row.forceRebuild !== "boolean" || typeof row.providerId !== "string" || typeof row.model !== "string" ||
      typeof row.requestHash !== "string" || !HASH.test(row.requestHash) ||
      !row.limits || typeof row.limits !== "object" || Array.isArray(row.limits)) {
    throw new Error("故事圣经任务冻结参数无效");
  }
  const payload = row as unknown as BookStoryBibleJobPayload;
  const limitKeys = ["maxChaptersPerInterval", "maxEventsPerInterval", "maxFinalInputBytes",
    "maxFinalIntervals", "maxInputBytesPerInterval"];
  if (Object.keys(payload.limits).sort().join(",") !== limitKeys.sort().join(",") ||
      Object.values(payload.limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1) ||
      payload.intervals.length > payload.limits.maxFinalIntervals || canonical(payload).length > 10_000_000) {
    throw new Error("故事圣经任务冻结参数无效");
  }
  if (payload.bookId !== payload.bookId.trim() || payload.providerId !== config.providerId.trim() ||
      payload.model !== config.model.trim() || payload.intervals.some((request) =>
        request?.kind !== "interval" || request.identity?.bookId !== payload.bookId ||
        request.provenance?.providerId !== payload.providerId || request.provenance?.model !== payload.model) ||
      storyBibleJobRequestHash(payload) !== payload.requestHash) {
    throw new Error("故事圣经任务冻结身份不一致");
  }
  return payload;
}

function sourceEvents(database: DatabaseSync, request: StoryBibleIntervalRequest) {
  const rows = database.prepare(
    `SELECT id, chapter_id, event_index, occurrence, event_type, payload_json
     FROM chapter_events WHERE id IN (${request.sourceEventIds.map(() => "?").join(",")})`,
  ).all(...request.sourceEventIds) as unknown as Array<{
    id: string; chapter_id: string; event_index: number; occurrence: number; event_type: string; payload_json: string;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return request.sourceEventIds.map((id) => {
    const event = byId.get(id);
    if (!event || !request.chapterIds.includes(event.chapter_id)) {
      throw new Error("故事圣经任务来源事件不存在或已越出冻结章节范围");
    }
    let payload: unknown;
    try { payload = JSON.parse(event.payload_json); }
    catch { throw new Error("故事圣经任务来源事件不是有效 JSON"); }
    return { id, chapterId: event.chapter_id, eventIndex: event.event_index, occurrence: event.occurrence,
      eventType: event.event_type, payload };
  });
}

async function callModel(
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch,
  input: unknown,
  signal: AbortSignal,
) {
  const request = textModelRequest(config,
    `你是书籍故事圣经汇总器。只能引用输入中的 sourceEventIds，输出严格 JSON 且不得添加未知字段。\n${canonical(input)}`);
  const response = await fetchImpl(request.endpoint, {
    method: "POST", headers: request.headers, body: request.body, signal, redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`故事圣经模型请求失败（HTTP ${response.status}）`);
  }
  try { return JSON.parse(responseText(await limitedJson(response))) as unknown; }
  catch (error) {
    if (error instanceof Error && /大小限制/u.test(error.message)) throw error;
    throw new Error("故事圣经模型返回了无效 JSON");
  }
}

async function withCancellation<T>(context: Parameters<JobHandler>[0], call: (signal: AbortSignal) => Promise<T>) {
  context.throwIfCancellationRequested();
  const controller = new AbortController();
  const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
  try {
    return await call(AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
  } catch (error) {
    if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("故事圣经模型请求超时");
    throw error;
  } finally { clearInterval(poll); }
}

export function createBookStoryBibleJobHandler(
  database: DatabaseSync,
  config: ChapterTextModelConfig,
  options: HandlerOptions = {},
): JobHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  const createBible = options.createBible ?? createBookStoryBible;
  return async (context) => {
    if (context.job.type !== BOOK_STORY_BIBLE_JOB_TYPE) throw new Error("故事圣经任务类型无效");
    const task = parsePayload(context.job.payload, config);
    const verified = [];
    const intervalBibles: StoredBible[] = [];
    for (const [index, request] of task.intervals.entries()) {
      const checkpoint = context.getCheckpoint("book-story-bible-interval", request.identityHash);
      const raw = await withCancellation(context, (signal) => callModel(config, fetchImpl, {
        kind: "interval", request, sourceEvents: sourceEvents(database, request),
      }, signal));
      const parsed = parseStoryBibleIntervalResponse(request, raw);
      context.throwIfCancellationRequested();
      const bible = createBible(database, {
        bookId: task.bookId, scope: "interval", sourceStartChapterId: request.chapterIds[0]!,
        sourceEndChapterId: request.chapterIds.at(-1)!, sourceEventIds: request.sourceEventIds,
        providerId: task.providerId, model: task.model, jobId: context.job.id, content: parsed.content,
      }, { forceRebuild: task.forceRebuild && !checkpoint });
      verified.push(parsed);
      intervalBibles.push(bible);
      context.commitCheckpoint("book-story-bible-interval", request.identityHash, request.identityHash, () => undefined);
      context.reportProgress((index + 1) / (task.intervals.length + 1));
    }
    const finalRequest = buildStoryBibleFinalRequest(task.bookId, verified, {
      providerId: task.providerId, model: task.model,
    }, task.limits);
    const finalCheckpoint = context.getCheckpoint("book-story-bible-final", finalRequest.identityHash);
    const rawFinal = await withCancellation(context, (signal) => callModel(config, fetchImpl, {
      kind: "final", request: finalRequest,
    }, signal));
    const final = parseStoryBibleFinalResponse(finalRequest, rawFinal);
    context.throwIfCancellationRequested();
    const bible = createBible(database, {
      bookId: task.bookId, scope: "final", sourceStartChapterId: task.intervals[0]!.chapterIds[0]!,
      sourceEndChapterId: task.intervals.at(-1)!.chapterIds.at(-1)!, sourceEventIds: finalRequest.sourceEventIds,
      parentBibleIds: intervalBibles.map((item) => item.id), providerId: task.providerId, model: task.model,
      jobId: context.job.id, content: final.content,
    }, { forceRebuild: task.forceRebuild && !finalCheckpoint });
    context.commitCheckpoint("book-story-bible-final", finalRequest.identityHash, finalRequest.identityHash, () => undefined);
    context.reportProgress(1);
    return { storyBibleId: bible.id, contentHash: bible.contentHash, intervalBibleIds: intervalBibles.map((item) => item.id) };
  };
}
