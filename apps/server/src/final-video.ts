import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, renameSync, rmSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { probeNineSixteenVideo, runVideoProcess } from "./ffmpeg-video.js";
import { JobCancelledError } from "./job-worker.js";
import type { JobExecutionContext, JobHandler } from "./job-worker.js";
import { ensureSafeOutputDirectory, loadRenderPlanSnapshot, RENDER_CONTRACT } from "./render-chunk-job.js";

export const FINAL_VIDEO_MANIFEST_VERSION = "final-export-v1" as const;
export const FINAL_VIDEO_JOB_TYPE = "final_video";
const MAX_DURATION_DRIFT_MS = 1_000;

interface ChunkRow {
  render_hash: string;
  chunk_index: number;
  script_version_id: string;
  approval_revision: number;
  start_ms: number;
  end_ms: number;
  relative_path: string;
  file_hash: string;
  bytes: number;
  duration_ms: number;
}

export interface FinalVideoManifest {
  version: typeof FINAL_VIDEO_MANIFEST_VERSION;
  contract: typeof RENDER_CONTRACT;
  episodeId: string;
  scriptVersionId: string;
  approvalRevision: number;
  timelineHash: string;
  exportHash: string;
  chunks: Array<{
    index: number;
    startMs: number;
    endMs: number;
    renderHash: string;
    relativePath: string;
    fileHash: string;
    bytes: number;
    durationMs: number;
  }>;
  finalVideo: {
    relativePath: string;
    fileHash: string;
    bytes: number;
    durationMs: number;
    streams: { video: "h264:1080x1920:25:yuv420p"; audio: "aac" };
  };
}

interface FinalVideoDependencies {
  run: typeof runVideoProcess;
  probe: typeof probeNineSixteenVideo;
  publishRename: typeof rename;
  publishRemove: typeof rm;
  publishLstat: typeof lstat;
  publishRenameSync: typeof renameSync;
  publishRemoveSync: typeof rmSync;
}

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

async function sha256File(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const digest = createHash("sha256");
    createReadStream(path).on("data", (chunk) => digest.update(chunk)).once("error", reject)
      .once("end", () => resolvePromise(digest.digest("hex")));
  });
}

function controlledPath(dataRoot: string, relativePath: string) {
  if (!relativePath || /[\0\r\n]/u.test(relativePath)) throw new Error("产物相对路径无效");
  const root = resolve(dataRoot);
  const path = resolve(root, ...relativePath.split("/"));
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error("产物路径越界");
  return path;
}

