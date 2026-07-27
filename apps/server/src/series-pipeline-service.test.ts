import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { createChapterEventsAnalysisJobHandler, CHAPTER_EVENTS_ANALYZE_JOB_TYPE } from "./chapter-events-job.js";
import { openDatabase } from "./database.js";
import { createJob } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import { SeriesPipelineService } from "./series-pipeline-service.js";
import {
  assertSeriesPipelineAllowsChapterEventMutation,
  createSeriesPipelineRun,
  getMappedChapterJobs,
  getSeriesPipelineRun,
  mapSeriesPipelineJob,
  pauseSeriesPipelineRun,
  resumeSeriesPipelineRun,
  cancelSeriesPipelineRun,
  retrySeriesPipelineRun,
  SeriesPipelineError,
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
