import type { DatabaseSync } from "node:sqlite";
import type { FastifyPluginAsync } from "fastify";

import { FinalExportReadError, openVerifiedFinalExport } from "./final-video.js";

interface Options { database: DatabaseSync; dataRoot: string }
interface Params { episodeId: string; exportHash: string }

export const registerExportRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  const open = async (params: Params) => openVerifiedFinalExport(options.database, options.dataRoot, params);
  app.get<{ Params: Params }>("/api/episodes/:episodeId/exports/:exportHash/manifest", async (request, reply) => {
    try {
      const result = await open(request.params);
      await result.videoHandle.close();
      return reply.header("Cache-Control", "no-store").type("application/json; charset=utf-8").send(result.manifest);
    } catch (error) {
      if (error instanceof FinalExportReadError) return reply.code(error.statusCode).send({ ok: false, message: error.message });
      throw error;
    }
  });
  app.get<{ Params: Params }>("/api/episodes/:episodeId/exports/:exportHash/video", async (request, reply) => {
    try {
      const result = await open(request.params);
      const filename = `episode-${request.params.episodeId}-${request.params.exportHash}.mp4`;
      return reply.header("Cache-Control", "no-store")
        .header("Content-Length", result.manifest.finalVideo.bytes)
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .type("video/mp4")
        .send(result.videoHandle.createReadStream({ autoClose: true, start: 0 }));
    } catch (error) {
      if (error instanceof FinalExportReadError) return reply.code(error.statusCode).send({ ok: false, message: error.message });
      throw error;
    }
  });
};
