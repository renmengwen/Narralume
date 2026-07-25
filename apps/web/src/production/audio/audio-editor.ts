import type { JobRecord, TtsCalibrationSelection } from "../types";

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
