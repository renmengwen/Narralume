import type { JobRecord, TtsCalibrationSelection, TtsTimeline } from "../types";

export const AUDIO_SEGMENTS_PER_PAGE = 24;
export const REPRESENTATIVE_AUDIO_SEGMENTS = [0, 1, 2, 60, 100, 140, 180, 200, 220, 261] as const;

export function completedTtsTimelineHash(job: JobRecord | undefined, episodeId: string) {
  if (!job || job.type !== "tts_timeline" || job.status !== "succeeded" ||
      job.result?.episodeId !== episodeId || typeof job.result.timelineHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(job.result.timelineHash)) return undefined;
  return job.result.timelineHash;
}

export function completedTtsCalibrationMode(job: JobRecord | undefined, episodeId: string) {
  if (!job || job.type !== "tts_calibration" || job.status !== "succeeded" ||
      job.result?.episodeId !== episodeId || (job.result.mode !== "generate" && job.result.mode !== "select")) return undefined;
  return job.result.mode;
}

export function ttsTimelinePayload(
  episodeId: string,
  voice: string,
  rate: number,
  selection?: TtsCalibrationSelection,
) {
  return {
    episodeId,
    voice: selection?.voice ?? voice.trim(),
    rate: selection?.rate ?? rate,
  };
}

export function audioPageCount(segmentCount: number, pageSize = AUDIO_SEGMENTS_PER_PAGE) {
  return Math.max(1, Math.ceil(Math.max(0, segmentCount) / pageSize));
}

export function clampAudioPage(page: number, segmentCount: number, pageSize = AUDIO_SEGMENTS_PER_PAGE) {
  return Math.min(Math.max(0, page), audioPageCount(segmentCount, pageSize) - 1);
}

export function audioSegmentsForPage<T>(segments: T[], page: number, pageSize = AUDIO_SEGMENTS_PER_PAGE) {
  const current = clampAudioPage(page, segments.length, pageSize);
  return segments.slice(current * pageSize, current * pageSize + pageSize);
}

export function audioSegmentUrl(timeline: Pick<TtsTimeline, "episodeId" | "timelineHash">, index: number) {
  return `/api/episodes/${encodeURIComponent(timeline.episodeId)}/tts-timelines/${encodeURIComponent(timeline.timelineHash)}/audio/${index}`;
}
