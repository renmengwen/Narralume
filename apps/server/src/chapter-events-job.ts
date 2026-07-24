import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  prepareChapterEvents,
  queueChapterEventReplacement,
  type ChapterEventInput,
  type PreparedChapterEvent,
} from "./chapter-event-store.js";
import type { JobExecutionContext, JobHandler } from "./job-worker.js";

export const CHAPTER_EVENTS_JOB_TYPE = "chapter_events_replace";

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
