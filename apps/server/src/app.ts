import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import {
  addAssetAliases,
  AssetStoreError,
  createAsset,
  listAssets,
  type AssetInput,
} from "./asset-store.js";
import { BookImportError, importBookText } from "./book-import.js";
import { BookLibraryError, listBooks, listChapters, readChapterText } from "./book-library.js";
import {
  ChapterEventError,
  listChapterEvents,
  replaceChapterEvents,
  type ChapterEventInput,
} from "./chapter-event-store.js";
import { CHAPTER_EVENTS_JOB_TYPE, createChapterEventsJobHandler } from "./chapter-events-job.js";
import { indexBookChapters } from "./chapter-index.js";
import { resolveDataRoot } from "./config.js";
import { openDatabase } from "./database.js";
import {
  createSeriesProject,
  EpisodeStoreError,
  getEpisode,
  listSeriesProjects,
  replaceEpisode,
  type EpisodeInput,
} from "./episode-store.js";
import { createJob, getJob, requestJobCancellation } from "./job-store.js";
import { JobWorker, type JobHandler, type JobWorkerOptions } from "./job-worker.js";
import {
  createScriptVersion,
  listScriptVersions,
  ScriptVersionStoreError,
  type ScriptVersionInput,
  type ScriptVersionKind,
} from "./script-version-store.js";
import {
  changeScriptApproval,
  getScriptApproval,
  requireApprovedScriptForProduction,
  ScriptApprovalStoreError,
  type ScriptApprovalInput,
} from "./script-approval-store.js";
import { createTtsTimelineJobHandler, TTS_TIMELINE_JOB_TYPE } from "./tts-timeline-job.js";
import { createPlaceholderVideoJobHandler, PLACEHOLDER_VIDEO_JOB_TYPE } from "./placeholder-video-job.js";

interface BuildAppOptions {
  dataRoot?: string;
  logger?: boolean;
  jobHandlers?: Readonly<Record<string, JobHandler>>;
  jobPollMs?: number;
  jobWorker?: Partial<JobWorkerOptions>;
}

interface CreateJobBody {
  type?: unknown;
  payload?: unknown;
  priority?: unknown;
  maxAttempts?: unknown;
  runAfter?: unknown;
}

interface ReplaceChapterEventsBody {
  events?: unknown;
}

