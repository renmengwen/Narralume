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
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
