import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import { openDatabase } from "./database.js";
import { getJob } from "./job-store.js";
import { IMAGE_CANDIDATE_JOB_TYPE } from "./image-candidate-job.js";
import { writeModelConfig } from "./model-config.js";
import { changeScriptApproval } from "./script-approval-store.js";

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
    const policy = await app.inject({ method: "GET", url: "/api/episode-policy" });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, service: "narralume" });
    assert.deepEqual(policy.json(), {
      ok: true,
      duration: { minimumSeconds: 60, defaultSeconds: 1200, maximumSeconds: 3600, stepSeconds: 30 },
    });
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
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/books/${bookId}/chapters/${chapterId}`,
    });
    const afterDelete = await app.inject({ method: "GET", url: `/api/books/${bookId}/chapters` });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.json().message, "章节“第一章”已从本地索引删除");
    assert.equal(afterDelete.json().total, 0);
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

    const faithful = await app.inject({
      method: "POST",
      url: `/api/series/${seriesId}/episodes/1/scripts`,
      payload: {
        kind: "faithful",
        paragraphs: [{ text: "宝玉来到大观园。", sourceIndexes: [0] }],
      },
    });
    assert.equal(faithful.statusCode, 201);
    assert.equal(faithful.json().script.versionNumber, 1);
    const repeated = await app.inject({
      method: "POST",
      url: `/api/series/${seriesId}/episodes/1/scripts`,
      payload: {
        kind: "faithful",
        paragraphs: [{ text: "宝玉来到大观园。", sourceIndexes: [0] }],
      },
    });
    assert.equal(repeated.json().script.id, faithful.json().script.id);
    const packaged = await app.inject({
      method: "POST",
      url: `/api/series/${seriesId}/episodes/1/scripts`,
      payload: {
        kind: "packaged",
        parentVersionId: faithful.json().script.id,
        paragraphs: [{ text: "宝玉走进大观园，故事由此展开。", sourceIndexes: [0] }],
      },
    });
    assert.equal(packaged.statusCode, 201);
    assert.equal(packaged.json().script.parentVersionId, faithful.json().script.id);

    const approvalUrl = `/api/series/${seriesId}/episodes/1/approval`;
    const initialApproval = await app.inject({ method: "GET", url: approvalUrl });
    assert.equal(initialApproval.statusCode, 200);
    assert.deepEqual(initialApproval.json().approval, {
      episodeId: saved.json().episode.id,
      status: "unapproved",
      revision: 0,
      scriptVersionId: null,
      changedAt: null,
    });
    const approved = await app.inject({
      method: "PUT",
      url: approvalUrl,
      payload: { action: "approve", expectedRevision: 0, scriptVersionId: packaged.json().script.id },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().message, "包装稿已人工批准");
    assert.equal(approved.json().approval.status, "approved");
    assert.equal(approved.json().approval.revision, 1);
    const staleApproval = await app.inject({
      method: "PUT",
      url: approvalUrl,
      payload: { action: "approve", expectedRevision: 0, scriptVersionId: packaged.json().script.id },
    });
    assert.equal(staleApproval.statusCode, 409);
    assert.equal(staleApproval.json().message, "批准状态已变化，请按 revision=1 重试");

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
    const scripts = await app.inject({
      method: "GET",
      url: `/api/series/${seriesId}/episodes/1/scripts`,
    });
    assert.equal(scripts.statusCode, 200);
    assert.equal(scripts.json().items.length, 2);
    assert.equal(scripts.json().items[0].paragraphs[0].sources[0].sourceText, undefined);
    assert.equal(scripts.json().items[0].paragraphs[0].sources[0].sourceHash,
      createHash("sha256").update(evidence).digest("hex"));
    const persistedApproval = await app.inject({ method: "GET", url: approvalUrl });
    assert.equal(persistedApproval.statusCode, 200);
    assert.equal(persistedApproval.json().approval.status, "approved");
    assert.equal(persistedApproval.json().approval.scriptVersionId, packaged.json().script.id);
    const withdrawn = await app.inject({
      method: "PUT",
      url: approvalUrl,
      payload: { action: "withdraw", expectedRevision: 1 },
    });
    assert.equal(withdrawn.statusCode, 200);
    assert.equal(withdrawn.json().message, "稿件批准已撤回");
    assert.equal(withdrawn.json().approval.status, "withdrawn");
    assert.equal(withdrawn.json().approval.revision, 2);

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

test("资产 API 宽链路覆盖主状态资产、别名、幂等与中文错误", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-app-assets-"));
  const app = buildApp({ dataRoot, logger: false });
  try {
    const imported = await app.inject({
      method: "POST",
      url: "/api/books/import",
      headers: { "content-type": "text/plain" },
      payload: Buffer.from("第一章\n林黛玉初入荣国府。", "utf8"),
    });
    const bookId = imported.json().book.id as string;
    const series = await app.inject({
      method: "POST", url: `/api/books/${bookId}/series`, payload: { title: "资产 API 测试" },
    });
    const seriesId = series.json().series.id as string;
    const master = await app.inject({
      method: "POST", url: `/api/series/${seriesId}/assets`,
      payload: { type: "character", name: "林黛玉" },
    });
    assert.equal(master.statusCode, 201);
    assert.equal(master.json().message, "资产已保存");
    const assetId = master.json().asset.id as string;
    const duplicate = await app.inject({
      method: "POST", url: `/api/series/${seriesId}/assets`,
      payload: { type: "character", name: " 林黛玉 " },
    });
    assert.equal(duplicate.statusCode, 201);
    assert.equal(duplicate.json().asset.id, assetId);
    const state = await app.inject({
      method: "POST", url: `/api/series/${seriesId}/assets`,
      payload: { type: "character", name: "林黛玉·病中", parentAssetId: assetId, stateLabel: "病中" },
    });
    assert.equal(state.statusCode, 201);
    assert.equal(state.json().asset.parentAssetId, assetId);
    const aliased = await app.inject({
      method: "POST", url: `/api/assets/${assetId}/aliases`, payload: { aliases: ["黛玉", "林姑娘"] },
    });
    assert.equal(aliased.statusCode, 200);
    assert.equal(aliased.json().message, "资产别名已保存");
    const listed = await app.inject({ method: "GET", url: `/api/series/${seriesId}/assets` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items.length, 1);
    assert.equal(listed.json().items[0].states[0].id, state.json().asset.id);

    const invalid = await app.inject({
      method: "POST", url: `/api/series/${seriesId}/assets`, payload: { type: "vehicle", name: "马车" },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().message, "资产类型必须是人物、场景或道具");
    const missingSeries = await app.inject({
      method: "POST", url: "/api/series/series_missing/assets", payload: { type: "scene", name: "贾府" },
    });
    assert.equal(missingSeries.statusCode, 404);
    assert.equal(missingSeries.json().message, "系列项目不存在");
    const missingAsset = await app.inject({
      method: "POST", url: "/api/assets/asset_missing/aliases", payload: { aliases: ["未知"] },
    });
    assert.equal(missingAsset.statusCode, 404);
    assert.equal(missingAsset.json().message, "资产不存在");
    const scene = await app.inject({
      method: "POST", url: `/api/series/${seriesId}/assets`, payload: { type: "scene", name: "荣国府" },
    });
    const conflict = await app.inject({
      method: "POST", url: `/api/assets/${scene.json().asset.id}/aliases`, payload: { aliases: ["黛玉"] },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().message, "资产名称或别名已被其他资产使用");
    const illegalParent = await app.inject({
      method: "POST", url: `/api/series/${seriesId}/assets`,
      payload: {
        type: "character", name: "非法下级", parentAssetId: state.json().asset.id, stateLabel: "非法",
      },
    });
    assert.equal(illegalParent.statusCode, 409);
    assert.equal(illegalParent.json().message, "状态资产不能继续创建下级状态");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("视觉段 API 派生时间并保留显式资产选择、幂等与中文错误", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-app-visual-segments-"));
  const timelineHash = "b".repeat(64);
  const imagePath = join(dataRoot, "visual.png");
  const rendered = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=0x506070:s=32x48", "-frames:v", "1", "-y", imagePath,
  ], { windowsHide: true, encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  const image = await readFile(imagePath);
  const seed = openDatabase(dataRoot);
  try {
    seed.database.prepare(
      `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
       VALUES ('visual_book', '视觉段 API', 'source.txt', ?, 'utf-8', 'ready')`,
    ).run("1".repeat(64));
    seed.database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('visual_series', 'visual_book', '视觉段系列', 1, 1)`,
    ).run();
    seed.database.prepare(
      `INSERT INTO episodes (
        id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
      ) VALUES ('visual_episode', 'visual_series', 1, '第一集', '故事弧', 240, 1, 1)`,
    ).run();
    seed.database.prepare(
      `INSERT INTO script_versions (
        id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
      ) VALUES ('visual_script', 'visual_episode', 'packaged', 1, NULL, ?, ?, 1)`,
    ).run(JSON.stringify({ paragraphs: [{ text: "画面旁白", sourceIndexes: [0] }] }), "2".repeat(64));
    changeScriptApproval(seed.database, "visual_episode", {
      action: "approve", expectedRevision: 0, scriptVersionId: "visual_script",
    });
    seed.database.prepare(
      `INSERT INTO audio_segments (
        timeline_hash, segment_index, episode_id, script_version_id, text, provider_id, voice, rate,
        input_hash, relative_path, file_hash, bytes, duration_ms, created_at
      ) VALUES (?, 0, 'visual_episode', 'visual_script', '画面旁白', 'test', 'test', 0,
        ?, 'audio.wav', ?, 100, 2000, 1)`,
    ).run(timelineHash, "3".repeat(64), "4".repeat(64));
    const insertCue = seed.database.prepare(
      `INSERT INTO subtitle_cues (
        timeline_hash, cue_index, segment_index, episode_id, script_version_id, start_ms, end_ms, text
      ) VALUES (?, ?, 0, 'visual_episode', 'visual_script', ?, ?, ?)`,
    );
    insertCue.run(timelineHash, 0, 0, 900, "第一句");
    insertCue.run(timelineHash, 1, 900, 2000, "第二句");
    seed.database.prepare(
      `INSERT INTO assets (
        id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
      ) VALUES ('visual_asset', 'visual_series', 'character', 'master', '林黛玉', '林黛玉', 1)`,
    ).run();
  } finally {
    seed.close();
  }

  const app = buildApp({ dataRoot, logger: false });
  const imageHash = createHash("sha256").update(image).digest("hex");
  const storedImagePath = join(dataRoot, "assets", "candidates", imageHash.slice(0, 2), `${imageHash}.png`);
  let replacedAtSend = false;
  app.addHook("onSend", async (request, _reply, payload) => {
    if (request.method === "GET" && request.url.endsWith("/image")) {
      await writeFile(storedImagePath, "replacement-at-send-boundary");
      replacedAtSend = true;
    }
    return payload;
  });
  try {
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/assets/visual_asset/candidates/upload",
      headers: { "content-type": "application/octet-stream", "x-file-name": "visual.png" },
      payload: image,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const candidateId = uploaded.json().candidate.id as string;
    const approved = await app.inject({
      method: "POST",
      url: `/api/candidates/${candidateId}/reviews`,
      payload: { expectedRevision: 0, action: "approve" },
    });
    assert.equal(approved.statusCode, 201, approved.body);

    const body = {
      timelineHash,
      cueStartIndex: 0,
      cueEndIndex: 1,
      motionKind: "zoom-in",
      motionAmountPpm: 120_000,
      fadeMs: 200,
      expectedRevision: 0,
      assets: [{ assetId: "visual_asset", selectedCandidateId: candidateId }],
    };
    const saved = await app.inject({
      method: "PUT", url: "/api/episodes/visual_episode/visual-segments/0", payload: body,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().message, "视觉段已保存");
    assert.equal(saved.json().segment.startMs, 0);
    assert.equal(saved.json().segment.endMs, 2000);
    assert.equal(saved.json().segment.productionReady, true);
    assert.deepEqual(saved.json().segment.assets.map((asset: Record<string, unknown>) => ({
      assetId: asset.assetId,
      selectedCandidateId: asset.selectedCandidateId,
    })), [{ assetId: "visual_asset", selectedCandidateId: candidateId }]);

    const repeated = await app.inject({
      method: "PUT", url: "/api/episodes/visual_episode/visual-segments/0", payload: body,
    });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().segment.id, saved.json().segment.id);
    assert.equal(repeated.json().segment.revision, saved.json().segment.revision);

    const listed = await app.inject({
      method: "GET", url: `/api/episodes/visual_episode/visual-segments?timelineHash=${timelineHash}`,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.json().total, 1);
    assert.equal(listed.json().items[0].productionReady, true);
    assert.equal(listed.json().items[0].startMs, 0);
    assert.equal(listed.json().items[0].endMs, 2000);

    const exported = await app.inject({
      method: "POST", url: "/api/episodes/visual_episode/contact-sheet", payload: { timelineHash },
    });
    assert.equal(exported.statusCode, 200, exported.body);
    assert.equal(exported.json().message, "联系表已导出");
    assert.equal(exported.json().contactSheet.timelineHash, timelineHash);
    const candidateImage = await app.inject({ method: "GET", url: `/api/candidates/${candidateId}/image` });
    assert.equal(candidateImage.statusCode, 200, candidateImage.body);
    assert.equal(replacedAtSend, true);
    assert.equal(candidateImage.headers["content-type"], "image/png");
    assert.deepEqual(candidateImage.rawPayload, image);
    assert.equal((await app.inject({
      method: "POST", url: "/api/episodes/visual_episode/contact-sheet", payload: { timelineHash: "bad" },
    })).statusCode, 400);
    assert.equal((await app.inject({
      method: "POST", url: "/api/episodes/missing/contact-sheet", payload: { timelineHash },
    })).statusCode, 404);
    assert.equal((await app.inject({
      method: "GET", url: "/api/candidates/candidate_missing/image",
    })).statusCode, 404);

    const stale = await app.inject({
      method: "PUT", url: "/api/episodes/visual_episode/visual-segments/0",
      payload: { ...body, expectedRevision: 0, fadeMs: 100 },
    });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.json().message, /revision|版本|变化/);
    const invalidIndex = await app.inject({
      method: "PUT", url: "/api/episodes/visual_episode/visual-segments/-1", payload: body,
    });
    assert.equal(invalidIndex.statusCode, 400);
    assert.equal(invalidIndex.json().message, "视觉段序号必须是非负安全整数");
    const invalidHash = await app.inject({
      method: "GET", url: "/api/episodes/visual_episode/visual-segments?timelineHash=bad",
    });
    assert.equal(invalidHash.statusCode, 400);
    assert.equal(invalidHash.json().message, "时间轴哈希必须是 64 位小写十六进制");
    const missing = await app.inject({
      method: "PUT", url: "/api/episodes/missing/visual-segments/0", payload: body,
    });
    assert.equal(missing.statusCode, 404);
    assert.match(missing.json().message, /分集不存在/);
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

test("候选图 API 覆盖原始上传、列表、追加审核和生图任务门禁", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-app-candidates-"));
  const imagePath = join(dataRoot, "upload.png");
  const rendered = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "color=c=0x506070:s=32x48", "-frames:v", "1", "-y", imagePath,
  ], { windowsHide: true, encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  const image = await readFile(imagePath);

  const seed = openDatabase(dataRoot);
  try {
    seed.database.prepare(
      `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
       VALUES ('candidate_book', '候选图 API', 'source.txt', ?, 'utf-8', 'ready')`,
    ).run("1".repeat(64));
    for (const id of ["one", "two"]) {
      seed.database.prepare(
        `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
         VALUES (?, 'candidate_book', ?, 1, 1)`,
      ).run(`series_${id}`, `系列${id}`);
      seed.database.prepare(
        `INSERT INTO episodes (
          id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at
        ) VALUES (?, ?, 1, '第一集', '故事弧', 240, 1, 1)`,
      ).run(`episode_${id}`, `series_${id}`);
      seed.database.prepare(
        `INSERT INTO assets (
          id, series_project_id, asset_type, asset_role, canonical_name, normalized_name, created_at
        ) VALUES (?, ?, 'character', 'master', ?, ?, 1)`,
      ).run(`asset_${id}`, `series_${id}`, `人物${id}`, `人物${id}`);
    }
    const content = JSON.stringify({ paragraphs: [{ text: "批准包装稿", sourceIndexes: [0] }] });
    seed.database.prepare(
      `INSERT INTO script_versions (
        id, episode_id, kind, version, parent_version_id, content_json, content_hash, created_at
      ) VALUES ('candidate_script', 'episode_one', 'packaged', 1, NULL, ?, ?, 1)`,
    ).run(content, createHash("sha256").update(content).digest("hex"));
    changeScriptApproval(seed.database, "episode_one", {
      action: "approve", expectedRevision: 0, scriptVersionId: "candidate_script",
    });
  } finally {
    seed.close();
  }

  await writeModelConfig(dataRoot, {
    providers: {
      "test-provider": {
        name: "测试图片供应商",
        kind: "openai-compatible",
        protocol: "openai-response",
        baseUrl: "https://images.example/v1",
        apiKey: "test-only",
        models: { image: { enabled: true, modelId: "test-image" } },
      },
    },
    active: { image: "test-provider/image" },
  });
  let app = buildApp({
    dataRoot,
    logger: false,
    jobPollMs: 60_000,
    jobHandlers: { [IMAGE_CANDIDATE_JOB_TYPE]: async () => ({ accepted: true }) },
  });
  try {
    const wrongType = await app.inject({
      method: "POST", url: "/api/assets/asset_one/candidates/upload",
      headers: { "content-type": "image/png", "x-file-name": "人物.png" }, payload: image,
    });
    assert.equal(wrongType.statusCode, 415);
    const missingAsset = await app.inject({
      method: "POST", url: "/api/assets/asset_missing/candidates/upload",
      headers: { "content-type": "application/octet-stream", "x-file-name": "人物.png" }, payload: image,
    });
    assert.equal(missingAsset.statusCode, 404);
    const invalidImage = await app.inject({
      method: "POST", url: "/api/assets/asset_one/candidates/upload",
      headers: { "content-type": "application/octet-stream", "x-file-name": "坏图.png" }, payload: Buffer.from("not image"),
    });
    assert.equal(invalidImage.statusCode, 400);
    const uploaded = await app.inject({
      method: "POST", url: "/api/assets/asset_one/candidates/upload",
      headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("人物.png") }, payload: image,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const candidateId = uploaded.json().candidate.id as string;
    const listed = await app.inject({ method: "GET", url: "/api/assets/asset_one/candidates" });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().total, 1);
    assert.equal((await app.inject({ method: "GET", url: "/api/assets/asset_missing/candidates" })).statusCode, 404);

    const invalidReview = await app.inject({
      method: "POST", url: `/api/candidates/${candidateId}/reviews`, payload: { expectedRevision: -1, action: "approve" },
    });
    assert.equal(invalidReview.statusCode, 400);
    assert.equal((await app.inject({
      method: "POST", url: "/api/candidates/candidate_missing/reviews", payload: { expectedRevision: 0, action: "approve" },
    })).statusCode, 404);
    assert.equal((await app.inject({
      method: "POST", url: `/api/candidates/${candidateId}/reviews`, payload: { expectedRevision: 0, action: "approve" },
    })).statusCode, 201);
    const reviewHistory = await app.inject({ method: "GET", url: `/api/candidates/${candidateId}/reviews` });
    assert.equal(reviewHistory.statusCode, 200);
    assert.deepEqual(reviewHistory.json().items.map((item: { action: string }) => item.action), ["approve"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/candidates/candidate_missing/reviews" })).statusCode, 404);
    assert.equal((await app.inject({
      method: "POST", url: `/api/candidates/${candidateId}/reviews`,
      payload: { expectedRevision: 1, action: "note", note: "批准后补充构图说明" },
    })).statusCode, 201);
    const afterNote = await app.inject({ method: "GET", url: "/api/assets/asset_one/candidates" });
    assert.equal(afterNote.json().items[0].reviewStatus, "approved");
    assert.equal(afterNote.json().items[0].reviewRevision, 2);
    assert.equal((await app.inject({
      method: "POST", url: `/api/candidates/${candidateId}/reviews`, payload: { expectedRevision: 0, action: "reject" },
    })).statusCode, 409);

    const invalidJob = await app.inject({
      method: "POST", url: "/api/jobs", payload: { type: IMAGE_CANDIDATE_JOB_TYPE, payload: {} },
    });
    assert.equal(invalidJob.statusCode, 400);
    const unapproved = await app.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: IMAGE_CANDIDATE_JOB_TYPE, payload: { episodeId: "episode_two", assetId: "asset_two", prompt: "人物" } },
    });
    assert.equal(unapproved.statusCode, 409);
    const crossSeries = await app.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: IMAGE_CANDIDATE_JOB_TYPE, payload: { episodeId: "episode_one", assetId: "asset_two", prompt: "人物" } },
    });
    assert.equal(crossSeries.statusCode, 409);
    const accepted = await app.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: IMAGE_CANDIDATE_JOB_TYPE, payload: { episodeId: "episode_one", assetId: "asset_one", prompt: "竖屏人物" } },
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
    const repeated = await app.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: IMAGE_CANDIDATE_JOB_TYPE, payload: { episodeId: "episode_one", assetId: "asset_one", prompt: "竖屏人物" } },
    });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().job.id, accepted.json().job.id);
    const derived = await app.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: IMAGE_CANDIDATE_JOB_TYPE, payload: {
        episodeId: "episode_one", assetId: "asset_one", prompt: "竖屏人物", derivedFromCandidateId: candidateId,
      } },
    });
    assert.equal(derived.statusCode, 201, derived.body);
    assert.notEqual(derived.json().job.id, accepted.json().job.id);
    assert.equal(derived.json().job.payload.derivedFromCandidateId, candidateId);
    const missingParent = await app.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: IMAGE_CANDIDATE_JOB_TYPE, payload: {
        episodeId: "episode_one", assetId: "asset_one", prompt: "派生", derivedFromCandidateId: "candidate_missing",
      } },
    });
    assert.equal(missingParent.statusCode, 404);

    await app.close();
    app = buildApp({ dataRoot, logger: false, imageProvider: null });
    const unconfigured = await app.inject({
      method: "POST", url: "/api/jobs",
      payload: { type: IMAGE_CANDIDATE_JOB_TYPE, payload: { episodeId: "episode_one", assetId: "asset_one", prompt: "竖屏人物" } },
    });
    assert.equal(unconfigured.statusCode, 409);
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
