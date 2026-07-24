import Fastify from "fastify";
import type { Readable } from "node:stream";

import { BookImportError, importBookText } from "./book-import.js";
import { BookLibraryError, listBooks, listChapters, readChapterText } from "./book-library.js";
import { indexBookChapters } from "./chapter-index.js";
import { resolveDataRoot } from "./config.js";
import { openDatabase } from "./database.js";

interface BuildAppOptions {
  dataRoot?: string;
  logger?: boolean;
}

function decodeHeader(value: string | string[] | undefined, fallback = "") {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return fallback;
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BookImportError(400, "请求头编码无效");
  }
}

function pagination(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BookLibraryError(400, "分页参数无效");
  }
  return parsed;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const dataRoot = resolveDataRoot(options.dataRoot);
  const connection = openDatabase(dataRoot);

  app.addHook("onClose", async () => connection.close());
  app.addContentTypeParser(
    ["text/plain", "application/octet-stream"],
    (_request, payload, done) => done(null, payload),
  );

  app.get("/api/health", async () => ({
    ok: true,
    service: "narralume",
  }));

  app.post("/api/books/import", async (request, reply) => {
    try {
      const result = await importBookText({
        stream: request.body as Readable,
        fileName: decodeHeader(request.headers["x-file-name"], "导入文本.txt"),
        title: decodeHeader(request.headers["x-book-title"]),
        author: decodeHeader(request.headers["x-book-author"]),
        database: connection.database,
        dataRoot,
      });
      let indexed;
      try {
        indexed = await indexBookChapters({ book: result.book, database: connection.database, dataRoot });
      } catch {
        connection.database
          .prepare("UPDATE books SET import_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(result.book.id);
        throw new BookImportError(422, "TXT 编码或章节索引失败，请检查原文文件");
      }
      return reply.code(result.created ? 201 : 200).send({
        ok: true,
        message: result.created ? "书籍已导入并完成章节索引" : "相同内容已存在，章节索引已确认",
        ...result,
        book: { ...result.book, encoding: indexed.encoding, import_status: "ready" },
        encoding: indexed.encoding,
        chapter_count: indexed.chapters.length,
      });
    } catch (error) {
      if (error instanceof BookImportError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  app.get("/api/books", async () => ({ ok: true, items: listBooks(connection.database) }));

  app.get<{ Params: { bookId: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/books/:bookId/chapters",
    async (request, reply) => {
      try {
        const result = listChapters(
          connection.database,
          request.params.bookId,
          pagination(request.query.limit, 50, 1, 100),
          pagination(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
        );
        return { ok: true, ...result };
      } catch (error) {
        if (error instanceof BookLibraryError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { bookId: string; chapterId: string } }>(
    "/api/books/:bookId/chapters/:chapterId/text",
    async (request, reply) => {
      try {
        const text = await readChapterText(
          connection.database,
          dataRoot,
          request.params.bookId,
          request.params.chapterId,
        );
        return { ok: true, text };
      } catch (error) {
        if (error instanceof BookLibraryError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    },
  );

  return app;
}
