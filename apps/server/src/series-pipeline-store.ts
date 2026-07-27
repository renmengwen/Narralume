import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { EPISODE_DURATION_POLICY } from "./episode-policy.js";
import { getJob, requestJobCancellation, type JobRecord } from "./job-store.js";

export type SeriesPipelineStatus =
  | "configured" | "analyzing_chapters" | "building_story_bible" | "planning_episodes"
  | "validating_plan" | "freezing_plan" | "generating_scripts" | "checking_coverage"
  | "awaiting_review" | "paused" | "failed" | "cancelled" | "completed";

interface RunRow {
  id: string; series_project_id: string; status: SeriesPipelineStatus; resume_status: SeriesPipelineStatus | null;
  episode_count: number; target_duration_seconds: number; source_start_chapter_id: string;
  source_end_chapter_id: string; config_hash: string; chapter_events_hash: string | null;
  story_bible_id: string | null; plan_hash: string | null; failure_code: string | null;
  failure_message: string | null; created_at: number; updated_at: number;
}

export interface SeriesPipelineRun {
  id: string; seriesProjectId: string; status: SeriesPipelineStatus; resumeStatus: SeriesPipelineStatus | null;
  episodeCount: number; targetDurationSeconds: number; sourceStartChapterId: string;
  sourceEndChapterId: string; configHash: string; chapterEventsHash: string | null;
  storyBibleId: string | null; planHash: string | null; failureCode: string | null;
  failureMessage: string | null; createdAt: number; updatedAt: number;
}

export interface CreateSeriesPipelineRunInput {
  seriesProjectId: string; episodeCount: number; targetDurationSeconds: number;
  sourceStartChapterId: string; sourceEndChapterId: string;
}

export interface PipelineChapter {
  id: string; index: number; contentHash: string; hasEvents: boolean;
}

