import type { Episode } from "../types";

export interface EpisodeDraft {
  title: string;
  storyArc: string;
  targetDurationSeconds: number;
  recap: string;
  nextHook: string;
  sourceEventIds: string[];
}

export const emptyEpisodeDraft = (): EpisodeDraft => ({
  title: "", storyArc: "", targetDurationSeconds: 240, recap: "", nextHook: "", sourceEventIds: [],
});

export function episodeDraft(episode: Episode): EpisodeDraft {
  return {
    title: episode.title,
    storyArc: episode.storyArc,
    targetDurationSeconds: episode.targetDurationSeconds,
    recap: episode.recap ?? "",
    nextHook: episode.nextHook ?? "",
    sourceEventIds: [...new Set(episode.sources.map((source) => source.sourceEventId))],
  };
}

export function episodePutPayload(draft: EpisodeDraft) {
  const title = draft.title.trim();
  const storyArc = draft.storyArc.trim();
  const recap = draft.recap.trim();
  const nextHook = draft.nextHook.trim();
  const sourceEventIds = [...new Set(draft.sourceEventIds.map((id) => id.trim()).filter(Boolean))];
  if (!title) throw new Error("分集标题不能为空");
  if (!storyArc) throw new Error("故事弧不能为空");
  if (!Number.isSafeInteger(draft.targetDurationSeconds) || draft.targetDurationSeconds < 180 || draft.targetDurationSeconds > 300) {
    throw new Error("目标时长必须为 180 至 300 秒");
  }
  if (!sourceEventIds.length) throw new Error("至少选择一个章节事件作为原文证据");
  return { title, storyArc, targetDurationSeconds: draft.targetDurationSeconds, recap: recap || null, nextHook: nextHook || null, sourceEventIds };
}
