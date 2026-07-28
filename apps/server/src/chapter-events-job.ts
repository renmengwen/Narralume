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
  type AnalyzeChapterEventsBatch,
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

export interface ChapterEventsAnalysisIdentity {
  bookId: string;
  chapterId: string;
  contentHash: string;
  analysisContractVersion: string;
  promptContractVersion: string;
  parserContractVersion: string;
}

interface AnalyzeJobPayload extends ChapterEventsAnalysisIdentity {
  providerId: string;
  model: string;
  requestHash: string;
}

export interface ChapterEventsBatchAnalysisIdentity {
  bookId: string;
  chapters: readonly { chapterId: string; contentHash: string }[];
  analysisContractVersion: string;
  promptContractVersion: string;
  parserContractVersion: string;
}

interface AnalyzeBatchJobPayload extends ChapterEventsBatchAnalysisIdentity {
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

function analysisRequestHash(input: ChapterEventsAnalysisIdentity) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function batchAnalysisRequestHash(input: ChapterEventsBatchAnalysisIdentity) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function analyzeBatchPayload(value: unknown): AnalyzeBatchJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("多章自动分析任务参数无效");
  const input = value as Record<string, unknown>;
  for (const key of ["bookId", "analysisContractVersion", "promptContractVersion", "parserContractVersion", "providerId", "model", "requestHash"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new Error("多章自动分析任务冻结身份无效");
  }
  if (!/^[0-9a-f]{64}$/.test(input.requestHash as string) || !Array.isArray(input.chapters) ||
      input.chapters.length < 1 || input.chapters.length > 20) {
    throw new Error("多章自动分析任务冻结身份无效");
  }
  const seen = new Set<string>();
  const chapters = input.chapters.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("多章自动分析任务章节身份无效");
    const chapter = raw as { chapterId?: unknown; contentHash?: unknown };
    if (typeof chapter.chapterId !== "string" || !chapter.chapterId.trim() || seen.has(chapter.chapterId) ||
        typeof chapter.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(chapter.contentHash)) {
      throw new Error("多章自动分析任务章节身份无效");
    }
    seen.add(chapter.chapterId);
    return { chapterId: chapter.chapterId, contentHash: chapter.contentHash };
  });
  return {
    bookId: input.bookId as string,
    chapters,
    analysisContractVersion: input.analysisContractVersion as string,
    promptContractVersion: input.promptContractVersion as string,
    parserContractVersion: input.parserContractVersion as string,
    providerId: input.providerId as string,
    model: input.model as string,
    requestHash: input.requestHash as string,
  };
}

function batchReuseIdentity(input: AnalyzeBatchJobPayload): ChapterEventsBatchAnalysisIdentity {
  return {
    bookId: input.bookId,
    chapters: input.chapters,
    analysisContractVersion: input.analysisContractVersion,
    promptContractVersion: input.promptContractVersion,
    parserContractVersion: input.parserContractVersion,
  };
}

function reuseIdentity(input: AnalyzeJobPayload): ChapterEventsAnalysisIdentity {
  return {
    bookId: input.bookId,
    chapterId: input.chapterId,
    contentHash: input.contentHash,
    analysisContractVersion: input.analysisContractVersion,
    promptContractVersion: input.promptContractVersion,
    parserContractVersion: input.parserContractVersion,
  };
}

function hasSameReuseIdentity(job: JobRecord, expected: ChapterEventsAnalysisIdentity) {
  if (job.type !== CHAPTER_EVENTS_ANALYZE_JOB_TYPE) return false;
  try {
    const existing = analyzePayload(job.payload);
    return JSON.stringify(reuseIdentity(existing)) === JSON.stringify(expected) &&
      existing.requestHash === analysisRequestHash(expected);
  } catch {
    return false;
  }
}

export function chapterEventsAnalysisJobIdentity(
  bookId: string,
  chapterId: string,
  contentHash: string,
) {
  const identity: ChapterEventsAnalysisIdentity = {
    bookId,
    chapterId,
    contentHash,
    analysisContractVersion: CHAPTER_ANALYSIS_CONTRACT_VERSION,
    promptContractVersion: CHAPTER_ANALYSIS_PROMPT_VERSION,
    parserContractVersion: CHAPTER_ANALYSIS_PARSER_VERSION,
  };
  const requestHash = analysisRequestHash(identity);
  return { identity, requestHash, jobId: `job_chapter_analyze_${requestHash}` };
}

