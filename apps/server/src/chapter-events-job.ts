import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  prepareChapterEvents,
  queueChapterEventReplacement,
  type ChapterEventInput,
  type PreparedChapterEvent,
} from "./chapter-event-store.js";
import {
  buildChapterEvidenceAtoms,
  type AnalyzeChapterEvents,
  type ChapterTextModelConfig,
} from "./chapter-event-analyzer.js";
import { createJob, getJob, type CreateJobInput, type JobRecord } from "./job-store.js";
import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";

export const CHAPTER_EVENTS_JOB_TYPE = "chapter_events_replace";
export const CHAPTER_EVENTS_ANALYZE_JOB_TYPE = "chapter_events_analyze";

export interface ChapterEventsJobHooks {
  beforeCommit?(chapterId: string, completedChapters: number): void;
  afterCheckpoint?(chapterId: string, completedChapters: number): void;
}

interface ChapterTask {
  chapterId: string;
  events: readonly ChapterEventInput[];
}

function payload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("章节事件任务参数无效");
  const input = value as { bookId?: unknown; chapters?: unknown };
  if (typeof input.bookId !== "string" || !input.bookId.trim()) throw new Error("章节事件任务缺少书籍 ID");
  if (!Array.isArray(input.chapters) || input.chapters.length < 1 || input.chapters.length > 3) {
    throw new Error("章节事件任务必须包含 1～3 个章节");
  }
  const seen = new Set<string>();
  const chapters = input.chapters.map((value): ChapterTask => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("章节事件任务章节参数无效");
    const chapter = value as { chapterId?: unknown; events?: unknown };
    if (typeof chapter.chapterId !== "string" || !chapter.chapterId.trim()) throw new Error("章节事件任务缺少章节 ID");
    if (seen.has(chapter.chapterId)) throw new Error("章节事件任务不能重复包含同一章节");
    if (!Array.isArray(chapter.events)) throw new Error("章节事件任务缺少事件列表");
    seen.add(chapter.chapterId);
    return { chapterId: chapter.chapterId, events: chapter.events as ChapterEventInput[] };
  });
  return { bookId: input.bookId, chapters };
}