export class SeriesPipelineError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function runRecord(row: RunRow): SeriesPipelineRun {
  return {
    id: row.id, seriesProjectId: row.series_project_id, status: row.status, resumeStatus: row.resume_status,
    episodeCount: row.episode_count, targetDurationSeconds: row.target_duration_seconds,
    sourceStartChapterId: row.source_start_chapter_id, sourceEndChapterId: row.source_end_chapter_id,
    configHash: row.config_hash, chapterEventsHash: row.chapter_events_hash, storyBibleId: row.story_bible_id,
    planHash: row.plan_hash, failureCode: row.failure_code, failureMessage: row.failure_message,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function runRow(database: DatabaseSync, id: string) {
  return database.prepare("SELECT * FROM series_pipeline_runs WHERE id = ?").get(id) as RunRow | undefined;
}

export function getSeriesPipelineRun(database: DatabaseSync, id: string) {
  const row = runRow(database, id);
  return row ? runRecord(row) : undefined;
}

export function getCurrentSeriesPipelineRun(database: DatabaseSync, seriesProjectId: string) {
  const row = database.prepare(
    `SELECT * FROM series_pipeline_runs
     WHERE series_project_id = ? AND status NOT IN ('cancelled', 'completed')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(seriesProjectId) as RunRow | undefined;
  return row ? runRecord(row) : undefined;
}

function safeId(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new SeriesPipelineError(400, `${label}无效`);
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SeriesPipelineError(400, `${label}必须是 ${minimum}～${maximum} 之间的整数`);
  }
  return value;
}

function rangeRows(database: DatabaseSync, seriesProjectId: string, startId: string, endId: string) {
  const project = database.prepare("SELECT book_id FROM series_projects WHERE id = ?")
    .get(seriesProjectId) as { book_id: string } | undefined;
  if (!project) throw new SeriesPipelineError(404, "系列项目不存在");
  const bounds = database.prepare(
    `SELECT id, chapter_index FROM chapters WHERE book_id = ? AND id IN (?, ?) ORDER BY chapter_index`,
  ).all(project.book_id, startId, endId) as Array<{ id: string; chapter_index: number }>;
  if (bounds.length !== (startId === endId ? 1 : 2) || bounds[0]?.id !== startId || bounds.at(-1)?.id !== endId) {
    throw new SeriesPipelineError(400, "起止章节必须属于系列原著且顺序正确");
  }
  const rows = database.prepare(
    `SELECT id, chapter_index, content_hash,
            EXISTS(SELECT 1 FROM chapter_events event WHERE event.chapter_id = chapters.id) AS has_events
     FROM chapters WHERE book_id = ? AND chapter_index BETWEEN ? AND ? ORDER BY chapter_index`,
  ).all(project.book_id, bounds[0]!.chapter_index, bounds.at(-1)!.chapter_index) as Array<{
    id: string; chapter_index: number; content_hash: string; has_events: number;
  }>;
  if (!rows.length || rows.some((row, index) => index > 0 && row.chapter_index !== rows[index - 1]!.chapter_index + 1)) {
    throw new SeriesPipelineError(409, "改写范围内章节索引不连续");
  }
  return rows;
}

export function createSeriesPipelineRun(
  database: DatabaseSync,
  input: CreateSeriesPipelineRunInput,
  now = Date.now(),
) {
  const seriesProjectId = safeId(input.seriesProjectId, "系列 ID");
  const sourceStartChapterId = safeId(input.sourceStartChapterId, "起始章节 ID");
  const sourceEndChapterId = safeId(input.sourceEndChapterId, "结束章节 ID");
  const episodeCount = safeInteger(input.episodeCount, 1, 1000, "总集数");
  const targetDurationSeconds = safeInteger(
    input.targetDurationSeconds,
    EPISODE_DURATION_POLICY.minimumSeconds,
    EPISODE_DURATION_POLICY.maximumSeconds,
    "单集时长",
  );
  if ((targetDurationSeconds - EPISODE_DURATION_POLICY.minimumSeconds) % EPISODE_DURATION_POLICY.stepSeconds !== 0) {
    throw new SeriesPipelineError(400, `单集时长必须按 ${EPISODE_DURATION_POLICY.stepSeconds} 秒递增`);
  }
  rangeRows(database, seriesProjectId, sourceStartChapterId, sourceEndChapterId);
  const configHash = createHash("sha256").update(JSON.stringify({
    contract: "series-pipeline-v1", seriesProjectId, episodeCount, targetDurationSeconds,
    sourceStartChapterId, sourceEndChapterId,
  })).digest("hex");
  const id = `pipeline_${randomUUID()}`;
  try {
    database.prepare(
      `INSERT INTO series_pipeline_runs (
         id, series_project_id, status, episode_count, target_duration_seconds,
         source_start_chapter_id, source_end_chapter_id, config_hash, created_at, updated_at
       ) VALUES (?, ?, 'configured', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, seriesProjectId, episodeCount, targetDurationSeconds, sourceStartChapterId, sourceEndChapterId, configHash, now, now);
  } catch (error) {
    if (String(error).includes("series_pipeline_runs.series_project_id")) {
      throw new SeriesPipelineError(409, "该系列已有未结束的全本流水线");
    }
    throw error;
  }
  return getSeriesPipelineRun(database, id)!;
}

export function listPipelineChapters(database: DatabaseSync, run: SeriesPipelineRun): PipelineChapter[] {
  return rangeRows(database, run.seriesProjectId, run.sourceStartChapterId, run.sourceEndChapterId).map((row) => ({
    id: row.id, index: row.chapter_index, contentHash: row.content_hash, hasEvents: row.has_events === 1,
  }));
}

export function listRunnableSeriesPipelineRuns(database: DatabaseSync) {
  return (database.prepare(
    "SELECT * FROM series_pipeline_runs WHERE status IN ('configured', 'analyzing_chapters') ORDER BY created_at, id",
  ).all() as unknown as RunRow[]).map(runRecord);
}

export function setSeriesPipelineStatus(
  database: DatabaseSync,
  id: string,
  expected: SeriesPipelineStatus,
  status: SeriesPipelineStatus,
  now = Date.now(),
) {
  database.prepare(
    `UPDATE series_pipeline_runs SET status = ?, resume_status = NULL, failure_code = NULL,
       failure_message = NULL, updated_at = ? WHERE id = ? AND status = ?`,
  ).run(status, now, id, expected);
  return getSeriesPipelineRun(database, id);
}

export function mapSeriesPipelineJob(
  database: DatabaseSync,
  runId: string,
  chapterId: string,
  jobId: string,
  now = Date.now(),
) {
  immediateTransaction(database, () => {
    database.prepare(
      `INSERT INTO series_pipeline_jobs (run_id, stage, subject_type, subject_id, job_id, created_at)
       VALUES (?, 'chapter_analysis', 'chapter', ?, ?, ?)
       ON CONFLICT(run_id, stage, subject_type, subject_id) DO NOTHING`,
    ).run(runId, chapterId, jobId, now);
    database.prepare(
      `UPDATE jobs SET run_after = ?, updated_at = ?
       WHERE id = ? AND status = 'queued' AND run_after = ?
         AND EXISTS (
           SELECT 1 FROM series_pipeline_jobs mapping
           JOIN series_pipeline_runs run ON run.id = mapping.run_id
           WHERE mapping.job_id = jobs.id
             AND run.status NOT IN ('paused', 'cancelled', 'completed')
         )`,
    ).run(now, now, jobId, PAUSED_JOB_RUN_AFTER);
  });
}

export function getMappedChapterJobs(database: DatabaseSync, runId: string) {
  return database.prepare(
    `SELECT mapping.subject_id, mapping.job_id FROM series_pipeline_jobs mapping
     WHERE mapping.run_id = ? AND mapping.stage = 'chapter_analysis' ORDER BY mapping.created_at, mapping.subject_id`,
  ).all(runId) as unknown as Array<{ subject_id: string; job_id: string }>;
}

export function failEmptyChapterAnalysisJobs(database: DatabaseSync, runId: string, now = Date.now()) {
  database.prepare(
    `UPDATE jobs SET status = 'failed', progress = 0, error_code = 'chapter_events_empty',
       error_message = '章节分析未生成可持久事件', finished_at = ?, updated_at = ?
     WHERE status = 'succeeded' AND id IN (
       SELECT mapping.job_id FROM series_pipeline_jobs mapping
       WHERE mapping.run_id = ? AND mapping.stage = 'chapter_analysis'
         AND NOT EXISTS (SELECT 1 FROM chapter_events event WHERE event.chapter_id = mapping.subject_id)
     )`,
  ).run(now, now, runId);
}

export function finishChapterAnalysis(database: DatabaseSync, run: SeriesPipelineRun, now = Date.now()) {
  const chapters = listPipelineChapters(database, run);
  const eventRows = database.prepare(
    `SELECT event.id, event.chapter_id, event.event_index, event.event_type, event.payload_json,
            source.source_index, source.source_byte_start, source.source_byte_end, source.source_hash
     FROM chapter_events event
     LEFT JOIN chapter_event_sources source ON source.event_id = event.id
     WHERE event.chapter_id IN (${chapters.map(() => "?").join(",")})
     ORDER BY event.chapter_id, event.event_index, source.source_index`,
  ).all(...chapters.map((chapter) => chapter.id));
  const hash = createHash("sha256").update(JSON.stringify({
    contract: "chapter-events-collection-v1",
    chapters: chapters.map(({ id, index, contentHash }) => ({ id, index, contentHash })), events: eventRows,
  })).digest("hex");
  database.prepare(
    `UPDATE series_pipeline_runs SET status = 'building_story_bible', chapter_events_hash = ?,
       failure_code = NULL, failure_message = NULL, updated_at = ?
     WHERE id = ? AND status = 'analyzing_chapters'`,
  ).run(hash, now, run.id);
  return getSeriesPipelineRun(database, run.id)!;
}

export function setSeriesPipelineFailure(database: DatabaseSync, id: string, code: string, message: string, now = Date.now()) {
  const safeCode = code.replace(/[^a-z0-9_-]/gi, "_").slice(0, 128) || "pipeline_failed";
  const safeMessage = message.replace(/[\r\n\t]+/g, " ").slice(0, 2000) || "流水线执行失败";
  database.prepare(
    "UPDATE series_pipeline_runs SET failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?",
  ).run(safeCode, safeMessage, now, id);
}

const PAUSED_JOB_RUN_AFTER = Number.MAX_SAFE_INTEGER;

function immediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始事务错误。 */ }
    throw error;
  }
}