interface CreateSeriesBody { title?: unknown }
interface CreateAssetBody {
  type?: unknown;
  name?: unknown;
  description?: unknown;
  parentAssetId?: unknown;
  stateLabel?: unknown;
}
interface AddAssetAliasesBody { aliases?: unknown }
interface ReplaceEpisodeBody {
  title?: unknown;
  storyArc?: unknown;
  targetDurationSeconds?: unknown;
  recap?: unknown;
  nextHook?: unknown;
  sourceEventIds?: unknown;
}
interface CreateScriptBody {
  kind?: unknown;
  parentVersionId?: unknown;
  paragraphs?: unknown;
}
interface ChangeScriptApprovalBody {
  action?: unknown;
  expectedRevision?: unknown;
  scriptVersionId?: unknown;
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

function optionalInteger(value: unknown, message: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(message);
  return value;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  app.setErrorHandler((error, _request, reply) => {
    const possibleStatus = typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
    const statusCode = typeof possibleStatus === "number" && possibleStatus >= 400 && possibleStatus < 600
      ? possibleStatus
      : 500;
    if (statusCode >= 500) app.log.error(error instanceof Error ? error : { error }, "请求处理失败");
    const message = statusCode === 400
      ? "请求 JSON 或参数无效"
      : statusCode === 413
        ? "请求内容过大"
        : statusCode === 415
          ? "请求内容类型不支持"
          : statusCode >= 500
            ? "服务处理失败，请稍后重试"
            : "请求无法处理";
    return reply.code(statusCode).send({ ok: false, message });
  });
  const dataRoot = resolveDataRoot(options.dataRoot);
  const connection = openDatabase(dataRoot);
  const jobHandlers = {
    [CHAPTER_EVENTS_JOB_TYPE]: createChapterEventsJobHandler(connection.database, dataRoot),
    [TTS_TIMELINE_JOB_TYPE]: createTtsTimelineJobHandler(connection.database, dataRoot),
    [PLACEHOLDER_VIDEO_JOB_TYPE]: createPlaceholderVideoJobHandler(connection.database, dataRoot),
    ...(options.jobHandlers ?? {}),
  };
  const supportedJobTypes = new Set(Object.keys(jobHandlers));
  let worker: JobWorker;
  try {
    worker = new JobWorker(connection.database, jobHandlers, {
      workerId: options.jobWorker?.workerId ?? `local_${randomUUID()}`,
      leaseMs: options.jobWorker?.leaseMs,
      heartbeatMs: options.jobWorker?.heartbeatMs,
      retryDelayMs: options.jobWorker?.retryDelayMs,
      onError: options.jobWorker?.onError ?? ((error) => app.log.error(error, "本地任务 Worker 运行异常")),
    });
  } catch (error) {
    connection.close();
    throw error;
  }

  app.addHook("onReady", async () => {
    if (supportedJobTypes.size > 0) worker.start(options.jobPollMs);
  });
  app.addHook("onClose", async () => {
    await worker.stop();
    connection.close();
  });
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

  app.post<{ Params: { bookId: string }; Body: CreateSeriesBody }>(
    "/api/books/:bookId/series",
    async (request, reply) => {
      try {
        const series = createSeriesProject(connection.database, {
          bookId: request.params.bookId,
          title: request.body?.title as string,
        });
        return reply.code(201).send({ ok: true, message: "系列项目已创建", series });
      } catch (error) {
        if (error instanceof EpisodeStoreError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { bookId: string } }>("/api/books/:bookId/series", async (request, reply) => {
    try {
      return { ok: true, items: listSeriesProjects(connection.database, request.params.bookId) };
    } catch (error) {
      if (error instanceof EpisodeStoreError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { seriesId: string }; Body: CreateAssetBody }>(
    "/api/series/:seriesId/assets",
    async (request, reply) => {
      try {
        const asset = createAsset(connection.database, request.params.seriesId, {
          type: request.body?.type,
          name: request.body?.name,
          description: request.body?.description,
          parentAssetId: request.body?.parentAssetId,
          stateLabel: request.body?.stateLabel,
        } as AssetInput);
        return reply.code(201).send({ ok: true, message: "资产已保存", asset });
      } catch (error) {
        if (error instanceof AssetStoreError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { assetId: string }; Body: AddAssetAliasesBody }>(
    "/api/assets/:assetId/aliases",
    async (request, reply) => {
      try {
        const asset = addAssetAliases(
          connection.database,
          request.params.assetId,
          request.body?.aliases as string[],
        );
        return { ok: true, message: "资产别名已保存", asset };
      } catch (error) {
        if (error instanceof AssetStoreError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { seriesId: string } }>("/api/series/:seriesId/assets", async (request, reply) => {
    try {
      return { ok: true, items: listAssets(connection.database, request.params.seriesId) };
    } catch (error) {
      if (error instanceof AssetStoreError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  app.put<{
    Params: { seriesId: string; episodeIndex: string };
    Body: ReplaceEpisodeBody;
  }>("/api/series/:seriesId/episodes/:episodeIndex", async (request, reply) => {
    try {
      const body = request.body;
      const episode = replaceEpisode(connection.database, request.params.seriesId, {
        index: Number(request.params.episodeIndex),
        title: body?.title,
        storyArc: body?.storyArc,
        targetDurationSeconds: body?.targetDurationSeconds,
        recap: body?.recap,
        nextHook: body?.nextHook,
        sourceEventIds: body?.sourceEventIds,
      } as EpisodeInput);
      return { ok: true, message: "分集故事弧与原文证据已保存", episode };
    } catch (error) {
      if (error instanceof EpisodeStoreError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { seriesId: string; episodeIndex: string } }>(
    "/api/series/:seriesId/episodes/:episodeIndex",
    async (request, reply) => {
      try {
        const episode = await getEpisode(
          connection.database,
          dataRoot,
          request.params.seriesId,
          Number(request.params.episodeIndex),
        );
        return { ok: true, episode };
      } catch (error) {
        if (error instanceof EpisodeStoreError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    },
  );

  const episodeIdForRoute = (seriesId: string, episodeIndex: string) => {
    const index = Number(episodeIndex);
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new ScriptVersionStoreError(400, "分集序号必须从 1 开始");
    }
    const row = connection.database.prepare(
      "SELECT id FROM episodes WHERE series_project_id = ? AND episode_index = ?",
    ).get(seriesId, index) as { id: string } | undefined;
    if (!row) throw new ScriptVersionStoreError(404, "分集不存在");
    return row.id;
  };

  app.post<{
    Params: { seriesId: string; episodeIndex: string };
    Body: CreateScriptBody;
  }>("/api/series/:seriesId/episodes/:episodeIndex/scripts", async (request, reply) => {
    try {
      const episodeId = episodeIdForRoute(request.params.seriesId, request.params.episodeIndex);
      const script = createScriptVersion(connection.database, episodeId, {
        kind: request.body?.kind,
        parentVersionId: request.body?.parentVersionId,
        paragraphs: request.body?.paragraphs,
      } as ScriptVersionInput);
      return reply.code(201).send({ ok: true, message: "稿件版本已保存", script });
    } catch (error) {
      if (error instanceof ScriptVersionStoreError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  app.get<{
    Params: { seriesId: string; episodeIndex: string };
    Querystring: { kind?: string };
  }>("/api/series/:seriesId/episodes/:episodeIndex/scripts", async (request, reply) => {
    try {
      const episodeId = episodeIdForRoute(request.params.seriesId, request.params.episodeIndex);
      const kind = request.query.kind;
      if (kind !== undefined && kind !== "faithful" && kind !== "packaged") {
        throw new ScriptVersionStoreError(400, "稿件类型无效");
      }
      return {
        ok: true,
        items: listScriptVersions(connection.database, episodeId, kind as ScriptVersionKind | undefined),
      };
    } catch (error) {
      if (error instanceof ScriptVersionStoreError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { seriesId: string; episodeIndex: string } }>(
    "/api/series/:seriesId/episodes/:episodeIndex/approval",
    async (request, reply) => {
      try {
        const episodeId = episodeIdForRoute(request.params.seriesId, request.params.episodeIndex);
        return { ok: true, approval: getScriptApproval(connection.database, episodeId) };
      } catch (error) {
        if (error instanceof ScriptVersionStoreError || error instanceof ScriptApprovalStoreError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    },
  );

  app.put<{
    Params: { seriesId: string; episodeIndex: string };
    Body: ChangeScriptApprovalBody;
  }>("/api/series/:seriesId/episodes/:episodeIndex/approval", async (request, reply) => {
    try {
      const episodeId = episodeIdForRoute(request.params.seriesId, request.params.episodeIndex);
      const approval = changeScriptApproval(connection.database, episodeId, {
        action: request.body?.action,
        expectedRevision: request.body?.expectedRevision,
        scriptVersionId: request.body?.scriptVersionId,
      } as ScriptApprovalInput);
      return {
        ok: true,
        message: approval.status === "approved" ? "包装稿已人工批准" : "稿件批准已撤回",
        approval,
      };
    } catch (error) {
      if (error instanceof ScriptVersionStoreError || error instanceof ScriptApprovalStoreError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Body: CreateJobBody }>("/api/jobs", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || typeof body.type !== "string") {
      return reply.code(400).send({ ok: false, message: "任务类型不能为空" });
    }
    const type = body.type.trim();
    if (!supportedJobTypes.has(type)) {
      return reply.code(400).send({ ok: false, message: `不支持的任务类型：${type || "（空）"}` });
    }
    if (type === TTS_TIMELINE_JOB_TYPE) {
      const episodeId = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? (body.payload as { episodeId?: unknown }).episodeId
        : undefined;
      if (typeof episodeId !== "string" || !episodeId) {
        return reply.code(400).send({ ok: false, message: "语音时间轴任务缺少有效分集 ID" });
      }
      try {
        requireApprovedScriptForProduction(connection.database, episodeId, "tts");
      } catch (error) {
        if (error instanceof ScriptApprovalStoreError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    }
    if (type === PLACEHOLDER_VIDEO_JOB_TYPE) {
      const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? body.payload as { episodeId?: unknown; timelineHash?: unknown }
        : {};
      if (typeof payload.episodeId !== "string" || !payload.episodeId ||
          typeof payload.timelineHash !== "string" || !/^[0-9a-f]{64}$/.test(payload.timelineHash)) {
        return reply.code(400).send({ ok: false, message: "占位视频任务缺少有效分集 ID 或时间轴哈希" });
      }
      try {
        requireApprovedScriptForProduction(connection.database, payload.episodeId, "video");
      } catch (error) {
        if (error instanceof ScriptApprovalStoreError) {
          return reply.code(error.statusCode).send({ ok: false, message: error.message });
        }
        throw error;
      }
    }
    let priority: number | undefined;
    let maxAttempts: number | undefined;
    let runAfter: number | undefined;
    try {
      priority = optionalInteger(body.priority, "任务优先级无效");
      maxAttempts = optionalInteger(body.maxAttempts, "最大尝试次数无效");
      runAfter = optionalInteger(body.runAfter, "任务执行时间无效");
      if (maxAttempts !== undefined && (maxAttempts < 1 || maxAttempts > 10)) {
        throw new Error("最大尝试次数必须在 1～10 之间");
      }
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        message: error instanceof Error ? error.message : "任务参数无效",
      });
    }
    const job = createJob(connection.database, {
      type,
      payload: body.payload ?? {},
      priority,
      maxAttempts,
      runAfter,
    });
    return reply.code(201).send({ ok: true, message: "任务已创建并持久化", job });
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    const job = getJob(connection.database, request.params.jobId);
    if (!job) return reply.code(404).send({ ok: false, message: "任务不存在" });
    return { ok: true, job };
  });

  app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/cancel", async (request, reply) => {
    const before = getJob(connection.database, request.params.jobId);
    if (!before) return reply.code(404).send({ ok: false, message: "任务不存在" });
    const job = requestJobCancellation(connection.database, request.params.jobId)!;
    const message = before.status === "queued"
      ? "任务已取消"
      : before.status === "running"
        ? "取消请求已记录"
        : "任务已结束，状态未改变";
    return { ok: true, message, job };
  });

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

  app.put<{
    Params: { bookId: string; chapterId: string };
    Body: ReplaceChapterEventsBody;
  }>("/api/books/:bookId/chapters/:chapterId/events", async (request, reply) => {
    try {
      const events = await replaceChapterEvents(
        connection.database,
        dataRoot,
        request.params.bookId,
        request.params.chapterId,
        request.body?.events as readonly ChapterEventInput[],
      );
      return { ok: true, message: "章节事件已保存", items: events, total: events.length };
    } catch (error) {
      if (error instanceof ChapterEventError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  app.get<{
    Params: { bookId: string; chapterId: string };
    Querystring: { limit?: string; offset?: string };
  }>("/api/books/:bookId/chapters/:chapterId/events", async (request, reply) => {
    try {
      const result = await listChapterEvents(
        connection.database,
        dataRoot,
        request.params.bookId,
        request.params.chapterId,
        pagination(request.query.limit, 50, 1, 100),
        pagination(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      );
      return { ok: true, ...result };
    } catch (error) {
      if (error instanceof BookLibraryError || error instanceof ChapterEventError) {
        return reply.code(error.statusCode).send({ ok: false, message: error.message });
      }
      throw error;
    }
  });

  return app;
}
