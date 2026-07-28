import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  BookStoryBibleContractError,
  parseBookStoryBibleContent,
} from "./book-story-bible-contract.js";
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
import { streamedText } from "./text-model-stream.js";

export const BOOK_STORY_BIBLE_JOB_TYPE = "book_story_bible_build";
export const BOOK_STORY_BIBLE_TIMEOUT_MS = 180_000;
export const BOOK_STORY_BIBLE_IDLE_TIMEOUT_MS = 180_000;
export const BOOK_STORY_BIBLE_TOTAL_TIMEOUT_MS = 900_000;

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
const OUTPUT_SCHEMA = `输出必须是一个普通 JSON 对象，且顶层必须恰好包含以下 12 个数组（不得缺少或增加字段）：
characters: [{canonicalName:string, aliases:string[], identities:[{text:string, sourceEventIds:string[]}], motivations:[{text:string, sourceEventIds:string[]}], stateChanges:[{state:string, chapterIds:string[], sourceEventIds:string[]}], sourceEventIds:string[]}]
relationships: [{subject:string, object:string, relation:string, chapterIds:string[], sourceEventIds:string[]}]
locations: [{name:string, aliases:string[], detail:string, sourceEventIds:string[]}]
organizations: [{name:string, aliases:string[], detail:string, sourceEventIds:string[]}]
items: [{name:string, aliases:string[], detail:string, sourceEventIds:string[]}]
concepts: [{name:string, aliases:string[], detail:string, sourceEventIds:string[]}]
timeline: [{summary:string, chapterIds:string[], sourceEventIds:string[]}]
flashbacks: [{summary:string, startChapterId:string, endChapterId:string, sourceEventIds:string[]}]
plotThreads: [{kind:"foreshadowing"|"suspense"|"revelation", setup:string, revealCondition:string|null, resolution:string|null, chapterIds:string[], sourceEventIds:string[]}]
confusingFacts: [{statement:string, clarification:string, sourceEventIds:string[]}]
spoilerRestrictions: [{information:string, forbiddenUntil:string, sourceEventIds:string[]}]
properNouns: [{term:string, pronunciation:string, aliases:string[], sourceEventIds:string[]}]
所有 string 必须是非空字符串；aliases、identities、motivations、stateChanges 和各顶层数组可为空，chapterIds 与每条事实的 sourceEventIds 不得为空；chapterIds 只能使用允许的 chapterIds；全部对象只允许列出的字段；全书至少输出一条事实。`;

function parseModelContent(
  value: unknown,
  allowedSourceEventIds: readonly string[],
  allowedChapterIds: readonly string[],
) {
  const content = parseBookStoryBibleContent(value, new Set(allowedSourceEventIds));
  const allowed = new Set(allowedChapterIds);
  const referenced = [
    ...content.characters.flatMap((character) => character.stateChanges.flatMap((change) => change.chapterIds)),
    ...content.relationships.flatMap((relationship) => relationship.chapterIds),
    ...content.timeline.flatMap((event) => event.chapterIds),
    ...content.flashbacks.flatMap((flashback) => [flashback.startChapterId, flashback.endChapterId]),
    ...content.plotThreads.flatMap((thread) => thread.chapterIds),
  ];
  const unknown = referenced.find((chapterId) => !allowed.has(chapterId));
  if (unknown) throw new BookStoryBibleContractError(`故事圣经引用了未获准章节：${unknown}`);
}

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
    `SELECT id, chapter_id, event_type, payload_json
     FROM chapter_events WHERE id IN (${request.sourceEventIds.map(() => "?").join(",")})`,
  ).all(...request.sourceEventIds) as unknown as Array<{
    id: string; chapter_id: string; event_type: string; payload_json: string;
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
    return { id, chapterId: event.chapter_id, eventType: event.event_type, payload };
  });
}