function mappedJobs(database: DatabaseSync, runId: string) {
  return database.prepare(
    `SELECT DISTINCT job.id, job.status, job.run_after FROM jobs job
     JOIN series_pipeline_jobs mapping ON mapping.job_id = job.id
     WHERE mapping.run_id = ? AND mapping.stage = 'chapter_analysis' ORDER BY job.id`,
  ).all(runId) as unknown as Array<{ id: string; status: JobRecord["status"]; run_after: number }>;
}

function hasOtherActiveOwner(database: DatabaseSync, jobId: string, runId: string) {
  return Boolean(database.prepare(
    `SELECT 1 FROM series_pipeline_jobs mapping
     JOIN series_pipeline_runs run ON run.id = mapping.run_id
     WHERE mapping.job_id = ? AND mapping.run_id <> ?
       AND run.status NOT IN ('paused', 'cancelled', 'completed') LIMIT 1`,
  ).get(jobId, runId));
}

export function pauseSeriesPipelineRun(database: DatabaseSync, id: string, now = Date.now()) {
  return immediateTransaction(database, () => {
    const run = getSeriesPipelineRun(database, id);
    if (!run) throw new SeriesPipelineError(404, "全本流水线不存在");
    if (run.status === "paused") return run;
    if (run.status === "cancelled" || run.status === "completed") {
      throw new SeriesPipelineError(409, "已结束的流水线不能暂停");
    }
    database.prepare(
      "UPDATE series_pipeline_runs SET status = 'paused', resume_status = ?, updated_at = ? WHERE id = ?",
    ).run(run.status, now, id);
    for (const job of mappedJobs(database, id)) {
      if (job.status === "queued" && !hasOtherActiveOwner(database, job.id, id)) {
        database.prepare("UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
          .run(PAUSED_JOB_RUN_AFTER, now, job.id);
      }
    }
    return getSeriesPipelineRun(database, id)!;
  });
}

export function resumeSeriesPipelineRun(database: DatabaseSync, id: string, now = Date.now()) {
  const run = getSeriesPipelineRun(database, id);
  if (!run) throw new SeriesPipelineError(404, "全本流水线不存在");
  if (run.status !== "paused") return run;
  database.prepare(
    "UPDATE series_pipeline_runs SET status = resume_status, resume_status = NULL, updated_at = ? WHERE id = ? AND status = 'paused'",
  ).run(now, id);
  database.prepare(
    `UPDATE jobs SET run_after = ?, updated_at = ?
     WHERE status = 'queued' AND run_after = ? AND id IN (
       SELECT job_id FROM series_pipeline_jobs WHERE run_id = ? AND stage = 'chapter_analysis'
     )`,
  ).run(now, now, PAUSED_JOB_RUN_AFTER, id);
  return getSeriesPipelineRun(database, id)!;
}

export function cancelSeriesPipelineRun(database: DatabaseSync, id: string, now = Date.now()) {
  return immediateTransaction(database, () => {
    const run = getSeriesPipelineRun(database, id);
    if (!run) throw new SeriesPipelineError(404, "全本流水线不存在");
    if (run.status === "cancelled" || run.status === "completed") return run;
    database.prepare(
      `UPDATE series_pipeline_runs SET status = 'cancelled', resume_status = NULL,
         failure_code = NULL, failure_message = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, id);
    for (const job of mappedJobs(database, id)) {
      if ((job.status === "queued" || job.status === "running") && !hasOtherActiveOwner(database, job.id, id)) {
        requestJobCancellation(database, job.id, now);
      }
    }
    return getSeriesPipelineRun(database, id)!;
  });
}

export function retrySeriesPipelineRun(database: DatabaseSync, id: string, now = Date.now()) {
  return immediateTransaction(database, () => {
    const run = getSeriesPipelineRun(database, id);
    if (!run) throw new SeriesPipelineError(404, "全本流水线不存在");
    if (run.status === "completed") return run;
    for (const job of mappedJobs(database, id)) {
      if (job.status !== "failed" && job.status !== "cancelled") continue;
      const runAfter = run.status === "paused" && !hasOtherActiveOwner(database, job.id, id)
        ? PAUSED_JOB_RUN_AFTER
        : now;
      database.prepare(
        `UPDATE jobs SET status = 'queued', progress = 0, attempts = 0, run_after = ?, cancel_requested = 0,
           lease_owner = NULL, lease_expires_at = NULL, result_json = NULL, error_code = NULL, error_message = NULL,
           started_at = NULL, finished_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed', 'cancelled')`,
      ).run(runAfter, now, job.id);
    }
    database.prepare(
      `UPDATE series_pipeline_runs SET status = CASE WHEN status = 'cancelled' THEN 'analyzing_chapters' ELSE status END,
         resume_status = CASE WHEN status = 'cancelled' THEN NULL ELSE resume_status END,
         failure_code = NULL, failure_message = NULL, updated_at = ? WHERE id = ?`,
    ).run(now, id);
    return getSeriesPipelineRun(database, id)!;
  });
}

