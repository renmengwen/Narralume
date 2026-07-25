import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { JobCancelledError, type JobExecutionContext, type JobHandler } from "./job-worker.js";
import { requireApprovedScriptForProduction } from "./script-approval-store.js";
import { getScriptVersion } from "./script-version-store.js";
import { renderSubtitleFiles, splitNarration, SUBTITLE_TIMELINE_CONTRACT } from "./subtitle-timeline.js";
import { synthesizeSystemSpeech, systemSpeechInputHash, TtsCancelledError } from "./tts-provider.js";

export const TTS_TIMELINE_JOB_TYPE = "tts_timeline";
const PROVIDER_ID = "windows-system-speech";
const DEFAULT_VOICE = "Microsoft Huihui Desktop";
const MAX_PROCESS_OUTPUT = 64 * 1024;

interface AudioProbe {
  bytes: number;
  durationMs: number;
}

interface TimelineDependencies {
  synthesize: typeof synthesizeSystemSpeech;
  probe: (path: string, signal?: AbortSignal) => Promise<AudioProbe>;
}

interface SegmentArtifact extends AudioProbe {
  index: number;
  speechText: string;
  subtitleText: string;
  inputHash: string;
  relativePath: string;
  fileHash: string;
  reused: boolean;
}

function sha256File(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .once("error", reject)
      .once("end", () => resolvePromise(hash.digest("hex")));
  });
}

export async function probeSystemSpeechWav(path: string, signal?: AbortSignal): Promise<AudioProbe> {
  const info = await stat(path);
  const child = spawn("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,channels,sample_rate:format=duration,size",
    "-of", "json",
    path,
  ], { windowsHide: true, shell: false, signal });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.length > MAX_PROCESS_OUTPUT) { overflow = true; child.kill(); }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > MAX_PROCESS_OUTPUT) { overflow = true; child.kill(); }
  });
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", resolvePromise);
  });
  if (signal?.aborted) throw new JobCancelledError();
  if (overflow) throw new Error("ffprobe 输出超过 64 KiB 限制");
  if (code !== 0) throw new Error(`ffprobe 校验音频失败${stderr.trim() ? `：${stderr.trim()}` : ""}`);
  let parsed: {
    streams?: Array<{ codec_type?: string; codec_name?: string; channels?: number; sample_rate?: string }>;
    format?: { duration?: string; size?: string };
  };
  try { parsed = JSON.parse(stdout) as typeof parsed; } catch { throw new Error("ffprobe 返回了无效 JSON"); }
  const audio = parsed.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  const audioStream = audio[0];
  const hasVideo = parsed.streams?.some((stream) => stream.codec_type === "video") ?? false;
  const durationMs = Math.floor(Number(parsed.format?.duration) * 1_000);
  const reportedBytes = Number(parsed.format?.size);
  if (audio.length !== 1 || !audioStream || hasVideo || audioStream.codec_name !== "pcm_s16le" ||
      audioStream.channels !== 1 || audioStream.sample_rate !== "22050" ||
      !Number.isSafeInteger(durationMs) || durationMs < 1 || reportedBytes !== info.size) {
    throw new Error("本机语音 WAV 编码、声道、采样率、大小或时长无效");
  }
  return { bytes: info.size, durationMs };
}

function absoluteArtifactPath(dataRoot: string, relativePath: string) {
  const root = resolve(dataRoot);
  const absolute = resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) throw new Error("音频产物路径越界");
  return absolute;
}

function relativeArtifactPath(dataRoot: string, absolutePath: string) {
  return relative(resolve(dataRoot), absolutePath).split(sep).join("/");
}

function taskPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("语音时间轴任务参数无效");
  const payload = value as { episodeId?: unknown; voice?: unknown; rate?: unknown };
  if (typeof payload.episodeId !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload.episodeId)) {
    throw new Error("语音时间轴任务缺少有效分集 ID");
  }
  const voice = payload.voice === undefined ? DEFAULT_VOICE : payload.voice;
  const rate = payload.rate === undefined ? 0 : payload.rate;
  if (typeof voice !== "string" || !voice.trim() || !Number.isInteger(rate) || (rate as number) < -10 || (rate as number) > 10) {
    throw new Error("本机语音配置无效");
  }
  return { episodeId: payload.episodeId, voice: voice.trim(), rate: rate as number };
}