async function callModel(
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch,
  input: unknown,
  signal: AbortSignal,
  onActivity: () => void,
  correctionError?: string,
) {
  const request = textModelRequest(config, correctionError
    ? `你是书籍故事圣经汇总器。上一次输出被严格合同拒绝，请只纠正一次并重新输出完整 JSON。\n错误：${correctionError}\n精确输出 schema：\n${OUTPUT_SCHEMA}\ninterval 的 sourceEvents[].id 与 chapterIds 分别是唯一允许的 sourceEventIds 与 chapterIds；final 的 chapterIds 是唯一允许的 chapterIds，且只能使用 intervals[].content 中已有的 sourceEventIds。\n原任务：${canonical(input)}`
    : `你是书籍故事圣经汇总器。interval 与 final 使用完全相同的输出 schema，只输出 JSON。interval 的 sourceEvents[].id 与 chapterIds 分别是唯一允许的 sourceEventIds 与 chapterIds；final 的 chapterIds 是唯一允许的 chapterIds，且只能使用 intervals[].content 中已有的 sourceEventIds。\n精确输出 schema：\n${OUTPUT_SCHEMA}\n原任务：${canonical(input)}`, 8192, true);
  const response = await fetchImpl(request.endpoint, {
    method: "POST", headers: request.headers, body: request.body, signal, redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`故事圣经模型请求失败（HTTP ${response.status}）`);
  }
  const text = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    ? await streamedText(response, config.protocol ?? "openai-response", { signal, onActivity })
    : responseText(await limitedJson(response));
  try {
    return JSON.parse(text) as unknown;
  } catch { throw new Error("故事圣经模型返回了无效 JSON"); }
}

async function callModelAndParse<T>(
  context: Parameters<JobHandler>[0],
  config: ChapterTextModelConfig,
  fetchImpl: typeof fetch,
  input: unknown,
  allowedSourceEventIds: readonly string[],
  allowedChapterIds: readonly string[],
  parse: (value: unknown) => T,
) {
  const raw = await withCancellation(context,
    (signal, onActivity) => callModel(config, fetchImpl, input, signal, onActivity));
  try {
    parseModelContent(raw, allowedSourceEventIds, allowedChapterIds);
  } catch (error) {
    if (!(error instanceof BookStoryBibleContractError)) throw error;
    const corrected = await withCancellation(context,
      (signal, onActivity) => callModel(config, fetchImpl, input, signal, onActivity, error.message));
    parseModelContent(corrected, allowedSourceEventIds, allowedChapterIds);
    return parse(corrected);
  }
  return parse(raw);
}

async function withCancellation<T>(
  context: Parameters<JobHandler>[0],
  call: (signal: AbortSignal, onActivity: () => void) => Promise<T>,
) {
  context.throwIfCancellationRequested();
  const controller = new AbortController();
  const idleController = new AbortController();
  const totalController = new AbortController();
  const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
  let idle = setTimeout(() => idleController.abort(new DOMException("idle timeout", "TimeoutError")), BOOK_STORY_BIBLE_TIMEOUT_MS);
  const total = setTimeout(() => totalController.abort(new DOMException("total timeout", "TimeoutError")),
    BOOK_STORY_BIBLE_TOTAL_TIMEOUT_MS);
  const onActivity = () => {
    clearTimeout(idle);
    idle = setTimeout(() => idleController.abort(new DOMException("idle timeout", "TimeoutError")), BOOK_STORY_BIBLE_IDLE_TIMEOUT_MS);
  };
  try {
    return await call(AbortSignal.any([
      controller.signal,
      idleController.signal,
      totalController.signal,
    ]), onActivity);
  } catch (error) {
    if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("故事圣经模型请求超时");
    throw error;
  } finally { clearInterval(poll); clearTimeout(idle); clearTimeout(total); }
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
      const input = {
        kind: "interval", chapterIds: request.chapterIds, sourceEvents: sourceEvents(database, request),
      };
      const parsed = await callModelAndParse(context, config, fetchImpl, input, request.sourceEventIds, request.chapterIds,
        (raw) => parseStoryBibleIntervalResponse(request, raw));
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
    const chapterIds = task.intervals.flatMap((interval) => interval.chapterIds);
    const input = {
      kind: "final", chapterIds, intervals: finalRequest.intervals.map(({ content }) => ({ content })),
    };
    const final = await callModelAndParse(context, config, fetchImpl, input, finalRequest.sourceEventIds,
      chapterIds,
      (raw) => parseStoryBibleFinalResponse(finalRequest, raw));
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
