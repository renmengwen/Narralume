import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";

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