async function durableText(path: string, content: string) {
  try {
    if (await readFile(path, "utf8") !== content) throw new Error("已存在的字幕产物与时间轴身份不一致");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const file = await open(temporary, "wx");
    try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createTtsTimelineJobHandler(
  database: DatabaseSync,
  dataRoot: string,
  dependencies: Partial<TimelineDependencies> = {},
): JobHandler {
  const synthesize = dependencies.synthesize ?? synthesizeSystemSpeech;
  const probe = dependencies.probe ?? probeSystemSpeechWav;
  return async (context: JobExecutionContext) => {
    const { episodeId, voice, rate } = taskPayload(context.job.payload);
    const permit = requireApprovedScriptForProduction(database, episodeId, "tts");
    const script = getScriptVersion(database, permit.scriptVersionId);
    if (!script || script.kind !== "packaged") throw new Error("批准包装稿不存在");
    const audioDirectory = resolve(dataRoot, "episodes", episodeId, "audio");
    await mkdir(resolve(audioDirectory, "segments"), { recursive: true });
    const segments: SegmentArtifact[] = [];

    const units = script.paragraphs.flatMap((paragraph) => splitNarration(paragraph.text));
    for (const [index, unit] of units.entries()) {
      context.throwIfCancellationRequested();
      const text = unit.speechText;
      const inputHash = systemSpeechInputHash({ text, scriptVersionId: script.id, contentHash: script.contentHash, voice, rate, contractVersion: SUBTITLE_TIMELINE_CONTRACT });
      const path = resolve(audioDirectory, "segments", `${inputHash}.wav`);
      const relativePath = relativeArtifactPath(dataRoot, path);
      const stored = database.prepare(
        `SELECT relative_path, file_hash, bytes, duration_ms FROM audio_segments
         WHERE script_version_id = ? AND segment_index = ? AND input_hash = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(script.id, index, inputHash) as { relative_path: string; file_hash: string; bytes: number; duration_ms: number } | undefined;
      let reused = false;
      let measured: AudioProbe | undefined;
      if (stored) {
        if (stored.relative_path !== relativePath) throw new Error("已登记音频段路径不一致");
        measured = await probe(absoluteArtifactPath(dataRoot, stored.relative_path));
        if (measured.bytes !== stored.bytes || measured.durationMs !== stored.duration_ms ||
            await sha256File(path) !== stored.file_hash) throw new Error("已登记音频段文件已损坏");
        reused = true;
      } else {
        let orphanExists = true;
        try { await stat(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") orphanExists = false;
          else throw error;
        }
        if (orphanExists) {
          try {
            measured = await probe(path);
            reused = true;
          } catch (error) {
            if (error instanceof JobCancelledError) throw error;
            await rm(path, { force: true });
            orphanExists = false;
          }
        }
        if (!orphanExists) {
          const controller = new AbortController();
          const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
          try {
            await synthesize({ text, outputPath: path, scriptVersionId: script.id, contentHash: script.contentHash, voice, rate, contractVersion: SUBTITLE_TIMELINE_CONTRACT, signal: controller.signal });
          } catch (error) {
            if (error instanceof TtsCancelledError) throw new JobCancelledError();
            throw error;
          } finally {
            clearInterval(poll);
          }
          measured = await probe(path);
        }
      }
      if (!measured) throw new Error("音频段未生成有效探测结果");
      segments.push({ index, speechText: text, subtitleText: unit.subtitleText, inputHash, relativePath, fileHash: await sha256File(path), ...measured, reused });
      context.reportProgress((index + 1) / (units.length + 1));
    }

    context.throwIfCancellationRequested();
    const timelineHash = createHash("sha256").update(JSON.stringify({
      contract: SUBTITLE_TIMELINE_CONTRACT, scriptVersionId: script.id, voice, rate,
      segments: segments.map(({ inputHash, fileHash, durationMs }) => ({ inputHash, fileHash, durationMs })),
    })).digest("hex");
    let cursor = 0;
    const cues = segments.map((segment) => {
      const startMs = cursor;
      cursor += segment.durationMs;
      return { index: segment.index, text: segment.subtitleText, startMs, endMs: cursor };
    });
    const totalDurationMs = cursor;
    const srtPath = resolve(audioDirectory, `${timelineHash}.srt`);
    const assPath = resolve(audioDirectory, `${timelineHash}.ass`);
    const rendered = renderSubtitleFiles(cues);
    await durableText(srtPath, rendered.srt);
    await durableText(assPath, rendered.ass);
    context.throwIfCancellationRequested();
    const createdAt = Date.now();
    context.commitCheckpoint("tts-timeline", episodeId, timelineHash, (transaction) => {
      const current = requireApprovedScriptForProduction(database, episodeId, "tts");
      if (current.scriptVersionId !== permit.scriptVersionId || current.approvalRevision !== permit.approvalRevision) {
        throw new Error("语音生成期间批准稿已变化，本次结果不登记");
      }
      for (const segment of segments) transaction.run(
        `INSERT OR IGNORE INTO audio_segments (
          timeline_hash, segment_index, episode_id, script_version_id, text, provider_id, voice, rate,
          input_hash, relative_path, file_hash, bytes, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        timelineHash, segment.index, episodeId, script.id, segment.speechText, PROVIDER_ID, voice, rate,
        segment.inputHash, segment.relativePath, segment.fileHash, segment.bytes, segment.durationMs, createdAt);
      for (const cue of cues) transaction.run(
        `INSERT OR IGNORE INTO subtitle_cues (
          timeline_hash, cue_index, segment_index, episode_id, script_version_id, start_ms, end_ms, text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        timelineHash, cue.index, cue.index, episodeId, script.id, cue.startMs, cue.endMs, cue.text);
      return undefined;
    });
    context.reportProgress(1);
    return {
      episodeId, scriptVersionId: script.id, timelineHash, durationMs: totalDurationMs,
      segmentCount: segments.length, cueCount: cues.length,
      srtRelativePath: relativeArtifactPath(dataRoot, srtPath),
      assRelativePath: relativeArtifactPath(dataRoot, assPath),
      reusedSegments: segments.filter((segment) => segment.reused).length,
    };
  };
}
