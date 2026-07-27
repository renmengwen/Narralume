import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { openVerifiedFinalExport } from "./final-video.js";
import type { JobStatus } from "./job-store.js";
import { loadRenderPlanSnapshot, type RenderPlanSnapshot } from "./render-chunk-job.js";

const ID = /^[A-Za-z0-9_-]+$/u;
const HASH = /^[0-9a-f]{64}$/u;

export class ExportReadinessError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404) { super(message); }
}

export interface ExportReadinessJob {
  id: string;
  type: "render_chunks" | "final_video";
  status: JobStatus;
  progress: number;
  errorMessage: string | null;
}

export interface ExportReadinessResult {
  episodeId: string;
  timelineHash: string;
  productionReady: boolean;
  blockers: Array<{ code: string; message: string }>;
  identity: null | {
    scriptVersionId: string;
    approvalRevision: number;
    renderIdentityHash: string;
    contactSheetReady: true;
  };
  renderChunks: { ready: boolean; completed: number; total: number };
  jobs: { renderChunks: ExportReadinessJob | null; finalVideo: ExportReadinessJob | null };
  finalExport: null | {
    exportHash: string;
    verified: boolean;
    fileHash: string;
    bytes: number;
    durationMs: number;
  };
}

interface JobRow {
  id: string;
  type: string;
  payload_json: string;
  status: JobStatus;
  progress: number;
  result_json: string | null;
  error_message: string | null;
  created_at: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseObject(value: string | null) {
  if (value === null) return undefined;
  try { return object(JSON.parse(value)); } catch { return undefined; }
}

function renderIdentityHash(snapshot: RenderPlanSnapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

function exactResult(row: JobRow, snapshot: RenderPlanSnapshot) {
  const result = parseObject(row.result_json);
  if (!result || result.episodeId !== snapshot.episodeId || result.timelineHash !== snapshot.timelineHash ||
      result.scriptVersionId !== snapshot.scriptVersionId || result.approvalRevision !== snapshot.approvalRevision) return undefined;
  if (row.type === "render_chunks") {
    if (!Array.isArray(result.chunks) || result.chunks.length !== snapshot.chunks.length) return undefined;
    const hashes = result.chunks.map((item) => object(item)?.renderHash);
    if (hashes.some((hash, index) => hash !== snapshot.chunks[index]!.renderHash)) return undefined;
  }
  if (row.type === "final_video" && !HASH.test(String(result.finalHash ?? ""))) return undefined;
  return result;
}

function identityCreatedAt(database: DatabaseSync, snapshot: RenderPlanSnapshot) {
  const row = database.prepare(
    `SELECT MAX(value) AS value FROM (
       SELECT created_at AS value FROM script_approval_events
        WHERE episode_id = ? AND revision = ?
       UNION ALL SELECT updated_at FROM visual_segments WHERE episode_id = ? AND timeline_hash = ?
       UNION ALL SELECT created_at FROM audio_segments WHERE episode_id = ? AND timeline_hash = ?
       UNION ALL SELECT review.created_at FROM visual_segment_assets relation
        JOIN visual_segments segment ON segment.id = relation.visual_segment_id
        JOIN asset_candidate_review_events review ON review.candidate_id = relation.selected_candidate_id
          AND review.revision = relation.candidate_review_revision
        WHERE segment.episode_id = ? AND segment.timeline_hash = ?
     )`,
  ).get(snapshot.episodeId, snapshot.approvalRevision, snapshot.episodeId, snapshot.timelineHash,
    snapshot.episodeId, snapshot.timelineHash, snapshot.episodeId, snapshot.timelineHash) as { value: number };
  return row.value;
}

function latestJob(database: DatabaseSync, type: "render_chunks" | "final_video", snapshot: RenderPlanSnapshot) {
  const rows = database.prepare(
    `SELECT id, type, payload_json, status, progress, result_json, error_message, created_at
     FROM jobs WHERE type = ? ORDER BY updated_at DESC, id DESC`,
  ).all(type) as unknown as JobRow[];
  const identityFloor = identityCreatedAt(database, snapshot);
  for (const row of rows) {
    const payload = parseObject(row.payload_json);
    if (payload?.episodeId !== snapshot.episodeId || payload.timelineHash !== snapshot.timelineHash) continue;
    // Active handlers reload at execution, but a job older than any current input is stale; terminal jobs prove their result.
    if (row.status === "queued" || row.status === "running") {
      if (row.created_at < identityFloor) continue;
    } else if (!exactResult(row, snapshot)) continue;
    return {
      id: row.id, type, status: row.status, progress: row.progress, errorMessage: row.error_message,
    } satisfies ExportReadinessJob;
  }
  return null;
}

function finalResult(database: DatabaseSync, snapshot: RenderPlanSnapshot) {
  const rows = database.prepare(
    `SELECT id, type, payload_json, status, progress, result_json, error_message, created_at
     FROM jobs WHERE type = 'final_video' AND status = 'succeeded' ORDER BY updated_at DESC, id DESC`,
  ).all() as unknown as JobRow[];
  for (const row of rows) {
    const payload = parseObject(row.payload_json);
    if (payload?.episodeId !== snapshot.episodeId || payload.timelineHash !== snapshot.timelineHash) continue;
    const result = exactResult(row, snapshot);
    const video = object(result?.video);
    if (result && video && HASH.test(String(result.finalHash)) && HASH.test(String(video.fileHash)) &&
        Number.isSafeInteger(video.bytes) && Number(video.bytes) > 0 &&
        Number.isSafeInteger(video.durationMs) && Number(video.durationMs) > 0) {
      return { exportHash: String(result.finalHash), fileHash: String(video.fileHash),
        bytes: Number(video.bytes), durationMs: Number(video.durationMs) };
    }
  }
  return null;
}

export async function deriveExportReadiness(input: {
  database: DatabaseSync;
  dataRoot: string;
  episodeId: string;
  timelineHash: string;
}): Promise<ExportReadinessResult> {
  if (!ID.test(input.episodeId)) throw new ExportReadinessError("分集 ID 无效", 400);
  if (!HASH.test(input.timelineHash)) throw new ExportReadinessError("时间轴哈希无效", 400);
  if (!input.database.prepare("SELECT 1 FROM episodes WHERE id = ?").get(input.episodeId)) {
    throw new ExportReadinessError("分集不存在", 404);
  }

  let snapshot: RenderPlanSnapshot;
  try {
    snapshot = loadRenderPlanSnapshot(input.database, input.episodeId, input.timelineHash);
  } catch (error) {
    return {
      episodeId: input.episodeId,
      timelineHash: input.timelineHash,
      productionReady: false,
      blockers: [{ code: "production_not_ready", message: error instanceof Error ? error.message : "生产资料尚未就绪" }],
      identity: null,
      renderChunks: { ready: false, completed: 0, total: 0 },
      jobs: { renderChunks: null, finalVideo: null },
      finalExport: null,
    };
  }

  const completed = snapshot.chunks.reduce((count, chunk) => count + Number(Boolean(input.database.prepare(
    `SELECT 1 FROM render_chunks
     WHERE render_hash = ? AND episode_id = ? AND timeline_hash = ? AND chunk_index = ?
       AND script_version_id = ? AND approval_revision = ? AND start_ms = ? AND end_ms = ?`,
  ).get(chunk.renderHash, snapshot.episodeId, snapshot.timelineHash, chunk.index, snapshot.scriptVersionId,
    snapshot.approvalRevision, chunk.startMs, chunk.endMs))), 0);
  const renderJob = latestJob(input.database, "render_chunks", snapshot);
  const finalJob = latestJob(input.database, "final_video", snapshot);
  const candidate = finalResult(input.database, snapshot);
  let finalExport: ExportReadinessResult["finalExport"] = null;
  if (candidate) {
    try {
      const verified = await openVerifiedFinalExport(input.database, input.dataRoot, {
        episodeId: snapshot.episodeId, exportHash: candidate.exportHash,
      });
      await verified.videoHandle.close();
      finalExport = { ...candidate, verified: true };
    } catch {
      finalExport = { ...candidate, verified: false };
    }
  }

  return {
    episodeId: snapshot.episodeId,
    timelineHash: snapshot.timelineHash,
    productionReady: true,
    blockers: [],
    identity: {
      scriptVersionId: snapshot.scriptVersionId,
      approvalRevision: snapshot.approvalRevision,
      renderIdentityHash: renderIdentityHash(snapshot),
      contactSheetReady: true,
    },
    renderChunks: { ready: snapshot.chunks.length > 0 && completed === snapshot.chunks.length,
      completed, total: snapshot.chunks.length },
    jobs: { renderChunks: renderJob, finalVideo: finalJob },
    finalExport,
  };
}
