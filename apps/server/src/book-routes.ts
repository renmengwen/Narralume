import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";

import { BookLibraryError, deleteBook } from "./book-library.js";

export async function registerBookRoutes(
  app: FastifyInstance,
  options: { database: DatabaseSync; dataRoot: string },
) {
  app.delete<{ Params: { bookId: string } }>("/api/books/:bookId", async (request, reply) => {
    try {
      const book = await deleteBook(options.database, options.dataRoot, request.params.bookId);
      return reply.code(book.fileCleanupComplete ? 200 : 202).send({
        ok: true,
        message: book.fileCleanupComplete
          ? `小说“${book.title}”及其全部项目数据已删除`
          : `小说“${book.title}”的项目数据已删除；部分本地文件将在服务重启时继续清理`,
        book,
      });
    } catch (error) {
      if (error instanceof BookLibraryError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });
}
