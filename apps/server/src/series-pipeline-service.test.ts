import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { BOOK_STORY_BIBLE_JOB_TYPE, createBookStoryBibleJobHandler } from "./book-story-bible-job-handler.js";
import { createBookStoryBible } from "./book-story-bible-store.js";
import { createChapterEventsAnalysisJobHandler, CHAPTER_EVENTS_ANALYZE_JOB_TYPE } from "./chapter-events-job.js";
import { openDatabase } from "./database.js";
import {
  createEpisodeScriptGenerationJobHandler,
  EPISODE_SCRIPT_GENERATION_JOB_TYPE,
  type GenerateEpisodeScript,
} from "./episode-script-generation-job.js";
import { createJob, getJob } from "./job-store.js";
import { canonicalFullBookPlanJson } from "./full-book-plan-contract.js";
import { FULL_BOOK_PLAN_JOB_TYPE } from "./full-book-plan-job-handler.js";
import { JobWorker } from "./job-worker.js";
import { SeriesPipelineService } from "./series-pipeline-service.js";
import {
  assertSeriesPipelineAllowsChapterEventMutation,
  createSeriesPipelineRun,
  getMappedChapterJobs,
  getMappedEpisodePlanJob,
  getMappedScriptJobs,
  getMappedStoryBibleJob,
  getSeriesPipelineRun,
  mapSeriesPipelineJob,
  mapSeriesPipelineEpisodePlanJob,
  mapSeriesPipelineStoryBibleJob,
  pauseSeriesPipelineRun,
  resumeSeriesPipelineRun,
  cancelSeriesPipelineRun,
  retrySeriesPipelineRun,
  SeriesPipelineError,
  setSeriesPipelineStatus,
} from "./series-pipeline-store.js";

const provider: ChapterTextModelConfig = {
  baseUrl: "http://local.invalid", apiKey: "test", model: "test-model", providerId: "test-provider",
};

