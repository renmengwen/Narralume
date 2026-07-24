import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import { CHAPTER_EVENTS_JOB_TYPE } from "./chapter-events-job.js";

async function waitForJob(app: ReturnType<typeof buildApp>, jobId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    const job = response.json().job;
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待章节事件任务完成超时");
}

test("默认章节事件任务先持久化再原子保存事件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-chapter-events-job-"));
  const app = buildApp({
    dataRoot,
    logger: false,
    jobPollMs: 5,
    jobWorker: { workerId: "chapter-events-test", leaseMs: 1_000, heartbeatMs: 100 },
  });
  const source = Buffer.from("第一章\n宝玉来到大观园。", "utf8");
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: { "content-type": "text/plain" },
      payload: source,
    });
    const bookId = imported.json().book.id as string;
    const chapters = await app.inject({ method: "GET", url: `/api/books/${bookId}/chapters` });
    const chapterId = chapters.json().items[0].id as string;
    const evidence = Buffer.from("宝玉", "utf8");
    const byteStart = source.indexOf(evidence);
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: {
        type: CHAPTER_EVENTS_JOB_TYPE,
        payload: {
          bookId,
          chapters: [{
            chapterId,
            events: [{
              type: "character",
              payload: { name: "宝玉" },
              sources: [{ byteStart, byteEnd: byteStart + evidence.length }],
            }],
          }],
        },
      },
    });
    assert.equal(created.statusCode, 201);
    const job = await waitForJob(app, created.json().job.id as string);
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.result, { processed: 1, reused: 0, chapters: 1 });
    const events = await app.inject({
      method: "GET",
      url: `/api/books/${bookId}/chapters/${chapterId}/events`,
    });
    assert.equal(events.statusCode, 200);
    assert.equal(events.json().total, 1);
    assert.equal(events.json().items[0].type, "character");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
