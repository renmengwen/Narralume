import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { BookLibraryError, deleteChapter, readChapterText } from "./book-library.js";
import { openDatabase } from "./database.js";

test("原文读取覆盖 GB18030 非零切片、短读关闭、严格解码与路径边界", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-library-"));
  const connection = openDatabase(dataRoot);

  function insertBook(id: string, relativePath: string, encoding: string) {
    connection.database.prepare(
      `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
       VALUES (?, ?, ?, ?, ?, 'ready')`,
    ).run(id, id, relativePath, `hash_${id}`, encoding);
  }

  function insertChapter(id: string, bookId: string, byteStart: number, byteEnd: number) {
    connection.database.prepare(
      `INSERT INTO chapters (
         id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
       ) VALUES (?, ?, 0, '第一章', ?, ?, 0, ?)`,
    ).run(id, bookId, byteStart, byteEnd, `hash_${id}`);
  }

  try {
    const prefix = Buffer.from("ignored\n", "ascii");
    const gb18030Chapter = Buffer.from([
      0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a,
      0xd5, 0xfd, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd,
    ]);
    const gbPath = join(dataRoot, "books", "gb", "source.txt");
    await mkdir(dirname(gbPath), { recursive: true });
    await writeFile(gbPath, Buffer.concat([prefix, gb18030Chapter]));
    insertBook("book_gb", "books/gb/source.txt", "GB18030");
    insertChapter("chapter_gb", "book_gb", prefix.length, prefix.length + gb18030Chapter.length);

    assert.equal(
      await readChapterText(connection.database, dataRoot, "book_gb", "chapter_gb"),
      "第一章\n正文内容",
    );

    await writeFile(gbPath, prefix);
    await assert.rejects(
      readChapterText(connection.database, dataRoot, "book_gb", "chapter_gb"),
      (error: unknown) => error instanceof BookLibraryError && error.message === "原文文件不完整",
    );
    const renamedGbPath = `${gbPath}.closed`;
    await rename(gbPath, renamedGbPath);

    const invalidPath = join(dataRoot, "books", "invalid", "source.txt");
    await mkdir(dirname(invalidPath), { recursive: true });
    await writeFile(invalidPath, Buffer.from([0x81]));
    insertBook("book_invalid", "books/invalid/source.txt", "UTF-8");
    insertChapter("chapter_invalid", "book_invalid", 0, 1);
    await assert.rejects(
      readChapterText(connection.database, dataRoot, "book_invalid", "chapter_invalid"),
      (error: unknown) => error instanceof BookLibraryError && error.message === "原文编码无效",
    );
    await rename(invalidPath, `${invalidPath}.closed`);

    insertBook("book_escape", "../outside.txt", "UTF-8");
    insertChapter("chapter_escape", "book_escape", 0, 1);
    await assert.rejects(
      readChapterText(connection.database, dataRoot, "book_escape", "chapter_escape"),
      (error: unknown) => error instanceof BookLibraryError && error.message === "原文路径无效",
    );
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("删除章节清理事件和分析任务、保留原文索引身份，并拒绝破坏分集证据", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-library-delete-"));
  const connection = openDatabase(dataRoot);
  const database = connection.database;
  try {
    database.prepare(
      `INSERT INTO books (id, title, original_file_path, original_file_hash, encoding, import_status)
       VALUES ('book', '书', 'books/book/source.txt', 'hash', 'UTF-8', 'ready')`,
    ).run();
    const insertChapter = database.prepare(
      `INSERT INTO chapters (id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash)
       VALUES (?, 'book', ?, ?, ?, ?, 1, ?)`,
    );
    insertChapter.run("chapter_0", 0, "正文", 0, 1, "hash_0");
    insertChapter.run("chapter_1", 1, "第一章", 1, 2, "hash_1");
    database.prepare(
      `INSERT INTO chapter_events (id, chapter_id, event_index, occurrence, event_type, payload_json, created_at)
       VALUES ('event_0', 'chapter_0', 0, 0, 'character', '{}', 1)`,
    ).run();
    database.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, run_after, created_at, updated_at)
       VALUES ('job_0', 'chapter_events_analyze', ?, 'succeeded', 1, 1, 1)`,
    ).run(JSON.stringify({ bookId: "book", chapterId: "chapter_0" }));
    database.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, result_json, run_after, created_at, updated_at)
       VALUES ('job_recommend', 'episode_sources_recommend', ?, 'succeeded', ?, 1, 1, 1)`,
    ).run(
      JSON.stringify({ bookId: "book", startChapterId: "chapter_0" }),
      JSON.stringify({ chapterIds: ["chapter_0"], eventIds: ["event_0"] }),
    );
    database.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, run_after, created_at, updated_at)
       VALUES ('job_active', 'episode_sources_recommend', ?, 'queued', 1, 1, 1)`,
    ).run(JSON.stringify({ startChapterId: "chapter_0" }));

    assert.throws(
      () => deleteChapter(database, "book", "chapter_0"),
      (error: unknown) => error instanceof BookLibraryError && error.statusCode === 409,
    );
    database.prepare("DELETE FROM jobs WHERE id = 'job_active'").run();
    assert.deepEqual(deleteChapter(database, "book", "chapter_0"), { id: "chapter_0", title: "正文" });
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM chapter_events WHERE id = 'event_0'").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = 'job_0'").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE id = 'job_recommend'").get()?.count, 0);
    assert.equal(database.prepare("SELECT chapter_index FROM chapters WHERE id = 'chapter_1'").get()?.chapter_index, 1);

    database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series', 'book', '系列', 1, 1)`,
    ).run();
    database.prepare(
      `INSERT INTO episodes (id, series_project_id, episode_index, title, story_arc, target_duration_seconds, created_at, updated_at)
       VALUES ('episode', 'series', 1, '第一集', '故事弧', 1200, 1, 1)`,
    ).run();
    database.prepare(
      `INSERT INTO episode_sources (episode_id, source_index, chapter_id, source_event_id, source_byte_start, source_byte_end, source_hash)
       VALUES ('episode', 0, 'chapter_1', 'event_1', 1, 2, ?)`,
    ).run("a".repeat(64));
    assert.throws(
      () => deleteChapter(database, "book", "chapter_1"),
      (error: unknown) => error instanceof BookLibraryError && error.statusCode === 409,
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM chapters WHERE id = 'chapter_1'").get()?.count, 1);
  } finally {
    connection.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
