import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { buildApp } from "./app.js";
import { openDatabase } from "./database.js";
import {
  createEpisodeScriptGenerationJobHandler,
  enqueueEpisodeScriptGenerationJob,
  EPISODE_SCRIPT_GENERATION_JOB_TYPE,
  type GenerateEpisodeScript,
} from "./episode-script-generation-job.js";
import { createOpenAiEpisodeScriptGenerator } from "./episode-script-provider.js";
import { getJob, requestJobCancellation } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import { writeModelConfig } from "./model-config.js";
import { getScriptApproval, requireApprovedScriptForProduction } from "./script-approval-store.js";
import { listScriptVersions } from "./script-version-store.js";

const config: ChapterTextModelConfig = {
  baseUrl: "https://example.invalid/v1",
  apiKey: "test",
  model: "test-model",
  providerId: "test-provider",
};

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-script-job-"));
  const connection = openDatabase(dataRoot);
  const database = connection.database;
  const texts = ["第一段原文", "第二段原文", "第三段原文"];
  const bytes = texts.map((value) => Buffer.from(value));
  const source = Buffer.concat(bytes);
  await mkdir(join(dataRoot, "books", "book"), { recursive: true });
  await writeFile(join(dataRoot, "books", "book", "source.txt"), source);
  database.prepare(
    `INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
     VALUES ('book','书','books/book/source.txt',?,'UTF-8','ready')`,
  ).run(createHash("sha256").update(source).digest("hex"));
  database.prepare(
    "INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)",
  ).run();
  database.prepare(
    `INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,recap,next_hook,created_at,updated_at)
     VALUES ('episode','series',1,'第一集','进入墓道',120,'上集回顾','发现机关',1,1)`,
  ).run();
  let offset = 0;
  for (const [index, value] of bytes.entries()) {
    const end = offset + value.length;
    database.prepare(
      `INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(`chapter_${index}`, "book", index, `第${index + 1}章`, offset, end, texts[index]!.length,
      createHash("sha256").update(value).digest("hex"));
    database.prepare(
      `INSERT INTO chapter_events (id,chapter_id,event_index,occurrence,event_type,payload_json,created_at)
       VALUES (?,?,0,0,'revelation',?,1)`,
    ).run(`event_${index}`, `chapter_${index}`, JSON.stringify({ fact: `事实${index}` }));
    database.prepare(
      `INSERT INTO episode_sources (
         episode_id,source_index,chapter_id,source_event_id,source_byte_start,source_byte_end,source_hash
       ) VALUES ('episode',?,?,?,?,?,?)`,
    ).run(index, `chapter_${index}`, `event_${index}`, offset, end,
      createHash("sha256").update(value).digest("hex"));
    offset = end;
  }
  return { dataRoot, connection, database, texts };
}

const request = {
  seriesId: "series",
  episodeIndex: 1,
  voice: "说书音色",
  rate: 0,
  charactersPerSecond: 4.5,
  narrationOccupancy: 0.8,
  calibration: { identity: "provisional" as const },
};

test("Responses 三阶段请求不发送不兼容的 json_object format", async () => {
  const outputs = [
    { beats: [{ intent: "进入墓道", sourceIndexes: [0] }] },
    { text: "忠实稿" },
    { paragraphs: [{ text: "包装稿", sourceIndexes: [0] }] },
  ];
  let calls = 0;
  const generate = createOpenAiEpisodeScriptGenerator(config, (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string; text?: unknown };
    assert.match(body.input, /JSON/u);
    assert.equal(body.text, undefined);
    return new Response(JSON.stringify({ output_text: JSON.stringify(outputs[calls++]!) }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
  const signal = new AbortController().signal;
  await generate({
    stage: "skeleton", episode: { id: "episode", storyArc: "进入墓道", recap: null, nextHook: null, targetDurationSeconds: 120 },
    characterBudget: 400, calibration: { identity: "provisional" }, sources: [], signal,
  });
  await generate({ stage: "faithful", beat: { intent: "进入墓道", sourceIndexes: [0] }, characterBudget: 200,
    sources: [{ sourceIndex: 0, sourceText: "原文" }], signal });
  await generate({ stage: "packaged", targetDurationSeconds: 120, characterBudget: 400,
    paragraphs: [{ text: "忠实稿", sourceIndexes: [0] }], signal });
  assert.equal(calls, 3);
});

test("Anthropic Messages 配置使用 messages 端点与对应鉴权合同", async () => {
  const anthropic = { ...config, protocol: "anthropic-message" as const };
  let requestedUrl = "";
  let requestedHeaders = new Headers();
  let requestedBody: Record<string, unknown> = {};
  const generate = createOpenAiEpisodeScriptGenerator(anthropic, (async (url, init) => {
    requestedUrl = String(url);
    requestedHeaders = new Headers(init?.headers);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ content: [{ type: "text", text: JSON.stringify({ beats: [{ intent: "进入墓道", sourceIndexes: [0] }] }) }] });
  }) as typeof fetch);

  await generate({
    stage: "skeleton",
    episode: { id: "episode", storyArc: "进入墓道", recap: null, nextHook: null, targetDurationSeconds: 120 },
    characterBudget: 400,
    calibration: { identity: "provisional" },
    sources: [],
    signal: new AbortController().signal,
  });

  assert.equal(requestedUrl, "https://example.invalid/v1/messages");
  assert.equal(requestedHeaders.get("x-api-key"), "test");
  assert.equal(requestedHeaders.get("anthropic-version"), "2023-06-01");
  assert.equal(requestedHeaders.get("authorization"), null);
  assert.equal(requestedBody.model, "test-model");
  assert.equal(requestedBody.max_tokens, 8192);
  assert.equal(Array.isArray(requestedBody.messages), true);
  assert.equal(requestedBody.input, undefined);
});

async function run(
  context: Awaited<ReturnType<typeof fixture>>,
  generate: GenerateEpisodeScript,
  maxAttempts = 1,
) {
  const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
    payload: request,
    maxAttempts,
  });
  const worker = new JobWorker(context.database, {
    [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
      context.database,
      context.dataRoot,
      config,
      generate,
    ),
  }, { workerId: "script-test", leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
  await worker.runOne();
  return { queued, worker, job: getJob(context.database, queued.job.id)! };
}

function successfulGenerator(observe?: (input: Parameters<GenerateEpisodeScript>[0]) => void): GenerateEpisodeScript {
  return async (input) => {
    observe?.(input);
    if (input.stage === "skeleton") return { beats: [
      { intent: "进入", sourceIndexes: [0, 1], targetDurationSeconds: 80 },
      { intent: "揭示", sourceIndexes: [2], targetDurationSeconds: 40 },
    ] };
    if (input.stage === "faithful") return { text: input.sources.map((source) => source.sourceText).join("；") };
    return { paragraphs: input.paragraphs.map((paragraph) => ({
      text: `包装：${paragraph.text}`,
      sourceIndexes: paragraph.sourceIndexes,
    })) };
  };
}

test("长稿 Job 骨架不接收原文，faithful 按 beat 隔离原文并写入冻结父链", async () => {
  const context = await fixture();
  const calls: Parameters<GenerateEpisodeScript>[0][] = [];
  try {
    const result = await run(context, successfulGenerator((input) => calls.push(input)));
    assert.equal(result.job.status, "succeeded");
    const skeleton = calls.find((input) => input.stage === "skeleton")!;
    const serialized = JSON.stringify(skeleton);
    for (const forbidden of ["sourceText", "byteStart", "byteEnd", ...context.texts]) {
      assert.equal(serialized.includes(forbidden), false, `骨架输入不得包含 ${forbidden}`);
    }
    const faithfulCalls = calls.filter((input) => input.stage === "faithful");
    assert.deepEqual(faithfulCalls.map((input) => input.stage === "faithful"
      ? input.sources.map((source) => source.sourceText)
      : []), [[context.texts[0], context.texts[1]], [context.texts[2]]]);

    const versions = listScriptVersions(context.database, "episode");
    assert.equal(versions.length, 2);
    assert.equal(versions[0]!.kind, "faithful");
    assert.equal(versions[1]!.kind, "packaged");
    assert.equal(versions[1]!.parentVersionId, versions[0]!.id);
    assert.deepEqual(versions[1]!.paragraphs.map((paragraph) =>
      paragraph.sources.map((source) => source.episodeSourceIndex)), [[0, 1], [2]]);
    assert.deepEqual(getScriptApproval(context.database, "episode"), {
      episodeId: "episode", status: "unapproved", revision: 0,
      scriptVersionId: null, changedAt: null,
    });
    assert.throws(() => requireApprovedScriptForProduction(context.database, "episode", "tts"), /未人工批准/);
    const payload = result.job.payload as Record<string, unknown>;
    assert.equal(payload.targetDurationSeconds, 120);
    assert.equal(payload.voice, request.voice);
    assert.deepEqual(payload.calibration, request.calibration);
    const jobResult = result.job.result as {
      characterBudget: number;
      scriptHandoff: { summary: string; continuityNotes: string[] };
    };
    assert.equal(jobResult.characterBudget, 432);
    assert.deepEqual(jobResult.scriptHandoff, {
      summary: "进入墓道",
      continuityNotes: ["发现机关", "进入", "揭示"],
    });
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("骨架拒绝空、重复、越界、伪造及乱序来源", async (t) => {
  const cases: Array<[string, unknown]> = [
    ["空", []],
    ["beat 内重复", [{ intent: "坏", sourceIndexes: [0, 0] }]],
    ["跨 beat 重复", [{ intent: "一", sourceIndexes: [0] }, { intent: "二", sourceIndexes: [0] }]],
    ["越界", [{ intent: "坏", sourceIndexes: [3] }]],
    ["伪造", [{ intent: "坏", sourceIndexes: [999] }]],
    ["乱序", [{ intent: "坏", sourceIndexes: [1, 0] }]],
  ];
  for (const [name, beats] of cases) await t.test(name, async () => {
    const context = await fixture();
    try {
      const result = await run(context, async (input) => input.stage === "skeleton"
        ? { beats: beats as never[] }
        : input.stage === "faithful" ? { text: "不会执行" } : { paragraphs: [] });
      assert.equal(result.job.status, "failed");
      assert.equal(listScriptVersions(context.database, "episode").length, 0);
    } finally {
      context.connection.close();
      await rm(context.dataRoot, { recursive: true, force: true });
    }
  });
});

test("任务在开始、faithful 写入前和 packaged 写入前都拒绝 Episode 漂移", async (t) => {
  for (const point of ["start", "faithful", "packaged"] as const) await t.test(point, async () => {
    const context = await fixture();
    try {
      const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
        payload: request,
        maxAttempts: 1,
      });
      if (point === "start") context.database.prepare("UPDATE episodes SET story_arc = '已漂移' WHERE id = 'episode'").run();
      let changed = false;
      const generate = successfulGenerator((input) => {
        if (!changed && ((point === "faithful" && input.stage === "faithful") ||
            (point === "packaged" && input.stage === "packaged"))) {
          context.database.prepare("UPDATE episodes SET target_duration_seconds = 121 WHERE id = 'episode'").run();
          changed = true;
        }
      });
      const worker = new JobWorker(context.database, {
        [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
          context.database, context.dataRoot, config, generate,
        ),
      }, { workerId: `drift-${point}`, leaseMs: 10_000, heartbeatMs: 1_000, retryDelayMs: 0 });
      await worker.runOne();
      const job = getJob(context.database, queued.job.id)!;
      assert.equal(job.status, "failed");
      assert.match(job.errorMessage ?? "", /排队后已变化/);
      assert.equal(listScriptVersions(context.database, "episode").length, 0);
    } finally {
      context.connection.close();
      await rm(context.dataRoot, { recursive: true, force: true });
    }
  });
});

test("首次失败后重试 faithful 文本变化也只落成功的一组版本", async () => {
  const context = await fixture();
  let packagedAttempts = 0;
  let faithfulAttempts = 0;
  try {
    const generate: GenerateEpisodeScript = async (input) => {
      if (input.stage === "skeleton") return { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] };
      if (input.stage === "faithful") {
        faithfulAttempts += 1;
        return { text: `${faithfulAttempts === 1 ? "失败批次" : "成功批次"}：${input.sources.map((source) => source.sourceText).join("；")}` };
      }
      packagedAttempts += 1;
      if (packagedAttempts === 1) throw new Error("模拟 packaged 暂时失败");
      return { paragraphs: [{ text: "重试后的包装稿", sourceIndexes: [0, 1, 2] }] };
    };
    const first = await run(context, generate, 2);
    assert.equal(first.job.status, "queued");
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
    await first.worker.runOne();
    const completed = getJob(context.database, first.queued.job.id)!;
    assert.equal(completed.status, "succeeded");
    assert.equal(listScriptVersions(context.database, "episode", "faithful").length, 1);
    assert.equal(listScriptVersions(context.database, "episode", "packaged").length, 1);
    assert.match(listScriptVersions(context.database, "episode", "faithful")[0]!.paragraphs[0]!.text, /成功批次/);
    const resumed = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, { payload: request });
    assert.equal(resumed.created, false);
    assert.equal(resumed.job.id, first.queued.job.id);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("包装稿拒绝忠实父稿冻结集合之外的来源", async () => {
  const context = await fixture();
  try {
    const result = await run(context, async (input) => {
      if (input.stage === "skeleton") return { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] };
      if (input.stage === "faithful") return { text: "忠实稿" };
      return { paragraphs: [{ text: "越界包装稿", sourceIndexes: [3] }] };
    });
    assert.equal(result.job.status, "failed");
    assert.match(result.job.errorMessage ?? "", /忠实父稿之外/);
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("HTTP 入口持久化同一 Job，并由现有 Worker 完成后可查询恢复", async () => {
  const context = await fixture();
  context.connection.close();
  await writeModelConfig(context.dataRoot, {
    providers: {
      [config.providerId]: {
        name: "测试文本供应商",
        kind: "openai-compatible",
        protocol: "openai-response",
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        models: { text: { enabled: true, modelId: config.model } },
      },
    },
    active: { text: `${config.providerId}/text` },
  });
  const app = buildApp({
    dataRoot: context.dataRoot,
    logger: false,
    jobPollMs: 5,
    episodeScriptGenerator: successfulGenerator(),
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { type: EPISODE_SCRIPT_GENERATION_JOB_TYPE, payload: request },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().message, "跨章骨架与长稿任务已创建并持久化");
    const jobId = created.json().job.id as string;
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { type: EPISODE_SCRIPT_GENERATION_JOB_TYPE, payload: request },
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().job.id, jobId);
    const deadline = Date.now() + 2_000;
    let restored;
    do {
      restored = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
      if (restored.json().job.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(restored.json().job.status, "succeeded");
    assert.equal(restored.json().job.result.episodeId, "episode");
  } finally {
    await app.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("运行中的长稿模型调用响应持久取消且不写入稿件", async () => {
  const context = await fixture();
  try {
    const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
      payload: request,
      maxAttempts: 1,
    });
    const generate: GenerateEpisodeScript = (input) => new Promise((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
    });
    const worker = new JobWorker(context.database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        context.database, context.dataRoot, config, generate,
      ),
    }, { workerId: "cancel-script", leaseMs: 10_000, heartbeatMs: 1_000 });
    const running = worker.runOne();
    while (getJob(context.database, queued.job.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    requestJobCancellation(context.database, queued.job.id);
    await running;
    assert.equal(getJob(context.database, queued.job.id)?.status, "cancelled");
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("packaged 生成期间取消不会提前写入 faithful", async () => {
  const context = await fixture();
  let packagedStarted!: () => void;
  const started = new Promise<void>((resolve) => { packagedStarted = resolve; });
  try {
    const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
      payload: request, maxAttempts: 1,
    });
    const generate: GenerateEpisodeScript = async (input) => {
      if (input.stage === "skeleton") return { beats: [{ intent: "完整", sourceIndexes: [0, 1, 2] }] };
      if (input.stage === "faithful") return { text: "内存忠实稿" };
      packagedStarted();
      return new Promise((_resolve, reject) => input.signal.addEventListener(
        "abort", () => reject(input.signal.reason), { once: true },
      ));
    };
    const worker = new JobWorker(context.database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        context.database, context.dataRoot, config, generate,
      ),
    }, { workerId: "cancel-packaged", leaseMs: 10_000, heartbeatMs: 1_000 });
    const running = worker.runOne();
    await started;
    requestJobCancellation(context.database, queued.job.id);
    await running;
    assert.equal(getJob(context.database, queued.job.id)?.status, "cancelled");
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("排队后事件同 ID 的 type 或 payload 漂移会在模型调用前失败", async () => {
  const context = await fixture();
  let called = false;
  try {
    const queued = await enqueueEpisodeScriptGenerationJob(context.database, context.dataRoot, config, {
      payload: request, maxAttempts: 1,
    });
    context.database.prepare("UPDATE chapter_events SET payload_json = ? WHERE id = 'event_0'")
      .run(JSON.stringify({ fact: "已漂移事实" }));
    const worker = new JobWorker(context.database, {
      [EPISODE_SCRIPT_GENERATION_JOB_TYPE]: createEpisodeScriptGenerationJobHandler(
        context.database, context.dataRoot, config, async () => {
          called = true;
          return { beats: [] };
        },
      ),
    }, { workerId: "event-drift", leaseMs: 10_000, heartbeatMs: 1_000 });
    await worker.runOne();
    const job = getJob(context.database, queued.job.id)!;
    assert.equal(job.status, "failed");
    assert.equal(called, false);
    assert.match(job.errorMessage ?? "", /事件摘要|排队后已变化/);
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("模型完成后事件摘要漂移会在原子落稿事务内复核并保持零稿件", async () => {
  const context = await fixture();
  let changed = false;
  try {
    const result = await run(context, successfulGenerator((input) => {
      if (!changed && input.stage === "packaged") {
        context.database.prepare("UPDATE chapter_events SET event_type = 'suspense' WHERE id = 'event_0'").run();
        changed = true;
      }
    }));
    assert.equal(result.job.status, "failed");
    assert.match(result.job.errorMessage ?? "", /事件摘要|排队后已变化/);
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("原子落稿第二次写入失败会回滚 faithful 与来源快照", async () => {
  const context = await fixture();
  try {
    context.database.exec(`CREATE TEMP TRIGGER fail_packaged BEFORE INSERT ON script_versions
      WHEN NEW.kind = 'packaged' BEGIN SELECT RAISE(ABORT, 'injected packaged failure'); END`);
    const result = await run(context, successfulGenerator());
    assert.equal(result.job.status, "failed");
    assert.match(result.job.errorMessage ?? "", /injected packaged failure/);
    assert.equal(listScriptVersions(context.database, "episode").length, 0);
    assert.equal(context.database.prepare("SELECT COUNT(*) AS count FROM script_version_sources").get()?.count, 0);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});
