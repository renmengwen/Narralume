import type { JobRecord } from "../types";

export function completedTtsTimelineHash(job: JobRecord | undefined, episodeId: string) {
  if (!job || job.type !== "tts_timeline" || job.status !== "succeeded" ||
      job.result?.episodeId !== episodeId || typeof job.result.timelineHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(job.result.timelineHash)) return undefined;
  return job.result.timelineHash;
}
