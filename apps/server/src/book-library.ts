import { open } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export class BookLibraryError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function listBooks(database: DatabaseSync) {
  return database
    .prepare(
      `SELECT books.id, books.title, books.author, books.encoding, books.import_status,
              books.created_at, COUNT(chapters.id) AS chapter_count
       FROM books LEFT JOIN chapters ON chapters.book_id = books.id
       GROUP BY books.id ORDER BY books.created_at DESC, books.id`,
    )
    .all();
}

export function listChapters(database: DatabaseSync, bookId: string, limit: number, offset: number) {
  const book = database.prepare("SELECT id FROM books WHERE id = ?").get(bookId);
  if (!book) throw new BookLibraryError(404, "书籍不存在");
  const items = database
    .prepare(
      `SELECT id, chapter_index, chapter_number, title, byte_start, byte_end, char_count, content_hash
       FROM chapters WHERE book_id = ? ORDER BY chapter_index LIMIT ? OFFSET ?`,
    )
    .all(bookId, limit, offset);
  const total = database.prepare("SELECT COUNT(*) AS count FROM chapters WHERE book_id = ?").get(bookId)?.count;
  return { items, total };
}

export async function readChapterText(database: DatabaseSync, dataRoot: string, bookId: string, chapterId: string) {
  const row = database
    .prepare(
      `SELECT chapters.byte_start, chapters.byte_end, books.encoding, books.original_file_path
       FROM chapters JOIN books ON books.id = chapters.book_id
       WHERE chapters.id = ? AND books.id = ?`,
    )
    .get(chapterId, bookId) as
    | { byte_start: number; byte_end: number; encoding: string; original_file_path: string }
    | undefined;
  if (!row) throw new BookLibraryError(404, "章节不存在");

  const root = resolve(dataRoot);
  const path = resolve(root, row.original_file_path);
  if (!path.startsWith(`${root}${sep}`)) throw new BookLibraryError(500, "原文路径无效");
  const length = row.byte_end - row.byte_start;
  const bytes = Buffer.alloc(length);
  const file = await open(path, "r").catch(() => {
    throw new BookLibraryError(500, "原文文件无法读取");
  });
  try {
    let read = 0;
    while (read < length) {
      const result = await file.read(bytes, read, length - read, row.byte_start + read);
      if (result.bytesRead === 0) throw new BookLibraryError(500, "原文文件不完整");
      read += result.bytesRead;
    }
  } finally {
    await file.close();
  }
  try {
    return new TextDecoder(row.encoding.toLowerCase(), { fatal: true }).decode(bytes);
  } catch {
    throw new BookLibraryError(500, "原文编码无效");
  }
}