async function seed(dataRoot: string, suffix = "a", existing?: ReturnType<typeof openDatabase>) {
  const first = Buffer.from(`${suffix}甲在庭院出现。`, "utf8");
  const second = Buffer.from(`${suffix}乙在书房出现。`, "utf8");
  const source = Buffer.concat([first, second]);
  const relativePath = `books/book_${suffix}/source.txt`;
  const path = join(dataRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  const connection = existing ?? openDatabase(dataRoot);
  const database = connection.database;
  database.prepare(`INSERT INTO books
    (id,title,original_file_path,original_file_hash,encoding,import_status)
    VALUES (?,?,?,?,?,'ready')`).run(
    `book_${suffix}`, `书_${suffix}`, relativePath, createHash("sha256").update(source).digest("hex"), "UTF-8",
  );
  const insert = database.prepare(`INSERT INTO chapters
    (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES (?,?,?,?,?,?,?,?)`);
  insert.run(`chapter_${suffix}_1`, `book_${suffix}`, 0, "第一章", 0, first.length, 7,
    createHash("sha256").update(first).digest("hex"));
  insert.run(`chapter_${suffix}_2`, `book_${suffix}`, 1, "第二章", first.length, source.length, 7,
    createHash("sha256").update(second).digest("hex"));
  database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES (?,?,?,?,?)")
    .run(`series_${suffix}`, `book_${suffix}`, `系列_${suffix}`, 1, 1);
  return connection;
}

function input(suffix = "a") {
  return {
    seriesProjectId: `series_${suffix}`, episodeCount: 10, targetDurationSeconds: 1200,
    sourceStartChapterId: `chapter_${suffix}_1`, sourceEndChapterId: `chapter_${suffix}_2`,
  };
}

test("流水线创建校验连续范围、拒绝重复 active，并隔离另一本书", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-create-"));
  const connection = await seed(dataRoot, "a");
  try {
    await seed(dataRoot, "b", connection);
    const database = connection.database;
    const runA = createSeriesPipelineRun(database, input("a"));
    const runB = createSeriesPipelineRun(database, input("b"));
    assert.equal(runA.status, "configured");
    assert.equal(runB.seriesProjectId, "series_b");
    assert.throws(() => createSeriesPipelineRun(database, input("a")), (error: unknown) =>
      error instanceof SeriesPipelineError && error.statusCode === 409);
    assert.throws(() => createSeriesPipelineRun(database, { ...input("b"), episodeCount: 0 }), /总集数/);
    assert.throws(() => createSeriesPipelineRun(database, {
      ...input("b"), sourceStartChapterId: "chapter_b_2", sourceEndChapterId: "chapter_b_1",
    }), /顺序正确/);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("pause、resume、cancel、retry 幂等且章节事件仅在暂停时可修改", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-control-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const run = createSeriesPipelineRun(database, input());
    assert.throws(
      () => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"),
      (error: unknown) => error instanceof SeriesPipelineError && error.statusCode === 409,
    );
    assert.equal(pauseSeriesPipelineRun(database, run.id).status, "paused");
    assert.equal(pauseSeriesPipelineRun(database, run.id).status, "paused");
    assert.doesNotThrow(() => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"));
    assert.equal(resumeSeriesPipelineRun(database, run.id).status, "configured");
    assert.equal(resumeSeriesPipelineRun(database, run.id).status, "configured");
    assert.equal(retrySeriesPipelineRun(database, run.id).status, "configured");
    assert.equal(cancelSeriesPipelineRun(database, run.id).status, "cancelled");
    assert.equal(cancelSeriesPipelineRun(database, run.id).status, "cancelled");
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("章节分析复用成功章、暂停不派发、失败局部重试并在重启后进入 building_story_bible", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-worker-"));
  let connection = await seed(dataRoot);
  let failSecond = true;
  try {
    const database = connection.database;
    database.prepare(`INSERT INTO chapter_events
      (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
      VALUES ('event_existing','chapter_a_1',0,0,'character','{"name":"甲"}',1)`).run();
    const service = new SeriesPipelineService({
      database, dataRoot, resolveChapterTextProvider: async () => provider,
    });
    const created = await service.create(input());
    await service.reconcile();
    const mappings = getMappedChapterJobs(database, created.id);
    assert.deepEqual(mappings.map((mapping) => mapping.subject_id), ["chapter_a_2"]);
    const queuedJobId = mappings[0]!.job_id;
    const paused = service.pause(created.id);
    await service.reconcile();
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database,
        dataRoot,
        provider,
        async ({ chapterId, atoms }) => {
          if (chapterId === "chapter_a_2" && failSecond) throw new Error("临时模型失败，secret=不得回传完整响应");
          return [{
            type: "character" as const,
            payload: { name: chapterId },
            sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
          }];
        },
      ),
    }, { workerId: "pipeline-test", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    assert.equal(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(queuedJobId)?.run_after, Number.MAX_SAFE_INTEGER);
    assert.equal(await worker.runOne(), false);
    assert.equal(paused.progress.chapterAnalysis.queued, 1);
    service.resume(created.id);
    assert.notEqual(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(queuedJobId)?.run_after, Number.MAX_SAFE_INTEGER);
    await worker.runOne(); await worker.runOne(); await worker.runOne();
    await service.reconcile();
    const failed = service.get(created.id)!;
    assert.equal(failed.progress.chapterAnalysis.failed, 1);
    assert.equal(failed.progress.chapterAnalysis.completed, 1);
    assert.equal(failed.failures[0]!.subjectId, "chapter_a_2");
    assert.equal(failed.failures[0]!.message!.length < 2000, true);
    assert.equal(service.retry(created.id).progress.chapterAnalysis.failed, 0);
    assert.equal(service.retry(created.id).progress.chapterAnalysis.failed, 0);
    failSecond = false;
    await worker.runOne();

    connection.close();
    connection = openDatabase(dataRoot);
    const restartedDatabase = connection.database;
    const restarted = new SeriesPipelineService({
      database: restartedDatabase, dataRoot, resolveChapterTextProvider: async () => provider,
    });
    await restarted.reconcile();
    const completed = restarted.get(created.id)!;
    assert.equal(completed.status, "building_story_bible");
    assert.equal(completed.progress.chapterAnalysis.completed, 2);
    assert.equal(completed.progress.chapterAnalysis.reused, 1);
    assert.match(getSeriesPipelineRun(restartedDatabase, created.id)!.chapterEventsHash!, /^[0-9a-f]{64}$/);
    assert.equal(getMappedChapterJobs(restartedDatabase, created.id).length, 1);
    assert.equal(restartedDatabase.prepare("SELECT status FROM jobs WHERE id=?").get(queuedJobId)?.status, "succeeded");
    await restarted.reconcile();
    assert.equal(getMappedChapterJobs(restartedDatabase, created.id).length, 1);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("空章节分析结果不计完成并保持在分析阶段可重试", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-empty-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const created = await service.create({
      ...input(), sourceEndChapterId: "chapter_a_1",
    });
    await service.reconcile();
    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider, async () => [],
      ),
    }, { workerId: "pipeline-empty", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    await worker.runOne(); await worker.runOne(); await worker.runOne();
    await service.reconcile();
    const failed = service.get(created.id)!;
    assert.equal(failed.status, "analyzing_chapters");
    assert.equal(failed.progress.chapterAnalysis.completed, 0);
    assert.equal(failed.progress.chapterAnalysis.failed, 1);
    assert.equal(failed.failures[0]!.code, "handler_failed");
    assert.equal(service.retry(created.id).progress.chapterAnalysis.queued, 1);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("独占任务取消后显示已中断并可重试，重启协调后完成章节分析", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-cancel-retry-"));
  let connection = await seed(dataRoot);
  try {
    let database = connection.database;
    let service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const created = await service.create({ ...input(), sourceEndChapterId: "chapter_a_1" });
    await service.reconcile();
    const jobId = getMappedChapterJobs(database, created.id)[0]!.job_id;

    service.pause(created.id);
    assert.throws(
      () => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"),
      (error: unknown) => error instanceof SeriesPipelineError && error.statusCode === 409,
    );
    service.resume(created.id);
    const cancelled = service.cancel(created.id);
    assert.equal(database.prepare("SELECT status FROM jobs WHERE id=?").get(jobId)?.status, "cancelled");
    assert.equal(cancelled.failures[0]!.message, "章节分析已中断，请重试该章节");
    assert.equal(cancelled.failures[0]!.canRetry, true);
    assert.equal(cancelled.actions.canRetry, true);
    assert.doesNotThrow(() => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"));

    const retried = service.retry(created.id);
    assert.equal(retried.status, "analyzing_chapters");
    assert.equal(retried.progress.chapterAnalysis.queued, 1);
    const reset = database.prepare(
      "SELECT status,cancel_requested,finished_at,lease_owner,lease_expires_at,error_code,error_message FROM jobs WHERE id=?",
    ).get(jobId) as Record<string, unknown>;
    assert.deepEqual({ ...reset }, {
      status: "queued", cancel_requested: 0, finished_at: null, lease_owner: null,
      lease_expires_at: null, error_code: null, error_message: null,
    });

    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider, async ({ chapterId, atoms }) => [{
          type: "character",
          payload: { name: chapterId },
          sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
        }],
      ),
    }, { workerId: "pipeline-cancel-retry", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), true);
    connection.close();
    connection = openDatabase(dataRoot);
    database = connection.database;
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    assert.equal(service.get(created.id)!.status, "building_story_bible");
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("同书不同系列共享确定性 Job 时暂停取消互不改写 Job，retry 复用共享失败 Job", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-shared-job-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_other','book_a','另一系列',2,2)").run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const first = await service.create({ ...input(), sourceEndChapterId: "chapter_a_1" });
    const second = await service.create({ ...input(), seriesProjectId: "series_other", sourceEndChapterId: "chapter_a_1" });
    await service.reconcile();
    const firstJob = getMappedChapterJobs(database, first.id)[0]!.job_id;
    const secondJob = getMappedChapterJobs(database, second.id)[0]!.job_id;
    assert.equal(firstJob, secondJob);
    const snapshot = database.prepare(
      "SELECT status,run_after,max_attempts,cancel_requested FROM jobs WHERE id=?",
    ).get(firstJob);
    service.pause(first.id);
    assert.deepEqual(database.prepare(
      "SELECT status,run_after,max_attempts,cancel_requested FROM jobs WHERE id=?",
    ).get(firstJob), snapshot);
    service.cancel(first.id);
    assert.deepEqual(database.prepare(
      "SELECT status,run_after,max_attempts,cancel_requested FROM jobs WHERE id=?",
    ).get(firstJob), snapshot);
    database.prepare(
      "UPDATE jobs SET status='running',lease_owner='shared-worker',lease_expires_at=9999999999999 WHERE id=?",
    ).run(firstJob);
    service.pause(second.id);
    assert.throws(
      () => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"),
      (error: unknown) => error instanceof SeriesPipelineError && error.statusCode === 409,
    );
    database.prepare(
      `UPDATE jobs SET status='failed',lease_owner=NULL,lease_expires_at=NULL,
       error_code='handler_failed',error_message='共享失败',finished_at=2 WHERE id=?`,
    ).run(firstJob);
    assert.doesNotThrow(() => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"));
    service.retry(second.id);
    assert.throws(
      () => assertSeriesPipelineAllowsChapterEventMutation(database, "book_a", "chapter_a_1"),
      (error: unknown) => error instanceof SeriesPipelineError && error.statusCode === 409,
    );
    assert.equal(database.prepare("SELECT status FROM jobs WHERE id=?").get(firstJob)?.status, "queued");
    assert.equal(service.get(first.id)!.status, "cancelled");
    assert.equal(service.get(second.id)!.progress.chapterAnalysis.queued, 1);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("active run 后映射已暂停排队的共享 Job 时在同一控制顺序中唤醒", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-map-wake-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    database.prepare(
      "INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_other','book_a','另一系列',2,2)",
    ).run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const pausedOwner = await service.create({ ...input(), sourceEndChapterId: "chapter_a_1" });
    await service.reconcile();
    const jobId = getMappedChapterJobs(database, pausedOwner.id)[0]!.job_id;
    service.pause(pausedOwner.id);
    assert.equal(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(jobId)?.run_after, Number.MAX_SAFE_INTEGER);

    const activeOwner = await service.create({
      ...input(), seriesProjectId: "series_other", sourceEndChapterId: "chapter_a_1",
    });
    const beforeMap = Date.now();
    await service.reconcile();
    assert.equal(getMappedChapterJobs(database, activeOwner.id)[0]!.job_id, jobId);
    const awakened = database.prepare("SELECT status,run_after FROM jobs WHERE id=?").get(jobId) as {
      status: string; run_after: number;
    };
    assert.equal(awakened.status, "queued");
    assert.notEqual(awakened.run_after, Number.MAX_SAFE_INTEGER);
    assert.equal(awakened.run_after >= beforeMap && awakened.run_after <= Date.now(), true);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("paused retry 仅在存在其他 active owner 时允许 Worker claim", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-retry-ownership-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    database.prepare(
      "INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series_other','book_a','另一系列',2,2)",
    ).run();
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const first = await service.create({ ...input(), sourceEndChapterId: "chapter_a_1" });
    await service.reconcile();
    const jobId = getMappedChapterJobs(database, first.id)[0]!.job_id;
    database.prepare(
      "UPDATE jobs SET status='failed',error_code='test_failed',error_message='测试失败',finished_at=? WHERE id=?",
    ).run(Date.now(), jobId);
    service.pause(first.id);
    service.retry(first.id);
    assert.equal(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(jobId)?.run_after, Number.MAX_SAFE_INTEGER);

    const worker = new JobWorker(database, {
      [CHAPTER_EVENTS_ANALYZE_JOB_TYPE]: createChapterEventsAnalysisJobHandler(
        database, dataRoot, provider, async ({ chapterId, atoms }) => [{
          type: "character",
          payload: { name: chapterId },
          sources: [{ byteStart: atoms[0]!.byteStart, byteEnd: atoms[0]!.byteEnd }],
        }],
      ),
    }, { workerId: "pipeline-retry-ownership", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), false);

    database.prepare(
      `UPDATE jobs SET status='failed',run_after=?,error_code='test_failed',error_message='再次失败',finished_at=?
       WHERE id=?`,
    ).run(Date.now(), Date.now(), jobId);
    const second = await service.create({
      ...input(), seriesProjectId: "series_other", sourceEndChapterId: "chapter_a_1",
    });
    await service.reconcile();
    assert.equal(getMappedChapterJobs(database, second.id)[0]!.job_id, jobId);
    service.retry(first.id);
    assert.notEqual(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(jobId)?.run_after, Number.MAX_SAFE_INTEGER);
    assert.equal(await worker.runOne(), true);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("pause 和 cancel 任一 mapped Job 控制失败时完整回滚 run 与先前 Job", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-control-rollback-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const created = await service.create(input());
    await service.reconcile();
    const firstJobId = getMappedChapterJobs(database, created.id)[0]!.job_id;
    const secondJobId = "zz_job_pipeline_rollback";
    createJob(database, {
      id: secondJobId,
      type: CHAPTER_EVENTS_ANALYZE_JOB_TYPE,
      payload: { test: true },
    });
    mapSeriesPipelineJob(database, created.id, "chapter_a_2", secondJobId);

    database.exec(
      `CREATE TRIGGER fail_second_job_pause BEFORE UPDATE OF run_after ON jobs
       WHEN OLD.id = '${secondJobId}' AND NEW.run_after = ${Number.MAX_SAFE_INTEGER}
       BEGIN SELECT RAISE(ABORT, '模拟第二个 Job 暂停失败'); END`,
    );
    assert.throws(() => service.pause(created.id), /模拟第二个 Job 暂停失败/);
    assert.equal(getSeriesPipelineRun(database, created.id)!.status, "analyzing_chapters");
    assert.notEqual(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(firstJobId)?.run_after, Number.MAX_SAFE_INTEGER);
    assert.notEqual(database.prepare("SELECT run_after FROM jobs WHERE id=?").get(secondJobId)?.run_after, Number.MAX_SAFE_INTEGER);
    database.exec("DROP TRIGGER fail_second_job_pause");

    database.exec(
      `CREATE TRIGGER fail_second_job_cancel BEFORE UPDATE OF status ON jobs
       WHEN OLD.id = '${secondJobId}' AND NEW.status = 'cancelled'
       BEGIN SELECT RAISE(ABORT, '模拟第二个 Job 取消失败'); END`,
    );
    assert.throws(() => service.cancel(created.id), /模拟第二个 Job 取消失败/);
    assert.equal(getSeriesPipelineRun(database, created.id)!.status, "analyzing_chapters");
    for (const jobId of [firstJobId, secondJobId]) {
      const job = database.prepare("SELECT status,cancel_requested FROM jobs WHERE id=?").get(jobId) as {
        status: string; cancel_requested: number;
      };
      assert.deepEqual({ ...job }, { status: "queued", cancel_requested: 0 });
    }
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("脚本阶段严格串行消费上一集交接，失败局部重试且暂停重启不越序", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-scripts-"));
  let connection = await seed(dataRoot);
  let failSecond = true;
  try {
    let database = connection.database;
    database.prepare(`INSERT INTO chapter_events
      (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
      VALUES ('event_script','chapter_a_1',0,0,'revelation','{"fact":"入口"}',1)`).run();
    for (const index of [1, 2]) {
      database.prepare(`INSERT INTO episodes
        (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,recap,next_hook,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,1,1)`).run(
        `episode_${index}`, "series_a", index, `第${index}集`, `故事弧${index}`, 1200,
        index === 1 ? null : "承接上集", `钩子${index}`,
      );
      const chapter = database.prepare(
        "SELECT byte_start,byte_end,content_hash FROM chapters WHERE id='chapter_a_1'",
      ).get() as { byte_start: number; byte_end: number; content_hash: string };
      database.prepare(`INSERT INTO episode_sources
        (episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash)
        VALUES (?,0,'chapter_a_1','event_script',?,?,?)`).run(
        `episode_${index}`, chapter.byte_start, chapter.byte_end, chapter.content_hash,
      );
    }
    const run = createSeriesPipelineRun(database, { ...input(), episodeCount: 2 });
    setSeriesPipelineStatus(database, run.id, "configured", "generating_scripts");
    let service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    const seenHandoffs: unknown[] = [];
    let generatingSecond = false;
    const generate: GenerateEpisodeScript = async (stage) => {
      if (stage.stage === "skeleton") {
        seenHandoffs.push(stage.previousScriptHandoff);
        generatingSecond = stage.previousScriptHandoff != null;
        return { beats: [{ intent: stage.episode.storyArc, sourceIndexes: [0] }] };
      }
      if (stage.stage === "faithful") return { text: stage.sources[0]!.sourceText };
      if (failSecond && generatingSecond) throw new Error("第二集暂时失败");
      return { paragraphs: stage.paragraphs };
    };
    let worker = new JobWorker(database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        database, dataRoot, provider, generate,
      ),
    }, { workerId: "pipeline-scripts", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });

    await service.reconcile();
    assert.deepEqual(getMappedScriptJobs(database, run.id).map((item) => item.subject_id), ["episode_1"]);
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    assert.deepEqual(getMappedScriptJobs(database, run.id).map((item) => item.subject_id), ["episode_1", "episode_2"]);
    const secondJobId = getMappedScriptJobs(database, run.id)[1]!.job_id;
    const secondPayload = getJob(database, secondJobId)!.payload as { previousScriptHandoff?: unknown };
    assert.deepEqual(secondPayload.previousScriptHandoff, {
      summary: "故事弧1", continuityNotes: ["钩子1", "故事弧1"],
    });
    service.pause(run.id);
    assert.equal(await worker.runOne(), false);
    assert.equal(getMappedScriptJobs(database, run.id).length, 2);
    service.resume(run.id);
    const mappedBeforeCancel = getMappedScriptJobs(database, run.id);
    assert.equal(service.cancel(run.id).status, "cancelled");
    assert.equal(service.retry(run.id).status, "generating_scripts");
    assert.deepEqual(getMappedScriptJobs(database, run.id), mappedBeforeCancel);

    connection.close();
    connection = openDatabase(dataRoot);
    database = connection.database;
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    assert.deepEqual(getMappedScriptJobs(database, run.id), mappedBeforeCancel);
    worker = new JobWorker(database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        database, dataRoot, provider, generate,
      ),
    }, { workerId: "pipeline-scripts-restarted", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    await worker.runOne(); await worker.runOne(); await worker.runOne();
    await service.reconcile();
    assert.equal(service.get(run.id)!.progress.scripts.completed, 2);
    assert.equal(service.get(run.id)!.failures[0]!.subjectId, "episode_2");
    service.retry(run.id);
    failSecond = false;
    assert.equal(await worker.runOne(), true);

    connection.close();
    connection = openDatabase(dataRoot);
    database = connection.database;
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    assert.equal(service.get(run.id)!.status, "checking_coverage");
    assert.equal(service.get(run.id)!.progress.scripts.completed, 4);
    assert.equal(seenHandoffs[0], null);
    assert.deepEqual(seenHandoffs.at(-1), secondPayload.previousScriptHandoff);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()?.total, 0);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("故事圣经按事件 identity 复用模型切换，失败局部重试并在暂停重启后持久进入规划", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-bible-"));
  let connection = await seed(dataRoot);
  try {
    let database = connection.database;
    for (const index of [1, 2]) database.prepare(`INSERT INTO chapter_events
      (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
      VALUES (?,?,?,?,?,?,1)`).run(
      `event_bible_${index}`, `chapter_a_${index}`, 0, 0, "revelation", JSON.stringify({ summary: `事件${index}` }),
    );
    const run = createSeriesPipelineRun(database, input());
    setSeriesPipelineStatus(database, run.id, "configured", "building_story_bible");
    let service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    const mapping = getMappedStoryBibleJob(database, run.id)!;
    const firstJob = getJob(database, mapping.job_id)!;
    assert.equal(firstJob.type, BOOK_STORY_BIBLE_JOB_TYPE);
    assert.equal((firstJob.payload as { providerId: string }).providerId, provider.providerId);

    const switched = { ...provider, providerId: "provider-switched", model: "model-switched" };
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => switched });
    await service.reconcile();
    assert.equal(getMappedStoryBibleJob(database, run.id)!.job_id, mapping.job_id);

    service.pause(run.id);
    database.prepare("UPDATE chapter_events SET payload_json=? WHERE id='event_bible_1'")
      .run(JSON.stringify({ summary: "暂停后修正的事件" }));
    database.prepare(
      "UPDATE jobs SET status='succeeded',result_json=?,progress=1,finished_at=? WHERE id=?",
    ).run(JSON.stringify({ storyBibleId: "stale_bible" }), Date.now(), mapping.job_id);
    connection.close();
    connection = openDatabase(dataRoot);
    database = connection.database;
    service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    assert.equal(service.resume(run.id).status, "building_story_bible");
    await service.reconcile();
    const remapped = getMappedStoryBibleJob(database, run.id)!;
    assert.notEqual(remapped.job_id, mapping.job_id);
    assert.equal(service.get(run.id)!.status, "building_story_bible");
    assert.equal(getJob(database, mapping.job_id)!.status, "succeeded");
    assert.equal(getJob(database, mapping.job_id)!.runAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS total FROM series_pipeline_jobs WHERE run_id=? AND stage='story_bible'",
    ).get(run.id)?.total, 1);
    database.prepare(
      "UPDATE jobs SET status='failed',error_code='temporary',error_message='临时失败',finished_at=? WHERE id=?",
    ).run(Date.now(), remapped.job_id);
    await service.reconcile();
    assert.equal(service.get(run.id)!.failures[0]!.stage, "story_bible");
    assert.equal(service.retry(run.id).status, "building_story_bible");

    const content = (sourceEventId: string, chapterId: string) => ({
      characters: [], relationships: [], locations: [], organizations: [], items: [], concepts: [],
      timeline: [{ summary: "已验证事件", chapterIds: [chapterId], sourceEventIds: [sourceEventId] }],
      flashbacks: [], plotThreads: [], confusingFacts: [], spoilerRestrictions: [], properNouns: [],
    });
    let call = 0;
    const responses = [content("event_bible_1", "chapter_a_1"), content("event_bible_1", "chapter_a_1")];
    const fetchImpl = (async () => new Response(JSON.stringify({
      output_text: JSON.stringify(responses[call++]),
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const worker = new JobWorker(database, {
      [BOOK_STORY_BIBLE_JOB_TYPE]: createBookStoryBibleJobHandler(database, provider, { fetchImpl }),
    }, { workerId: "pipeline-bible", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
    assert.equal(await worker.runOne(), true);
    await service.reconcile();
    const completed = service.get(run.id)!;
    assert.equal(completed.status, "planning_episodes");
    assert.match(completed.storyBibleId!, /^bible_/);
    assert.equal(completed.progress.storyBible.completed, 1);
    assert.equal(database.prepare("SELECT scope FROM book_story_bibles WHERE id=?")
      .get(completed.storyBibleId)?.scope, "final");
    assert.equal(getMappedStoryBibleJob(database, run.id)!.job_id, remapped.job_id);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("Story Bible parked Job 在 pause 或 cancel 先完成时不会映射或被 Worker claim", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-bible-race-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const run = createSeriesPipelineRun(database, input());
    setSeriesPipelineStatus(database, run.id, "configured", "building_story_bible");
    const job = createJob(database, {
      id: "job_story_bible_parked", type: BOOK_STORY_BIBLE_JOB_TYPE, payload: {},
      runAfter: Number.MAX_SAFE_INTEGER,
    });
    pauseSeriesPipelineRun(database, run.id);
    assert.equal(mapSeriesPipelineStoryBibleJob(database, run.id, "1".repeat(64), job.id), false);
    assert.equal(getMappedStoryBibleJob(database, run.id), undefined);
    const worker = new JobWorker(database, {
      [BOOK_STORY_BIBLE_JOB_TYPE]: async () => ({ storyBibleId: "should_not_run" }),
    }, { workerId: "pipeline-bible-race", leaseMs: 10_000, heartbeatMs: 1_000 });
    assert.equal(await worker.runOne(), false);
    resumeSeriesPipelineRun(database, run.id);
    cancelSeriesPipelineRun(database, run.id);
    assert.equal(mapSeriesPipelineStoryBibleJob(database, run.id, "1".repeat(64), job.id), false);
    assert.equal(getJob(database, job.id)!.runAfter, Number.MAX_SAFE_INTEGER);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("全书规划以当前 identity parked 映射，旧结果不推进并原子冻结恰好 N 集", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-plan-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    for (const index of [1, 2]) {
      const eventId = `event_plan_${index}`;
      const start = index === 1 ? 0 : Buffer.byteLength("a甲在庭院出现。", "utf8");
      const end = start + 3;
      database.prepare(`INSERT INTO chapter_events
        (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
        VALUES (?,?,?,?,?,?,1)`).run(
        eventId, `chapter_a_${index}`, 0, 0, "revelation", JSON.stringify({ summary: `事件${index}` }),
      );
      database.prepare(`INSERT INTO chapter_event_sources
        (event_id,source_index,source_byte_start,source_byte_end,source_hash) VALUES (?,0,?,?,?)`)
        .run(eventId, start, end, String(index).repeat(64));
    }
    const bibleContent = {
      characters: [], relationships: [], locations: [], organizations: [], items: [], concepts: [],
      timeline: [
        { summary: "事件1", chapterIds: ["chapter_a_1"], sourceEventIds: ["event_plan_1"] },
        { summary: "事件2", chapterIds: ["chapter_a_2"], sourceEventIds: ["event_plan_2"] },
      ],
      flashbacks: [], plotThreads: [], confusingFacts: [], spoilerRestrictions: [], properNouns: [],
    };
    const bible = createBookStoryBible(database, {
      bookId: "book_a", scope: "final", sourceStartChapterId: "chapter_a_1",
      sourceEndChapterId: "chapter_a_2", sourceEventIds: ["event_plan_1", "event_plan_2"],
      parentBibleIds: [], providerId: provider.providerId, model: provider.model, content: bibleContent,
    });
    const run = createSeriesPipelineRun(database, { ...input(), episodeCount: 2, targetDurationSeconds: 240 });
    setSeriesPipelineStatus(database, run.id, "configured", "building_story_bible");
    database.prepare(
      "UPDATE series_pipeline_runs SET status='planning_episodes',story_bible_id=? WHERE id=?",
    ).run(bible.id, run.id);
    const service = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await service.reconcile();
    const first = getMappedEpisodePlanJob(database, run.id)!;
    assert.equal(getJob(database, first.job_id)!.type, FULL_BOOK_PLAN_JOB_TYPE);
    assert.notEqual(getJob(database, first.job_id)!.runAfter, Number.MAX_SAFE_INTEGER);
    assert.equal(service.cancel(run.id).status, "cancelled");
    assert.equal(getJob(database, first.job_id)!.status, "cancelled");
    assert.equal(service.retry(run.id).status, "planning_episodes");
    assert.equal(getJob(database, first.job_id)!.status, "queued");

    service.pause(run.id);
    database.prepare("UPDATE chapter_events SET payload_json=? WHERE id='event_plan_1'")
      .run(JSON.stringify({ summary: "暂停后修正" }));
    const stalePlan = { episodes: [
      { index: 1, title: "旧一", storyArc: "旧", sourceEventIds: ["event_plan_1"], recap: null, nextHook: "旧" },
      { index: 2, title: "旧二", storyArc: "旧", sourceEventIds: ["event_plan_2"], recap: "旧", nextHook: null },
    ] };
    const staleHash = createHash("sha256").update(canonicalFullBookPlanJson(stalePlan)).digest("hex");
    database.prepare("UPDATE jobs SET status='succeeded',result_json=?,progress=1,finished_at=? WHERE id=?")
      .run(JSON.stringify({ plan: stalePlan, planHash: staleHash }), Date.now(), first.job_id);
    service.resume(run.id);
    await service.reconcile();
    const current = getMappedEpisodePlanJob(database, run.id)!;
    assert.notEqual(current.job_id, first.job_id);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM episodes").get()!.total, 0);

    const plan = { episodes: [
      { index: 1, title: "第一集", storyArc: "开端", sourceEventIds: ["event_plan_1"], recap: null, nextHook: "继续" },
      { index: 2, title: "第二集", storyArc: "收束", sourceEventIds: ["event_plan_2"], recap: "前情", nextHook: null },
    ] };
    const planHash = createHash("sha256").update(canonicalFullBookPlanJson(plan)).digest("hex");
    database.prepare("UPDATE jobs SET status='succeeded',result_json=?,progress=1,finished_at=? WHERE id=?")
      .run(JSON.stringify({ plan, planHash }), Date.now(), current.job_id);
    setSeriesPipelineStatus(database, run.id, "planning_episodes", "validating_plan");
    setSeriesPipelineStatus(database, run.id, "validating_plan", "freezing_plan");
    const restarted = new SeriesPipelineService({ database, dataRoot, resolveChapterTextProvider: async () => provider });
    await restarted.reconcile();
    const completed = restarted.get(run.id)!;
    assert.equal(completed.status, "generating_scripts");
    assert.equal(completed.planHash, planHash);
    assert.equal(completed.progress.episodePlan.completed, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM episodes").get()!.total, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS total FROM script_approval_events").get()!.total, 0);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});

test("全书规划 parked Job 在 pause 或 cancel 先完成时不会映射", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-pipeline-plan-race-"));
  const connection = await seed(dataRoot);
  try {
    const database = connection.database;
    const run = createSeriesPipelineRun(database, { ...input(), episodeCount: 2 });
    setSeriesPipelineStatus(database, run.id, "configured", "planning_episodes");
    const job = createJob(database, {
      id: "job_plan_parked", type: FULL_BOOK_PLAN_JOB_TYPE, payload: {}, runAfter: Number.MAX_SAFE_INTEGER,
    });
    pauseSeriesPipelineRun(database, run.id);
    assert.equal(mapSeriesPipelineEpisodePlanJob(database, run.id, "1".repeat(64), job.id), false);
    resumeSeriesPipelineRun(database, run.id);
    cancelSeriesPipelineRun(database, run.id);
    assert.equal(mapSeriesPipelineEpisodePlanJob(database, run.id, "1".repeat(64), job.id), false);
    assert.equal(getMappedEpisodePlanJob(database, run.id), undefined);
    assert.equal(getJob(database, job.id)!.runAfter, Number.MAX_SAFE_INTEGER);
  } finally { connection.close(); await rm(dataRoot, { recursive: true, force: true }); }
});
