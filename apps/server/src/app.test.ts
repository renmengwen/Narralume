import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import { openDatabase } from "./database.js";
import { getJob } from "./job-store.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("健康检查返回服务状态", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-app-"));
  const app = buildApp({ dataRoot, logger: false });

  try {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, service: "narralume" });
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("HTTP 原始流导入 TXT 并返回中文幂等状态", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-app-import-"));
  const app = buildApp({ dataRoot, logger: false });
  const payload = Buffer.from("第一章\n原文内容", "utf8");

  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: {
        "content-type": "text/plain",
        "x-file-name": encodeURIComponent("测试书.txt"),
      },
      payload,
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: { "content-type": "application/octet-stream" },
      payload,
    });
    const empty = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: { "content-type": "text/plain" },
      payload: Buffer.alloc(0),
    });

    assert.equal(first.statusCode, 201);
    assert.equal(first.json().message, "书籍已导入并完成章节索引");
    assert.equal(first.json().chapter_count, 1);
    assert.equal(first.json().book.encoding, "UTF-8");
    assert.equal(first.json().book.import_status, "ready");
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().message, "相同内容已存在，章节索引已确认");
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().message, "TXT 文件不能为空");

    const books = await app.inject({ method: "GET", url: "/api/books" });
    const bookId = first.json().book.id as string;
    const chapters = await app.inject({ method: "GET", url: `/api/books/${bookId}/chapters?limit=1&offset=0` });
    const chapterId = chapters.json().items[0].id as string;
    const chapterText = await app.inject({
      method: "GET",
      url: `/api/books/${bookId}/chapters/${chapterId}/text`,
    });
    const invalidPagination = await app.inject({
      method: "GET",
      url: `/api/books/${bookId}/chapters?limit=0`,
    });
    const missingBook = await app.inject({
      method: "GET",
      url: "/api/books/book_missing/chapters",
    });
    const missingChapter = await app.inject({
      method: "GET",
      url: `/api/books/${bookId}/chapters/chapter_missing/text`,
    });

    assert.equal(books.statusCode, 200);
    assert.equal(books.json().items[0].chapter_count, 1);
    assert.equal(chapters.statusCode, 200);
    assert.equal(chapters.json().total, 1);
    assert.equal(chapterText.statusCode, 200);
    assert.equal(chapterText.json().text, "第一章\n原文内容");
    assert.equal(invalidPagination.statusCode, 400);
    assert.equal(invalidPagination.json().message, "分页参数无效");
    assert.equal(missingBook.statusCode, 404);
    assert.equal(missingBook.json().message, "书籍不存在");
    assert.equal(missingChapter.statusCode, 404);
    assert.equal(missingChapter.json().message, "章节不存在");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("章节事件 HTTP 合同重算证据且重复导入不清空事件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-app-events-"));
  const app = buildApp({ dataRoot, logger: false });
  const payload = Buffer.from("第一章\n宝玉来到大观园。", "utf8");

  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: { "content-type": "text/plain" },
      payload,
    });
    const bookId = imported.json().book.id as string;
    const chapters = await app.inject({ method: "GET", url: `/api/books/${bookId}/chapters` });
    const chapterId = chapters.json().items[0].id as string;
    const evidence = Buffer.from("宝玉", "utf8");
    const sourceByteStart = payload.indexOf(evidence);
    const saved = await app.inject({
      method: "PUT",
      url: `/api/books/${bookId}/chapters/${chapterId}/events`,
      payload: {
        events: [{
          type: "character",
          payload: { name: "宝玉", detail: "宝玉出现" },
          sources: [{ byteStart: sourceByteStart, byteEnd: sourceByteStart + evidence.length }],
        }],
      },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().message, "章节事件已保存");
    assert.equal(
      saved.json().items[0].sources[0].sourceHash,
      createHash("sha256").update(evidence).digest("hex"),
    );

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: { "content-type": "text/plain" },
      payload,
    });
    const listed = await app.inject({
      method: "GET",
      url: `/api/books/${bookId}/chapters/${chapterId}/events?limit=1&offset=0`,
    });
    const invalid = await app.inject({
      method: "PUT",
      url: `/api/books/${bookId}/chapters/${chapterId}/events`,
      payload: { events: [{ type: "unknown", payload: {}, sources: [] }] },
    });
    const duplicateEvidence = await app.inject({
      method: "PUT",
      url: `/api/books/${bookId}/chapters/${chapterId}/events`,
      payload: {
        events: [{
          type: "character",
          payload: { name: "重复证据" },
          sources: [
            { byteStart: sourceByteStart, byteEnd: sourceByteStart + evidence.length },
            { byteStart: sourceByteStart, byteEnd: sourceByteStart + evidence.length },
          ],
        }],
      },
    });
    const malformedJson = await app.inject({
      method: "PUT",
      url: `/api/books/${bookId}/chapters/${chapterId}/events`,
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().total, 1);
    assert.deepEqual(listed.json().items[0].payload, { name: "宝玉", detail: "宝玉出现" });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().message, "章节事件类型无效");
    assert.equal(duplicateEvidence.statusCode, 422);
    assert.equal(duplicateEvidence.json().message, "同一事件不能重复引用相同原文范围");
    assert.equal(JSON.stringify(duplicateEvidence.json()).includes("SQLITE"), false);
    assert.equal(malformedJson.statusCode, 400);
    assert.deepEqual(malformedJson.json(), { ok: false, message: "请求 JSON 或参数无效" });
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("故事弧分集 API 保存服务端证据快照并可重启查询", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-app-episode-"));
  let app = buildApp({ dataRoot, logger: false });
  const payload = Buffer.from("第一章\n宝玉来到大观园。", "utf8");
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: { "content-type": "text/plain" },
      payload,
    });
    const bookId = imported.json().book.id as string;
    const chapters = await app.inject({ method: "GET", url: `/api/books/${bookId}/chapters` });
    const chapterId = chapters.json().items[0].id as string;
    const evidence = Buffer.from("宝玉", "utf8");
    const byteStart = payload.indexOf(evidence);
    const events = await app.inject({
      method: "PUT",
      url: `/api/books/${bookId}/chapters/${chapterId}/events`,
      payload: {
        events: [{
          type: "character",
          payload: { name: "宝玉" },
          sources: [{ byteStart, byteEnd: byteStart + evidence.length }],
        }],
      },
    });
    const sourceEventId = events.json().items[0].id as string;
    const created = await app.inject({
      method: "POST",
      url: `/api/books/${bookId}/series`,
      payload: { title: "红楼梦短视频" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().message, "系列项目已创建");
    const seriesId = created.json().series.id as string;
    const saved = await app.inject({
      method: "PUT",
      url: `/api/series/${seriesId}/episodes/1`,
      payload: {
        title: "宝玉初见",
        storyArc: "人物进入核心空间",
        targetDurationSeconds: 240,
        recap: "故事由此开始",
        nextHook: "大观园里还会发生什么？",
        sourceEventIds: [sourceEventId],
      },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().episode.index, 1);

    await app.close();
    app = buildApp({ dataRoot, logger: false });
    const listed = await app.inject({ method: "GET", url: `/api/books/${bookId}/series` });
    const queried = await app.inject({ method: "GET", url: `/api/series/${seriesId}/episodes/1` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items.length, 1);
    assert.equal(queried.statusCode, 200);
    assert.equal(queried.json().episode.sources.length, 1);
    assert.equal(queried.json().episode.sources[0].sourceText, "宝玉");
    assert.equal(queried.json().episode.sources[0].sourceHash, createHash("sha256").update(evidence).digest("hex"));

    const invalid = await app.inject({
      method: "PUT",
      url: `/api/series/${seriesId}/episodes/0`,
      payload: {
        title: "非法分集",
        storyArc: "非法",
        targetDurationSeconds: 240,
        sourceEventIds: [sourceEventId],
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().message, "分集序号必须从 1 开始");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("非法 Worker 配置失败时关闭 SQLite", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-app-invalid-worker-"));
  try {
    assert.throws(
      () => buildApp({ dataRoot, logger: false, jobWorker: { leaseMs: Number.NaN } }),
      /Worker 租约或续租间隔无效/,
    );
    await rm(dataRoot, { recursive: true, force: true });
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("任务 HTTP 边界先持久化、可查询取消且关闭时等待 Worker", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-app-jobs-"));
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let observedPersisted = false;
  const app = buildApp({
    dataRoot,
    logger: false,
    jobPollMs: 5,
    jobHandlers: {
      hold: async (context) => {
        observedPersisted = context.job.status === "running" && context.job.attempts === 1;
        context.reportProgress(0.5);
        await wait;
        return { completed: true };
      },
    },
    jobWorker: { workerId: "http-worker", leaseMs: 1_000, heartbeatMs: 100 },
  });

  try {
    const unsupported = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { type: "missing", payload: {} },
    });
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.json().message, "不支持的任务类型：missing");
    const excessiveRetries = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { type: "hold", payload: {}, maxAttempts: 9_007_199_254_740_991 },
    });
    assert.equal(excessiveRetries.statusCode, 400);
    assert.equal(excessiveRetries.json().message, "最大尝试次数必须在 1～10 之间");

    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { type: "hold", payload: { chapterId: "chapter_1" }, maxAttempts: 2 },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().message, "任务已创建并持久化");
    const jobId = created.json().job.id as string;

    await waitUntil(() => observedPersisted);
    const queried = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    assert.equal(queried.statusCode, 200);
    assert.equal(queried.json().job.status, "running");
    assert.equal(queried.json().job.attempts, 1);
    assert.equal(queried.json().job.progress, 0.5);

    const cancelled = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/cancel` });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().message, "取消请求已记录");
    assert.equal(cancelled.json().job.cancelRequested, true);
    const missing = await app.inject({ method: "GET", url: "/api/jobs/job_missing" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().message, "任务不存在");

    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    await closing;

    const reopened = openDatabase(dataRoot);
    try {
      const persisted = getJob(reopened.database, jobId);
      assert.equal(persisted?.status, "cancelled");
      assert.equal(persisted?.result, null);
    } finally {
      reopened.close();
    }
  } finally {
    release?.();
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
