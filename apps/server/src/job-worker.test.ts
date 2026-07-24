import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { createJob, getJob, requestJobCancellation } from "./job-store.js";
import { JobWorker } from "./job-worker.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("单 Worker 不并发执行任务并持久化进度与结果", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-worker-single-"));
  const connection = openDatabase(dataRoot);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  try {
    createJob(connection.database, { id: "job_first", type: "hold", payload: { value: 1 } });
    createJob(connection.database, { id: "job_second", type: "hold", payload: { value: 2 } });
    const worker = new JobWorker(
      connection.database,
      {
        hold: async (context) => {
          context.reportProgress(0.5);
          await wait;
          return { value: (context.job.payload as { value: number }).value };
        },
      },
      { workerId: "worker", leaseMs: 1_000, heartbeatMs: 100 },
    );

    const firstRun = worker.runOne();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await worker.runOne(), false);
    assert.equal(getJob(connection.database, "job_first")?.progress, 0.5);
    assert.equal(getJob(connection.database, "job_second")?.status, "queued");
    release();
    assert.equal(await firstRun, true);
    assert.equal(getJob(connection.database, "job_first")?.status, "succeeded");
    assert.deepEqual(getJob(connection.database, "job_first")?.result, { value: 1 });
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(connection.database, "job_second")?.status, "succeeded");
  } finally {
    release?.();
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("运行中取消请求阻止结果提交", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-worker-cancel-"));
  const connection = openDatabase(dataRoot);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  try {
    createJob(connection.database, { id: "job_cancel", type: "hold", payload: {} });
    const worker = new JobWorker(
      connection.database,
      { hold: async () => { await wait; return { shouldNotPersist: true }; } },
      { workerId: "worker", leaseMs: 1_000, heartbeatMs: 100 },
    );
    const running = worker.runOne();
    await new Promise((resolve) => setImmediate(resolve));
    requestJobCancellation(connection.database, "job_cancel");
    release();
    await running;
    const cancelled = getJob(connection.database, "job_cancel");
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.result, null);
  } finally {
    release?.();
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("start 自动领取任务，stop 等待当前任务且不再领取下一项", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-worker-loop-"));
  const connection = openDatabase(dataRoot);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let worker: JobWorker | undefined;
  try {
    createJob(connection.database, { id: "job_running", type: "hold", payload: {} }, 1_000);
    createJob(connection.database, { id: "job_queued", type: "hold", payload: {} }, 1_001);
    worker = new JobWorker(
      connection.database,
      { hold: async () => { await wait; return {}; } },
      { workerId: "worker", leaseMs: 1_000, heartbeatMs: 100 },
    );

    worker.start(10_000);
    await waitUntil(() => getJob(connection.database, "job_running")?.status === "running");
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    await stopping;

    assert.equal(getJob(connection.database, "job_running")?.status, "succeeded");
    assert.equal(getJob(connection.database, "job_queued")?.status, "queued");
  } finally {
    release?.();
    await worker?.stop();
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("空闲 stop 会立即唤醒轮询且不遗留长计时器", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-worker-idle-stop-"));
  const connection = openDatabase(dataRoot);
  try {
    const worker = new JobWorker(connection.database, {}, {
      workerId: "worker",
      leaseMs: 1_000,
      heartbeatMs: 100,
    });
    worker.start(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    const startedAt = Date.now();
    await worker.stop();
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
