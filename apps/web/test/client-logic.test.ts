import assert from "node:assert/strict";
import test from "node:test";

import {
  chapterPagePath,
  resolveTheme,
  resolveThemePreference,
  responseJson,
  seriesWorkspaceFromSearch,
  seriesWorkspacePath,
} from "../src/client-logic.ts";
import {
  assembleImagePrompt,
  isTerminalJobStatus,
  mergeProductionWorkspaceLocation,
  normalizeJobProgress,
  productionWorkspaceFromSearch,
  productionWorkspacePath,
  resolveProductionStage,
} from "../src/production-logic.ts";
import { chapterEventDraft, chapterEventsJobPayload, remainingChapterEventPageOffsets } from "../src/production/chapter-event-editor.ts";

test("保存的主题优先于系统偏好", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("无有效保存值时遵循系统主题", () => {
  assert.equal(resolveThemePreference(null), "system");
  assert.equal(resolveThemePreference("unexpected"), "system");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
});

test("章节分页从已加载数量继续请求", () => {
  assert.equal(chapterPagePath("book_123", 100), "/api/books/book_123/chapters?limit=100&offset=100");
});

test("系列工作台地址可刷新恢复且安全编码", () => {
  const path = seriesWorkspacePath("book/北派", "series?1");
  assert.equal(path, "?book=book%2F%E5%8C%97%E6%B4%BE&series=series%3F1");
  assert.deepEqual(seriesWorkspaceFromSearch(path), { bookId: "book/北派", seriesId: "series?1" });
  assert.equal(seriesWorkspaceFromSearch("?book=book_only"), undefined);
});

test("生产工作台恢复阶段、章节和任务且拒绝坏阶段", () => {
  const path = productionWorkspacePath({
    bookId: "book/北派",
    seriesId: "series?1",
    stage: "scripts",
    chapterId: "chapter 2",
    episodeIndex: 1,
    assetId: "asset_1",
    jobId: "job_1",
  });
  assert.deepEqual(productionWorkspaceFromSearch(path), {
    bookId: "book/北派",
    seriesId: "series?1",
    stage: "scripts",
    chapterId: "chapter 2",
    episodeIndex: 1,
    assetId: "asset_1",
    jobId: "job_1",
  });
  assert.equal(resolveProductionStage("unknown"), "events");
});

test("生产工作台地址更新可显式清除旧任务且保留未修改字段", () => {
  const current = { stage: "assets" as const, chapterId: "chapter_1", episodeIndex: 1, assetId: "asset_1", jobId: "job_1" };
  assert.deepEqual(mergeProductionWorkspaceLocation(current, { jobId: undefined }), {
    stage: "assets",
    chapterId: "chapter_1",
    episodeIndex: 1,
    assetId: "asset_1",
    jobId: undefined,
  });
  assert.deepEqual(mergeProductionWorkspaceLocation(current, { stage: "audio" }), {
    stage: "audio",
    chapterId: "chapter_1",
    episodeIndex: 1,
    assetId: "asset_1",
    jobId: "job_1",
  });
});

test("生图提示词按事实、资产、画幅和风格分段组装", () => {
  const prompt = assembleImagePrompt({
    evidence: "主角第一次进入墓道，墙面潮湿。",
    sceneIntent: "建立未知危险",
    assetName: "主角",
    assetState: "下墓装束",
    subjectAction: "举着手电缓慢前行",
    environment: "狭窄砖砌墓道",
    lightingComposition: "单侧冷光，中近景",
    styleConstraints: "写实悬疑，不出现现代品牌",
  });
  assert.match(prompt, /原文与批准稿事实/);
  assert.match(prompt, /主角（下墓装束）/);
  assert.match(prompt, /9:16 竖幅短视频构图/);
  assert.doesNotMatch(prompt, /undefined|null/);
});

test("人工章节事件沿用现有持久任务合同并限制证据范围", () => {
  const chapter = { id: "chapter_1", title: "第一章", chapter_index: 0, char_count: 20, byte_start: 100, byte_end: 200 };
  const events = [
    { type: "character" as const, primary: "吴邪", secondary: "第一次下墓", payload: { name: "吴邪", detail: "第一次下墓" } },
    { type: "location" as const, primary: "血尸墓", secondary: "主墓室", payload: { name: "血尸墓", detail: "主墓室" } },
    { type: "prop" as const, primary: "帛书", secondary: "藏有地图", payload: { name: "帛书", detail: "藏有地图" } },
    { type: "causality" as const, primary: "发现血土", secondary: "决定下墓", payload: { cause: "发现血土", effect: "决定下墓" } },
    { type: "revelation" as const, primary: "墓主人身份曝光", secondary: "", payload: { fact: "墓主人身份曝光" } },
    { type: "suspense" as const, primary: "血尸是什么？", secondary: "", payload: { question: "血尸是什么？" } },
  ];
  const payload = chapterEventsJobPayload("book_1", chapter, events.map((event, index) => ({
    key: `draft_${index}`,
    type: event.type,
    primary: event.primary,
    secondary: event.secondary,
    sources: [{ byteStart: 110 + index, byteEnd: 150 + index }],
  })));
  assert.deepEqual(payload, { bookId: "book_1", chapters: [{ chapterId: "chapter_1", events: events.map((event, index) => ({
    type: event.type,
    occurrence: 0,
    payload: event.payload,
    sources: [{ byteStart: 110 + index, byteEnd: 150 + index }],
  })) }] });
  assert.deepEqual(chapterEventsJobPayload("book_1", chapter, []), {
    bookId: "book_1", chapters: [{ chapterId: "chapter_1", events: [] }],
  });
  assert.deepEqual(chapterEventDraft({
    id: "event_1", type: "causality", occurrence: 0,
    payload: { cause: "发现血土", effect: "决定下墓" },
    sources: [{ byteStart: 110, byteEnd: 150, sourceText: "血土" }],
  }), {
    key: "event_1", type: "causality", primary: "发现血土", secondary: "决定下墓",
    sources: [{ byteStart: 110, byteEnd: 150 }],
  });
  assert.throws(() => chapterEventsJobPayload("book_1", chapter, [{
    key: "draft_2", type: "suspense", primary: "血尸是什么？", secondary: "", sources: [{ byteStart: 90, byteEnd: 120 }],
  }]), /证据范围/);
  assert.deepEqual(remainingChapterEventPageOffsets(200, 100), [100]);
  assert.deepEqual(remainingChapterEventPageOffsets(100, 100), []);
});

test("任务进度按服务端小数钳制且终态稳定", () => {
  assert.equal(normalizeJobProgress("running", 0.555), 56);
  assert.equal(normalizeJobProgress("running", 4), 100);
  assert.equal(normalizeJobProgress("succeeded", 0), 100);
  assert.equal(isTerminalJobStatus("cancelled"), true);
  assert.equal(isTerminalJobStatus("queued"), false);
});

test("非 2xx JSON 响应保留服务端中文错误", async () => {
  const response = Response.json({ message: "书籍不存在" }, { status: 404 });
  await assert.rejects(responseJson(response), /书籍不存在/);
});

test("非 JSON 错误提供稳定的中文 HTTP 状态", async () => {
  const response = new Response("Bad Gateway", { status: 502 });
  await assert.rejects(responseJson(response), /请求失败（HTTP 502）/);
});

test("成功响应必须是 JSON", async () => {
  const response = new Response("ok", { status: 200 });
  await assert.rejects(responseJson(response), /服务端未返回 JSON 数据/);
});
