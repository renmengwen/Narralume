import type { ScriptApproval, ScriptVersion, ScriptVersionKind } from "../types";

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