export function seriesPipelineView(database: DatabaseSync, run: SeriesPipelineRun) {
  const chapters = listPipelineChapters(database, run);
  const jobs = getMappedChapterJobs(database, run.id).map((mapping) => ({
    chapterId: mapping.subject_id, job: getJob(database, mapping.job_id),
  })).filter((item): item is { chapterId: string; job: JobRecord } => Boolean(item.job));
  const mapped = new Set(jobs.map((item) => item.chapterId));
  const completed = chapters.filter((chapter) => chapter.hasEvents).length;
  const completedChapterIds = new Set(chapters.filter((chapter) => chapter.hasEvents).map((chapter) => chapter.id));
  const relevantJobs = jobs.filter((item) => !completedChapterIds.has(item.chapterId));
  const failures = relevantJobs.filter((item) => item.job.status === "failed" || item.job.status === "cancelled").map((item) => ({
    stage: "chapter_analysis", subjectType: "chapter", subjectId: item.chapterId,
    jobId: item.job.id,
    code: item.job.status === "cancelled" ? "job_cancelled" : item.job.errorCode,
    message: item.job.status === "cancelled" ? "章节分析已中断，请重试该章节" : "章节分析失败，请重试该章节",
    canRetry: true,
  }));
  const current = relevantJobs.find((item) => item.job.status === "running" || item.job.status === "queued");
  return {
    ...run,
    progress: {
      chapterAnalysis: {
        completed, total: chapters.length,
        reused: chapters.filter((chapter) => chapter.hasEvents && !mapped.has(chapter.id)).length,
        queued: relevantJobs.filter((item) => item.job.status === "queued").length,
        running: relevantJobs.filter((item) => item.job.status === "running").length,
        failed: failures.length,
      },
      storyBible: { completed: 0, total: 1 },
      episodePlan: { completed: 0, total: run.episodeCount },
      scripts: { completed: 0, total: run.episodeCount * 2 },
    },
    current: current ? { stage: "chapter_analysis", subjectType: "chapter", subjectId: current.chapterId, jobId: current.job.id } : null,
    failures,
    actions: {
      canPause: !["paused", "cancelled", "completed"].includes(run.status),
      canResume: run.status === "paused",
      canCancel: !["cancelled", "completed"].includes(run.status),
      canRetry: failures.length > 0,
    },
  };
}

