import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { BookLibraryError, readChapterText } from "./book-library.js";
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
