import Fastify from "fastify";
import type { Readable } from "node:stream";

import { BookImportError, importBookText } from "./book-import.js";
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
      return reply.code(result.created ? 201 : 200).send({
        ok: true,
        message: result.created ? "书籍已导入，等待章节索引" : "相同内容已存在",
        ...result,
      });
    } catch (error) {
      if (error instanceof BookImportError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  return app;
}