export function assertSeriesPipelineAllowsChapterEventMutation(
  database: DatabaseSync,
  bookId: string,
  chapterId: string,
  options: { allowPausedPipelineJobs?: boolean } = {},
) {
  const conflict = database.prepare(
    `SELECT run.id FROM series_pipeline_runs run
     JOIN series_projects series ON series.id = run.series_project_id
     JOIN chapters target ON target.id = ? AND target.book_id = series.book_id
     JOIN chapters start ON start.id = run.source_start_chapter_id
     JOIN chapters finish ON finish.id = run.source_end_chapter_id
     WHERE series.book_id = ? AND target.chapter_index BETWEEN start.chapter_index AND finish.chapter_index
       AND (
         run.status NOT IN ('paused', 'cancelled', 'completed')
         OR (? = 0 AND run.status IN ('paused', 'cancelled') AND EXISTS (
           SELECT 1 FROM series_pipeline_jobs mapping
           JOIN jobs job ON job.id = mapping.job_id
           WHERE mapping.run_id = run.id AND mapping.stage = 'chapter_analysis'
             AND mapping.subject_id = target.id AND job.status IN ('queued', 'running')
         ))
       ) LIMIT 1`,
  ).get(chapterId, bookId, options.allowPausedPipelineJobs ? 1 : 0);
  if (conflict) throw new SeriesPipelineError(409, "全本流水线运行期间章节事件只读，请先暂停流水线");
}
