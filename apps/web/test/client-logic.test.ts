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
