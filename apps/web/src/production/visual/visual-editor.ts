import type { TtsTimeline } from "../types";
import type { VisualSegment, VisualSegmentDraft } from "./types";

export function formatTimelineTime(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}

export function visualDraft(segment: VisualSegment): VisualSegmentDraft {
  const selected = segment.assets.find((asset) => asset.selectedCandidateId);
  return {
    segmentIndex: segment.segmentIndex,
    cueStartIndex: segment.cueStartIndex,
    cueEndIndex: segment.cueEndIndex,
    motionKind: segment.motionKind,
    motionAmountPpm: segment.motionAmountPpm,
    fadeMs: segment.fadeMs,
    expectedRevision: segment.revision,
    assetIds: segment.assets.map((asset) => asset.assetId),
    selectedAssetId: selected?.assetId ?? "",
    selectedCandidateId: selected?.selectedCandidateId ?? "",
  };
}

export function nextVisualDraft(timeline: TtsTimeline, segments: VisualSegment[]): VisualSegmentDraft | undefined {
  const covered = new Set(segments.flatMap((segment) => Array.from(
    { length: segment.cueEndIndex - segment.cueStartIndex + 1 },
    (_, offset) => segment.cueStartIndex + offset,
  )));
  const firstCue = timeline.cues.find((cue) => !covered.has(cue.index));
  if (!firstCue) return undefined;
  const indexes = new Set(segments.map((segment) => segment.segmentIndex));
  let segmentIndex = 0;
  while (indexes.has(segmentIndex)) segmentIndex += 1;
  return {
    segmentIndex,
    cueStartIndex: firstCue.index,
    cueEndIndex: firstCue.index,
    motionKind: "none",
    motionAmountPpm: 0,
    fadeMs: 300,
    expectedRevision: 0,
    assetIds: [],
    selectedAssetId: "",
    selectedCandidateId: "",
  };
}

export function visualSegmentPayload(timelineHash: string, draft: VisualSegmentDraft) {
  if (!/^[0-9a-f]{64}$/u.test(timelineHash)) throw new Error("缺少有效语音时间轴");
  if (draft.cueEndIndex < draft.cueStartIndex) throw new Error("结束字幕不能早于起始字幕");
  const assetIds = [...new Set(draft.assetIds)];
  if (!assetIds.length) throw new Error("视觉段至少关联一个系列资产");
  if (!draft.selectedCandidateId || !assetIds.includes(draft.selectedAssetId)) throw new Error("请选择关联资产的一张已批准候选图");
  return {
    timelineHash,
    cueStartIndex: draft.cueStartIndex,
    cueEndIndex: draft.cueEndIndex,
    motionKind: draft.motionKind,
    motionAmountPpm: draft.motionKind === "none" ? 0 : draft.motionAmountPpm,
    fadeMs: draft.fadeMs,
    expectedRevision: draft.expectedRevision,
    assets: assetIds.map((assetId) => ({
      assetId,
      ...(assetId === draft.selectedAssetId ? { selectedCandidateId: draft.selectedCandidateId } : {}),
    })),
  };
}

export function visualPlanStatus(timeline: TtsTimeline | undefined, segments: VisualSegment[]) {
  const ordered = [...segments].sort((left, right) => left.cueStartIndex - right.cueStartIndex);
  const cueCount = timeline?.cues.length ?? 0;
  const continuous = ordered.length > 0 && ordered[0]!.cueStartIndex === 0 &&
    ordered.every((segment, index) => index === 0 || segment.cueStartIndex === ordered[index - 1]!.cueEndIndex + 1) &&
    ordered.at(-1)!.cueEndIndex === cueCount - 1;
  const productionReady = continuous && ordered.every((segment) => segment.productionReady);
  return { continuous, productionReady, suggestion: visualPlanSuggestion(timeline, ordered) };
}

function visualPlanSuggestion(timeline: TtsTimeline | undefined, ordered: VisualSegment[]) {
  const durationMs = timeline?.durationMs ?? timeline?.cues.at(-1)?.endMs ?? 0;
  const cueCount = timeline?.cues.length ?? 0;
  const targetCount = cueCount ? Math.min(cueCount, Math.max(1, Math.ceil(durationMs / 5000))) : 0;
  const openingMs = Math.min(durationMs, 15000);
  const openingCueCount = timeline?.cues.filter((cue) => cue.startMs < openingMs).length ?? 0;
  const openingMin = openingCueCount ? Math.min(openingCueCount, Math.max(1, Math.ceil(openingMs / 5000))) : 0;
  const openingMax = openingCueCount ? Math.min(openingCueCount, Math.max(openingMin, Math.ceil(openingMs / 3750))) : 0;
  const openingCount = ordered.filter((segment) => segment.startMs < openingMs && segment.endMs > 0).length;
  return { targetCount, openingCount, openingMin, openingMax };
}

export function conflictRevision(message: string) {
  const value = /revision=(\d+)/u.exec(message)?.[1];
  return value === undefined ? undefined : Number(value);
}
