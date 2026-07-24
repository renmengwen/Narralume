import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "./database.js";

test("数据库迁移可重复执行并在重启后保留书库数据", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-"));

  try {
    const first = openDatabase(dataRoot);
    first.database
      .prepare(
        `INSERT INTO books (
          id, title, original_file_path, original_file_hash, encoding, import_status
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("book_sha256", "测试书", "books/book_sha256/source.txt", "sha256", "UTF-8", "ready");
    first.database
      .prepare(
        `INSERT INTO chapters (
          id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("chapter_1", "book_sha256", 0, "第一章", 0, 12, 6, "chapter_hash");
    assert.throws(
      () =>
        first.database
          .prepare(
            `INSERT INTO chapters (
              id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("chapter_duplicate", "book_sha256", 0, "重复章", 12, 20, 4, "duplicate_hash"),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        first.database
          .prepare(
            `INSERT INTO chapters (
              id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("chapter_invalid_range", "book_sha256", 1, "无效范围", 20, 12, 4, "bad_hash"),
      /CHECK constraint failed/,
    );
    first.close();

    const reopened = openDatabase(dataRoot);
    const book = reopened.database.prepare("SELECT id, title FROM books").get();
    const migration = reopened.database
      .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get();
    reopened.database.prepare("DELETE FROM books WHERE id = ?").run("book_sha256");
    const chapterCount = reopened.database.prepare("SELECT COUNT(*) AS count FROM chapters").get();
    reopened.close();

    assert.equal(book?.id, "book_sha256");
    assert.equal(book?.title, "测试书");
    assert.equal(migration?.version, 1);
    assert.equal(chapterCount?.count, 0);
    assert.equal((await readFile(join(dataRoot, "narralume.sqlite3"))).length > 0, true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("初始化失败会关闭 SQLite 文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-invalid-"));
  const databasePath = join(dataRoot, "narralume.sqlite3");

  try {
    const malformed = new DatabaseSync(databasePath);
    malformed.exec("CREATE TABLE schema_migrations (bad_column INTEGER) STRICT");
    malformed.close();

    assert.throws(() => openDatabase(dataRoot), /no such column: version/);
    await rm(databasePath);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