export function chapterEventsBatchAnalysisJobIdentity(
  bookId: string,
  chapters: readonly { chapterId: string; contentHash: string }[],
) {
  const identity: ChapterEventsBatchAnalysisIdentity = {
    bookId,
    chapters: chapters.map((chapter) => ({ chapterId: chapter.chapterId, contentHash: chapter.contentHash })),
    analysisContractVersion: "chapter-events-batch-analysis-v1",
    promptContractVersion: "chapter-events-batch-prompt-v1",
    parserContractVersion: "chapter-events-batch-parser-v1",
  };
  const requestHash = batchAnalysisRequestHash(identity);
  return { identity, requestHash, jobId: `job_chapter_batch_analyze_${requestHash}` };
}

export function chapterEventsAnalysisJobMatchesChapter(
  job: JobRecord | undefined,
  bookId: string,
  chapterId: string,
  contentHash: string,
) {
  if (!job || job.type !== CHAPTER_EVENTS_ANALYZE_JOB_TYPE) return false;
  try {
    const batch = analyzeBatchPayload(job.payload);
    return batch.bookId === bookId && batch.requestHash === batchAnalysisRequestHash(batchReuseIdentity(batch)) &&
      batch.chapters.some((chapter) => chapter.chapterId === chapterId && chapter.contentHash === contentHash);
  } catch {
    try { return hasSameReuseIdentity(job, chapterEventsAnalysisJobIdentity(bookId, chapterId, contentHash).identity); }
    catch { return false; }
  }
}

export function chapterEventsAnalysisJobMatchesChapters(
  job: JobRecord | undefined,
  bookId: string,
  chapters: readonly { chapterId: string; contentHash: string }[],
) {
  if (!job || job.type !== CHAPTER_EVENTS_ANALYZE_JOB_TYPE || !chapters.length) return false;
  try {
    const batch = analyzeBatchPayload(job.payload);
    if (batch.bookId !== bookId || batch.requestHash !== batchAnalysisRequestHash(batchReuseIdentity(batch)) ||
        batch.chapters.length !== chapters.length) return false;
    const current = new Map(chapters.map((chapter) => [chapter.chapterId, chapter.contentHash]));
    return batch.chapters.every((chapter) => current.get(chapter.chapterId) === chapter.contentHash);
  } catch {
    return chapters.length === 1 && chapterEventsAnalysisJobMatchesChapter(
      job, bookId, chapters[0]!.chapterId, chapters[0]!.contentHash,
    );
  }
}