function inputHash(events: readonly PreparedChapterEvent[]) {
  const canonical = events.map((event) => ({
    id: event.id,
    type: event.type,
    occurrence: event.occurrence,
    payload: event.payload,
    sources: event.sources.map((source) => ({
      byteStart: source.byteStart,
      byteEnd: source.byteEnd,
      sourceHash: source.sourceHash,
    })),
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const CHAPTER_ANALYSIS_CONTRACT_VERSION = "chapter-events-analysis-v1";
const CHAPTER_ANALYSIS_PROMPT_VERSION = "chapter-events-prompt-v2";
const CHAPTER_ANALYSIS_PARSER_VERSION = "chapter-events-parser-v1";
export const CHAPTER_ANALYSIS_TIMEOUT_MS = 180_000;

interface AnalyzeReuseIdentity {
  bookId: string;
  chapterId: string;
  contentHash: string;
  analysisContractVersion: string;
  promptContractVersion: string;
  parserContractVersion: string;
}

interface AnalyzeJobPayload extends AnalyzeReuseIdentity {
  providerId: string;
  model: string;
  requestHash: string;
}

function analyzePayload(value: unknown): AnalyzeJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("章节自动分析任务参数无效");
  const input = value as Record<string, unknown>;
  const result = {} as Record<keyof AnalyzeJobPayload, string>;
  for (const key of [
    "bookId", "chapterId", "contentHash", "analysisContractVersion", "promptContractVersion",
    "parserContractVersion", "providerId", "model", "requestHash",
  ] as const) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new Error("章节自动分析任务冻结身份无效");
    result[key] = input[key].trim();
  }
  if (!/^[0-9a-f]{64}$/.test(result.contentHash) || !/^[0-9a-f]{64}$/.test(result.requestHash)) {
    throw new Error("章节自动分析任务冻结身份无效");
  }
  return result;
}

function analysisRequestHash(input: AnalyzeReuseIdentity) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function reuseIdentity(input: AnalyzeJobPayload): AnalyzeReuseIdentity {
  return {
    bookId: input.bookId,
    chapterId: input.chapterId,
    contentHash: input.contentHash,
    analysisContractVersion: input.analysisContractVersion,
    promptContractVersion: input.promptContractVersion,
    parserContractVersion: input.parserContractVersion,
  };
}

function hasSameReuseIdentity(job: JobRecord, expected: AnalyzeReuseIdentity) {
  if (job.type !== CHAPTER_EVENTS_ANALYZE_JOB_TYPE) return false;
  try {
    const existing = analyzePayload(job.payload);
    return JSON.stringify(reuseIdentity(existing)) === JSON.stringify(expected) &&
      existing.requestHash === analysisRequestHash(expected);
  } catch {
    return false;
  }
}

export async function enqueueChapterEventsAnalysisJob(
  database: DatabaseSync,
  dataRoot: string,
  config: ChapterTextModelConfig,
  input: Omit<CreateJobInput, "id" | "type">,
  canCreate: () => boolean = () => true,
): Promise<{ job: JobRecord; created: boolean }> {
  const request = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? input.payload as { bookId?: unknown; chapterId?: unknown }
    : {};
  if (typeof request.bookId !== "string" || !request.bookId.trim() ||
      typeof request.chapterId !== "string" || !request.chapterId.trim()) {
    throw new Error("章节自动分析任务缺少有效的书籍或章节 ID");
  }
  const { contentHash } = await buildChapterEvidenceAtoms(
    database, dataRoot, request.bookId.trim(), request.chapterId.trim(),
  );
  const identity = {
    bookId: request.bookId.trim(),
    chapterId: request.chapterId.trim(),
    contentHash,
    analysisContractVersion: CHAPTER_ANALYSIS_CONTRACT_VERSION,
    promptContractVersion: CHAPTER_ANALYSIS_PROMPT_VERSION,
    parserContractVersion: CHAPTER_ANALYSIS_PARSER_VERSION,
  };
  const providerId = config.providerId.trim();
  const model = config.model.trim();
  if (!providerId || !model) throw new Error("章节分析模型配置无效");
  const requestHash = analysisRequestHash(identity);
  const payload: AnalyzeJobPayload = { ...identity, providerId, model, requestHash };
  const id = `job_chapter_analyze_${requestHash}`;
  if (!canCreate()) throw new Error("章节分析派发已停止");
  const existing = getJob(database, id);
  if (existing) {
    if (!hasSameReuseIdentity(existing, identity)) {
      throw new Error("章节自动分析任务身份冲突");
    }
    return { job: existing, created: false };
  }
  try {
    return {
      job: createJob(database, { ...input, id, type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE, payload }),
      created: true,
    };
  } catch (error) {
    const raced = getJob(database, id);
    if (!raced || !hasSameReuseIdentity(raced, identity)) throw error;
    return { job: raced, created: false };
  }
}

export function createChapterEventsJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  hooks: ChapterEventsJobHooks = {},
): JobHandler {
  return async (context: JobExecutionContext) => {
    const task = payload(context.job.payload);
    let processed = 0;
    let reused = 0;
    for (const chapter of task.chapters) {
      context.throwIfCancellationRequested();
      const prepared = await prepareChapterEvents(
        database,
        dataRoot,
        task.bookId,
        chapter.chapterId,
        chapter.events,
      );
      context.throwIfCancellationRequested();
      hooks.beforeCommit?.(chapter.chapterId, processed + reused);
      context.throwIfCancellationRequested();
      const result = context.commitCheckpoint(
        "chapter-events",
        chapter.chapterId,
        inputHash(prepared),
        (transaction) => {
          queueChapterEventReplacement(transaction, chapter.chapterId, prepared);
          return undefined;
        },
      );
      if (result.created || result.replaced) processed += 1;
      else reused += 1;
      context.reportProgress((processed + reused) / task.chapters.length);
      hooks.afterCheckpoint?.(chapter.chapterId, processed + reused);
    }
    return { processed, reused, chapters: task.chapters.length };
  };
}

export function createChapterEventsAnalysisJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  config: ChapterTextModelConfig,
  analyze: AnalyzeChapterEvents,
): JobHandler {
  return async (context) => {
    const task = analyzePayload(context.job.payload);
    if (context.job.id !== `job_chapter_analyze_${task.requestHash}` ||
        task.requestHash !== analysisRequestHash(reuseIdentity(task)) ||
        task.providerId !== config.providerId.trim() || task.model !== config.model.trim()) {
      throw new Error("章节自动分析任务冻结身份不一致");
    }
    context.throwIfCancellationRequested();
    const source = await buildChapterEvidenceAtoms(database, dataRoot, task.bookId, task.chapterId);
    if (source.contentHash !== task.contentHash) throw new Error("章节原文在任务排队后已变化");
    const controller = new AbortController();
    const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
    let inputs: readonly ChapterEventInput[];
    try {
      inputs = await analyze({
        chapterId: task.chapterId,
        atoms: source.atoms,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(CHAPTER_ANALYSIS_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
      if (error instanceof Error && error.name === "TimeoutError") throw new Error("章节分析模型请求超时");
      throw error;
    } finally {
      clearInterval(poll);
    }
    context.throwIfCancellationRequested();
    if (inputs.length === 0) {
      const existing = database.prepare("SELECT 1 FROM chapter_events WHERE chapter_id = ? LIMIT 1").get(task.chapterId);
      if (!existing) throw new Error("章节分析未生成可持久事件");
      return { analyzed: 0, preserved: true };
    }
    const prepared = await prepareChapterEvents(database, dataRoot, task.bookId, task.chapterId, inputs);
    context.throwIfCancellationRequested();
    const result = context.commitCheckpoint("chapter-events-analyze", task.chapterId, inputHash(prepared), (transaction) => {
      queueChapterEventReplacement(transaction, task.chapterId, prepared);
      return undefined;
    });
    context.reportProgress(1);
    return { analyzed: prepared.length, preserved: false, reused: !result.created && !result.replaced };
  };
}