function isInside(root: string, path: string) {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function assertOrdinaryDataFile(dataRoot: string, path: string) {
  const [rootReal, fileReal, info] = await Promise.all([realpath(dataRoot), realpath(path), lstat(path)]);
  if (!isInside(rootReal, fileReal) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("分片必须是数据目录内的普通独占文件");
  }
}

async function assertSafeDirectoryIfPresent(dataRoot: string, path: string) {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const [rootReal, pathReal] = await Promise.all([realpath(dataRoot), realpath(path)]);
  if (!isInside(rootReal, pathReal) || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("最终导出目录必须是数据目录内的真实目录");
  }
}

async function syncFile(path: string) {
  const handle = await open(path, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

function manifestText(manifest: FinalVideoManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function exportIdentity(snapshot: ReturnType<typeof loadRenderPlanSnapshot>, rows: ChunkRow[]) {
  return {
    version: FINAL_VIDEO_MANIFEST_VERSION,
    contract: RENDER_CONTRACT,
    episodeId: snapshot.episodeId,
    scriptVersionId: snapshot.scriptVersionId,
    approvalRevision: snapshot.approvalRevision,
    timelineHash: snapshot.timelineHash,
    chunks: rows.map((row) => ({
      index: row.chunk_index,
      startMs: row.start_ms,
      endMs: row.end_ms,
      renderHash: row.render_hash,
      fileHash: row.file_hash,
      bytes: row.bytes,
      durationMs: row.duration_ms,
    })),
  } as const;
}

async function exists(path: string, publishLstat: typeof lstat) {
  try { await publishLstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function validPublishedPair(
  dataRoot: string,
  directory: string,
  manifestBase: Omit<FinalVideoManifest, "finalVideo">,
  finalRelativePath: string,
  probe: typeof probeNineSixteenVideo,
) {
  try {
    const videoPath = join(directory, "video.mp4");
    const manifestPath = join(directory, "manifest.json");
    await assertOrdinaryDataFile(dataRoot, videoPath);
    await assertOrdinaryDataFile(dataRoot, manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as FinalVideoManifest;
    if (JSON.stringify({ ...manifest, finalVideo: undefined }) !==
        JSON.stringify({ ...manifestBase, finalVideo: undefined }) ||
        manifest.finalVideo.relativePath !== finalRelativePath) return false;
    const measured = await probe(videoPath);
    return measured.bytes === manifest.finalVideo.bytes && measured.durationMs === manifest.finalVideo.durationMs &&
      await sha256File(videoPath) === manifest.finalVideo.fileHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function recoverPublish(
  dataRoot: string,
  target: string,
  backup: string,
  manifestBase: Omit<FinalVideoManifest, "finalVideo">,
  finalRelativePath: string,
  probe: typeof probeNineSixteenVideo,
  publishRename: typeof rename,
  publishRemove: typeof rm,
  publishLstat: typeof lstat,
) {
  if (!await exists(backup, publishLstat)) return;
  const backupValid = await validPublishedPair(dataRoot, backup, manifestBase, finalRelativePath, probe);
  if (!await exists(target, publishLstat)) {
    if (!backupValid) throw new Error("最终导出备份不完整，拒绝恢复");
    await publishRename(backup, target);
    return;
  }
  if (await validPublishedPair(dataRoot, target, manifestBase, finalRelativePath, probe)) {
    await publishRemove(backup, { recursive: true });
    return;
  }
  if (!backupValid) throw new Error("最终导出目标与备份均不完整，拒绝恢复");
  await publishRemove(target, { recursive: true });
  await publishRename(backup, target);
}

function publishDirectorySync(
  target: string,
  staging: string,
  publishRename: typeof renameSync,
  publishRemove: typeof rmSync,
) {
  const backup = `${target}.backup`;
  let oldMoved = false;
  try {
    try { publishRename(target, backup); oldMoved = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    publishRename(staging, target);
  } catch (error) {
    if (oldMoved) {
      try { publishRename(backup, target); } catch { /* 保留原始发布错误和可恢复 backup。 */ }
    }
    throw error;
  }
  if (oldMoved) publishRemove(backup, { recursive: true });
}

export async function exportFinalVideo(
  database: DatabaseSync,
  dataRoot: string,
  input: { episodeId: string; timelineHash: string; signal?: AbortSignal },
  dependencies: Partial<FinalVideoDependencies> = {},
) {
  const run = dependencies.run ?? runVideoProcess;
  const probe = dependencies.probe ?? probeNineSixteenVideo;
  const publishRename = dependencies.publishRename ?? rename;
  const publishRemove = dependencies.publishRemove ?? rm;
  const publishLstat = dependencies.publishLstat ?? lstat;
  const publishRenameNow = dependencies.publishRenameSync ?? renameSync;
  const publishRemoveNow = dependencies.publishRemoveSync ?? rmSync;
  const snapshot = loadRenderPlanSnapshot(database, input.episodeId, input.timelineHash);
  const rows = database.prepare(
    `SELECT render_hash, chunk_index, script_version_id, approval_revision, start_ms, end_ms,
            relative_path, file_hash, bytes, duration_ms
     FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? AND chunk_index < ? ORDER BY chunk_index`,
  ).all(input.episodeId, input.timelineHash, snapshot.chunks.length) as unknown as ChunkRow[];
  if (rows.length !== snapshot.chunks.length) throw new Error("当前完整分片计划尚未全部渲染");
  for (const [index, expected] of snapshot.chunks.entries()) {
    const row = rows[index];
    const canonical = `episodes/${input.episodeId}/renders/chunks/${expected.renderHash.slice(0, 2)}/${expected.renderHash}.mp4`;
    if (!row || row.chunk_index !== index || row.start_ms !== expected.startMs || row.end_ms !== expected.endMs ||
        row.render_hash !== expected.renderHash || row.relative_path !== canonical ||
        row.script_version_id !== snapshot.scriptVersionId || row.approval_revision !== snapshot.approvalRevision ||
        row.bytes < 1 || row.duration_ms < 1 || Math.abs(row.duration_ms - (row.end_ms - row.start_ms)) > MAX_DURATION_DRIFT_MS ||
        !/^[0-9a-f]{64}$/u.test(row.file_hash)) throw new Error("分片记录不属于当前完整渲染身份");
    if (index > 0 && row.start_ms !== rows[index - 1]!.end_ms) throw new Error("分片边界不连续");
  }

  const identity = exportIdentity(snapshot, rows);
  const exportHash = sha256(JSON.stringify(identity));
  const manifestBase = { ...identity, chunks: rows.map((row) => ({
    index: row.chunk_index, startMs: row.start_ms, endMs: row.end_ms, renderHash: row.render_hash,
    relativePath: row.relative_path, fileHash: row.file_hash, bytes: row.bytes, durationMs: row.duration_ms,
  })) };
  const directoryRelativePath = `episodes/${input.episodeId}/exports/${exportHash.slice(0, 2)}/${exportHash}`;
  const target = controlledPath(dataRoot, directoryRelativePath);
  const finalRelativePath = `${directoryRelativePath}/video.mp4`;
  const finalPath = controlledPath(dataRoot, finalRelativePath);
  const manifestPath = join(target, "manifest.json");
  await ensureSafeOutputDirectory(dataRoot, dirname(target));
  await assertSafeDirectoryIfPresent(dataRoot, target);
  await assertSafeDirectoryIfPresent(dataRoot, `${target}.backup`);
  await recoverPublish(dataRoot, target, `${target}.backup`, { ...manifestBase, exportHash }, finalRelativePath,
    probe, publishRename, publishRemove, publishLstat);

  const validatedChunks = [];
  for (const row of rows) {
    const path = controlledPath(dataRoot, row.relative_path);
    try {
      await assertOrdinaryDataFile(dataRoot, path);
      const measured = await probe(path, input.signal);
      if (measured.bytes !== row.bytes || measured.durationMs !== row.duration_ms || await sha256File(path) !== row.file_hash) {
        throw new Error("mismatch");
      }
    } catch (error) {
      if (input.signal?.aborted) throw new JobCancelledError();
      throw new Error("分片文件与登记信息不一致");
    }
    validatedChunks.push({ row, path });
  }

  try {
    await assertOrdinaryDataFile(dataRoot, finalPath);
    await assertOrdinaryDataFile(dataRoot, manifestPath);
    const measured = await probe(finalPath, input.signal);
    const fileHash = await sha256File(finalPath);
    const manifest: FinalVideoManifest = { ...manifestBase, exportHash, finalVideo: {
      relativePath: finalRelativePath, fileHash, bytes: measured.bytes, durationMs: measured.durationMs,
      streams: { video: "h264:1080x1920:25:yuv420p", audio: "aac" },
    } };
    if (Math.abs(measured.durationMs - rows.at(-1)!.end_ms) <= MAX_DURATION_DRIFT_MS &&
        await readFile(manifestPath, "utf8") === manifestText(manifest)) {
      if (input.signal?.aborted) throw new JobCancelledError();
      const currentSnapshot = loadRenderPlanSnapshot(database, input.episodeId, input.timelineHash);
      const currentRows = database.prepare(
        `SELECT render_hash, chunk_index, script_version_id, approval_revision, start_ms, end_ms,
                relative_path, file_hash, bytes, duration_ms
         FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? AND chunk_index < ? ORDER BY chunk_index`,
      ).all(input.episodeId, input.timelineHash, currentSnapshot.chunks.length) as unknown as ChunkRow[];
      if (JSON.stringify(currentSnapshot) !== JSON.stringify(snapshot) || JSON.stringify(currentRows) !== JSON.stringify(rows) ||
          sha256(JSON.stringify(exportIdentity(currentSnapshot, currentRows))) !== exportHash) {
        throw new Error("最终导出复用检查期间当前渲染身份已变化");
      }
      if (input.signal?.aborted) throw new JobCancelledError();
      return { manifest, manifestPath, finalPath, reused: true };
    }
  } catch (error) {
    if (input.signal?.aborted || error instanceof JobCancelledError) throw new JobCancelledError();
    /* 缺失、损坏或过期的同身份导出必须重建。 */
  }

  const staging = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staging);
  try {
    const listLines = [];
    for (const [index, { row, path }] of validatedChunks.entries()) {
      if (input.signal?.aborted) throw new JobCancelledError();
      const name = `chunk-${String(index).padStart(4, "0")}.mp4`;
      const snapshotPath = join(staging, name);
      await copyFile(path, snapshotPath, constants.COPYFILE_EXCL);
      await syncFile(snapshotPath);
      const measured = await probe(snapshotPath, input.signal);
      if (measured.bytes !== row.bytes || measured.durationMs !== row.duration_ms || await sha256File(snapshotPath) !== row.file_hash) {
        throw new Error("分片快照与登记信息不一致");
      }
      listLines.push(`file '${name}'`);
    }
    const listPath = join(staging, "chunks.ffconcat");
    await writeDurable(listPath, `ffconcat version 1.0\n${listLines.join("\n")}\n`);
    const temporaryVideo = join(staging, "final.tmp.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "1", "-i", "chunks.ffconcat",
      "-c", "copy", "-movflags", "+faststart", "final.tmp.mp4"], { cwd: staging, signal: input.signal });
    const measured = await probe(temporaryVideo, input.signal);
    if (Math.abs(measured.durationMs - rows.at(-1)!.end_ms) > MAX_DURATION_DRIFT_MS) {
      throw new Error("最终视频时长与完整分片边界不一致");
    }
    await syncFile(temporaryVideo);
    const fileHash = await sha256File(temporaryVideo);
    const manifest: FinalVideoManifest = { ...manifestBase, exportHash, finalVideo: {
      relativePath: finalRelativePath, fileHash, bytes: measured.bytes, durationMs: measured.durationMs,
      streams: { video: "h264:1080x1920:25:yuv420p", audio: "aac" },
    } };
    await writeDurable(join(staging, "manifest.json"), manifestText(manifest));
    await rename(temporaryVideo, join(staging, "video.mp4"));
    await Promise.all([rm(listPath), ...validatedChunks.map((_, index) => rm(join(staging, `chunk-${String(index).padStart(4, "0")}.mp4`)))]);
    for (const { row, path } of validatedChunks) {
      const currentProbe = await probe(path, input.signal);
      if (currentProbe.bytes !== row.bytes || currentProbe.durationMs !== row.duration_ms || await sha256File(path) !== row.file_hash) {
        throw new Error("最终导出期间分片文件已变化");
      }
    }
    if (input.signal?.aborted) throw new JobCancelledError();
    database.exec("BEGIN IMMEDIATE");
    try {
      const currentSnapshot = loadRenderPlanSnapshot(database, input.episodeId, input.timelineHash);
      const currentRows = database.prepare(
        `SELECT render_hash, chunk_index, script_version_id, approval_revision, start_ms, end_ms,
                relative_path, file_hash, bytes, duration_ms
         FROM render_chunks WHERE episode_id = ? AND timeline_hash = ? AND chunk_index < ? ORDER BY chunk_index`,
      ).all(input.episodeId, input.timelineHash, currentSnapshot.chunks.length) as unknown as ChunkRow[];
      if (JSON.stringify(currentSnapshot) !== JSON.stringify(snapshot) ||
          sha256(JSON.stringify(exportIdentity(currentSnapshot, currentRows))) !== exportHash ||
          JSON.stringify(currentRows) !== JSON.stringify(rows)) {
        throw new Error("最终导出期间当前渲染身份已变化");
      }
      if (input.signal?.aborted) throw new JobCancelledError();
      publishDirectorySync(target, staging, publishRenameNow, publishRemoveNow);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* 保留原始发布错误。 */ }
      throw error;
    }
    return { manifest, manifestPath, finalPath, reused: false };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function writeDurable(path: string, content: string) {
  const handle = await open(path, "wx");
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}

export function createFinalVideoJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  dependencies: Partial<FinalVideoDependencies> = {},
): JobHandler {
  return async (context: JobExecutionContext) => {
    const payload = context.job.payload as { episodeId?: unknown; timelineHash?: unknown } | null;
    if (!payload || typeof payload.episodeId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(payload.episodeId) ||
        typeof payload.timelineHash !== "string" || !/^[0-9a-f]{64}$/u.test(payload.timelineHash)) {
      throw new Error("最终导出任务参数无效");
    }
    const controller = new AbortController();
    const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
    try {
      const result = await exportFinalVideo(database, dataRoot, {
        episodeId: payload.episodeId, timelineHash: payload.timelineHash, signal: controller.signal,
      }, dependencies);
      context.throwIfCancellationRequested();
      context.reportProgress(1);
      return {
        episodeId: result.manifest.episodeId,
        scriptVersionId: result.manifest.scriptVersionId,
        approvalRevision: result.manifest.approvalRevision,
        timelineHash: result.manifest.timelineHash,
        finalHash: result.manifest.exportHash,
        video: result.manifest.finalVideo,
        manifestRelativePath: `${dirname(result.manifest.finalVideo.relativePath).split(sep).join("/")}/manifest.json`,
        reused: result.reused,
      };
    } finally {
      clearInterval(poll);
    }
  };
}