export async function enqueueChapterEventsAnalysisBatchJob(
  database: DatabaseSync,
  config: ChapterTextModelConfig,
  input: Omit<CreateJobInput, "id" | "type" | "payload"> & {
    payload: { bookId: string; chapters: readonly { chapterId: string; contentHash: string }[] };
  },
  canCreate: () => boolean = () => true,
): Promise<{ job: JobRecord; created: boolean }> {
  const { identity, requestHash, jobId } = chapterEventsBatchAnalysisJobIdentity(
    input.payload.bookId,
    input.payload.chapters,
  );
  const providerId = config.providerId.trim();
  const model = config.model.trim();
  if (!providerId || !model) throw new Error("章节分析模型配置无效");
  const payload: AnalyzeBatchJobPayload = { ...identity, providerId, model, requestHash };
  if (!canCreate()) throw new Error("章节分析派发已停止");
  const existing = getJob(database, jobId);
  if (existing) {
    const parsed = analyzeBatchPayload(existing.payload);
    if (parsed.requestHash !== requestHash || JSON.stringify(batchReuseIdentity(parsed)) !== JSON.stringify(identity)) {
      throw new Error("多章自动分析任务身份冲突");
    }
    return { job: existing, created: false };
  }
  try {
    return { job: createJob(database, { ...input, id: jobId, type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE, payload }), created: true };
  } catch (error) {
    const raced = getJob(database, jobId);
    if (!raced || !chapterEventsAnalysisJobMatchesChapter(
      raced, identity.bookId, identity.chapters[0]!.chapterId, identity.chapters[0]!.contentHash,
    )) throw error;
    return { job: raced, created: false };
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
  const { identity, requestHash, jobId: id } = chapterEventsAnalysisJobIdentity(
    request.bookId.trim(), request.chapterId.trim(), contentHash,
  );
  const providerId = config.providerId.trim();
  const model = config.model.trim();
  if (!providerId || !model) throw new Error("章节分析模型配置无效");
  const payload: AnalyzeJobPayload = { ...identity, providerId, model, requestHash };
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
    if (context.job.payload && typeof context.job.payload === "object" && !Array.isArray(context.job.payload) &&
        Array.isArray((context.job.payload as { chapters?: unknown }).chapters)) {
      return createChapterEventsBatchAnalysisJobHandler(
        database,
        dataRoot,
        config,
        async ({ chapters, signal }) => Promise.all(chapters.map(async (chapter) => ({
          chapterId: chapter.chapterId,
          events: await analyze({ ...chapter, signal }),
        }))),
      )(context);
    }
    const task = analyzePayload(context.job.payload);
    if (context.job.id !== `job_chapter_analyze_${task.requestHash}` ||
        task.requestHash !== analysisRequestHash(reuseIdentity(task)) ||
        task.providerId !== config.providerId.trim() || task.model !== config.model.trim()) {
      throw new Error("章节自动分析任务冻结身份不一致");
    }
    context.throwIfCancellationRequested();
    const source = await buildChapterEvidenceAtoms(database, dataRoot, task.bookId, task.chapterId);
    if (source.contentHash !== task.contentHash) throw new Error("章节原文在任务排队后已变化");
    if (context.getCheckpoint("chapter-events-analyze", task.chapterId)) {
      context.reportProgress(1);
      return { analyzed: 0, preserved: false, reused: true };
    }
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

export function createChapterEventsBatchAnalysisJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  config: ChapterTextModelConfig,
  analyze: AnalyzeChapterEventsBatch,
): JobHandler {
  return async (context) => {
    const task = analyzeBatchPayload(context.job.payload);
    if (context.job.id !== `job_chapter_batch_analyze_${task.requestHash}` ||
        task.requestHash !== batchAnalysisRequestHash(batchReuseIdentity(task)) ||
        task.providerId !== config.providerId.trim() || task.model !== config.model.trim()) {
      throw new Error("多章自动分析任务冻结身份不一致");
    }
    context.throwIfCancellationRequested();
    const chapters = await Promise.all(task.chapters.map(async (chapter) => {
      const source = await buildChapterEvidenceAtoms(database, dataRoot, task.bookId, chapter.chapterId);
      if (source.contentHash !== chapter.contentHash) throw new Error("章节原文在任务排队后已变化");
      return { chapterId: chapter.chapterId, atoms: source.atoms };
    }));
    const pending = chapters.filter((chapter) =>
      !context.getCheckpoint("chapter-events-analyze", chapter.chapterId));
    let reused = chapters.length - pending.length;
    if (reused) context.reportProgress(reused / task.chapters.length);
    if (!pending.length) return { analyzed: 0, reused, preserved: 0, chapters: task.chapters.length };
    const controller = new AbortController();
    const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
    let outputs: readonly { chapterId: string; events: readonly ChapterEventInput[] }[];
    try {
      outputs = await analyze({
        chapters: pending,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(CHAPTER_ANALYSIS_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
      if (error instanceof Error && error.name === "TimeoutError") throw new Error("多章分析模型请求超时");
      throw error;
    } finally {
      clearInterval(poll);
    }
    context.throwIfCancellationRequested();
    const expected = new Set(pending.map((chapter) => chapter.chapterId));
    const seen = new Set<string>();
    if (!Array.isArray(outputs) || outputs.length !== expected.size) throw new Error("多章分析结果章节集合不完整");
    const prepared = await Promise.all(outputs.map(async (output) => {
      if (!output || typeof output.chapterId !== "string" || !expected.has(output.chapterId)) {
        throw new Error("多章分析结果包含未知章节");
      }
      if (seen.has(output.chapterId)) throw new Error("多章分析结果重复包含章节");
      seen.add(output.chapterId);
      if (!Array.isArray(output.events)) throw new Error("多章分析结果事件列表无效");
      if (output.events.length === 0) {
        const existing = database.prepare("SELECT 1 FROM chapter_events WHERE chapter_id = ? LIMIT 1").get(output.chapterId);
        if (!existing) throw new Error("多章分析未为每个章节生成可持久事件");
      }
      return {
        chapterId: output.chapterId,
        events: output.events.length
          ? await prepareChapterEvents(database, dataRoot, task.bookId, output.chapterId, output.events)
          : undefined,
      };
    }));
    if (seen.size !== expected.size) throw new Error("多章分析结果章节集合不完整");
    let analyzed = 0;
    let preserved = 0;
    for (const [index, chapter] of prepared.entries()) {
      context.throwIfCancellationRequested();
      if (!chapter.events) {
        preserved += 1;
      } else {
        const result = context.commitCheckpoint(
          "chapter-events-analyze",
          chapter.chapterId,
          inputHash(chapter.events),
          (transaction) => {
            queueChapterEventReplacement(transaction, chapter.chapterId, chapter.events!);
            return undefined;
          },
        );
        if (result.created || result.replaced) analyzed += 1;
        else reused += 1;
      }
      context.reportProgress((chapters.length - pending.length + index + 1) / task.chapters.length);
    }
    return { analyzed, reused, preserved, chapters: task.chapters.length };
  };
}
