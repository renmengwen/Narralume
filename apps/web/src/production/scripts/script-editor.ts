import type { JobRecord, ScriptApproval, ScriptVersion, ScriptVersionKind, TtsCalibrationSelection } from "../types";

export interface ScriptParagraphDraft { key: string; text: string; sourceIndexes: number[] }

export function emptyScriptParagraph(): ScriptParagraphDraft {
  return { key: crypto.randomUUID(), text: "", sourceIndexes: [] };
}

export function scriptDraft(version?: ScriptVersion): ScriptParagraphDraft[] {
  if (!version) return [emptyScriptParagraph()];
  return version.paragraphs.map((paragraph, index) => ({
    key: `${version.id}_${index}`,
    text: paragraph.text,
    sourceIndexes: [...new Set(paragraph.sources.map((source) => source.episodeSourceIndex))],
  }));
}

export function allowedSourceIndexes(kind: ScriptVersionKind, episodeSourceIndexes: number[], parent?: ScriptVersion) {
  return kind === "faithful"
    ? [...new Set(episodeSourceIndexes)]
    : [...new Set(parent?.paragraphs.flatMap((paragraph) => paragraph.sources.map((source) => source.episodeSourceIndex)) ?? [])];
}

export function scriptPostPayload(kind: ScriptVersionKind, paragraphs: ScriptParagraphDraft[], parent?: ScriptVersion) {
  if (kind === "packaged" && (!parent || parent.kind !== "faithful")) throw new Error("包装稿必须选择同一分集的忠实稿父版本");
  const allowed = new Set(allowedSourceIndexes(kind, [], parent));
  const normalized = paragraphs.map((paragraph) => ({
    text: paragraph.text.trim(),
    sourceIndexes: [...new Set(paragraph.sourceIndexes)],
  }));
  if (!normalized.length || normalized.some((paragraph) => !paragraph.text)) throw new Error("每个稿件分段都必须填写正文");
  if (normalized.some((paragraph) => !paragraph.sourceIndexes.length)) throw new Error("每个稿件分段至少选择一个来源");
  if (kind === "packaged" && normalized.some((paragraph) => paragraph.sourceIndexes.some((index) => !allowed.has(index)))) {
    throw new Error("包装稿只能引用忠实父稿冻结的来源");
  }
  return {
    kind,
    ...(kind === "packaged" ? { parentVersionId: parent!.id } : {}),
    paragraphs: normalized,
  };
}

export function approvalPutPayload(action: "approve" | "withdraw", approval: ScriptApproval, scriptVersionId?: string) {
  if (action === "approve" && !scriptVersionId) throw new Error("请选择要批准的包装稿版本");
  return {
    action,
    expectedRevision: approval.revision,
    ...(action === "approve" ? { scriptVersionId } : {}),
  };
}

export function episodeScriptJobMatchesIdentity(
  job: JobRecord | undefined,
  seriesId: string,
  episodeIndex: number,
  episodeId?: string,
) {
  if (job?.type !== "episode_scripts_generate" || !job.payload) return false;
  const payload = job.payload as { seriesId?: unknown; episodeIndex?: unknown; episodeId?: unknown };
  return payload.seriesId === seriesId && payload.episodeIndex === episodeIndex &&
    (episodeId === undefined || payload.episodeId === episodeId);
}

export function completedEpisodeScriptVersions(
  job: JobRecord | undefined,
  seriesId: string,
  episodeIndex: number,
  episodeId?: string,
) {
  if (job?.status !== "succeeded" || !episodeScriptJobMatchesIdentity(job, seriesId, episodeIndex, episodeId)) {
    return undefined;
  }
  const result = job.result as { faithfulVersionId?: unknown; packagedVersionId?: unknown } | null | undefined;
  return typeof result?.faithfulVersionId === "string" && typeof result.packagedVersionId === "string"
    ? { faithfulVersionId: result.faithfulVersionId, packagedVersionId: result.packagedVersionId }
    : undefined;
}

export function canStartEpisodeScriptGeneration(busy: boolean, jobActive: boolean, episodeId?: string) {
  return Boolean(episodeId) && !busy && !jobActive;
}

export function episodeScriptCalibration(selection?: TtsCalibrationSelection) {
  return selection
    ? { voice: selection.voice, rate: selection.rate, charactersPerSecond: selection.charactersPerSecond,
      calibration: { identity: "measured" as const, sampleId: selection.sampleId } }
    : { calibration: { identity: "provisional" as const } };
}

export function resolveEpisodeScriptWorkspaceStatus(
  baseStatus: string,
  job: JobRecord | undefined,
  seriesId: string,
  episodeIndex: number,
  episodeId?: string,
) {
  if (!episodeId || !episodeScriptJobMatchesIdentity(job, seriesId, episodeIndex, episodeId)) return baseStatus;
  if (job?.status === "cancelled") return "跨章骨架与长稿任务已取消";
  if (job?.status === "failed") return `跨章骨架与长稿任务失败${job.errorMessage ? `：${job.errorMessage}` : ""}`;
  return baseStatus;
}
