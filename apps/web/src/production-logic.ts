export const PRODUCTION_STAGES = [
  { id: "events", label: "章节事件", dependsOn: [], jobTypes: ["chapter_events_replace", "chapter_events_analyze"] },
  { id: "episode", label: "故事弧与分集", dependsOn: ["events"], jobTypes: [] },
  { id: "scripts", label: "忠实稿与包装稿", dependsOn: ["episode"], jobTypes: [] },
  { id: "assets", label: "资产与候选图", dependsOn: ["scripts"], jobTypes: ["image_candidate_generate"] },
  { id: "audio", label: "TTS 与字幕", dependsOn: ["scripts"], jobTypes: ["tts_timeline"] },
  { id: "visual", label: "视觉段与渲染", dependsOn: ["assets", "audio"], jobTypes: ["render_chunks"] },
  { id: "export", label: "审核与导出", dependsOn: ["visual"], jobTypes: ["final_video"] },
] as const;

export type ProductionStageId = typeof PRODUCTION_STAGES[number]["id"];
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ProductionWorkspaceLocation {
  stage: ProductionStageId;
  chapterId?: string;
  episodeIndex?: number;
  assetId?: string;
  jobId?: string;
}

export type ProductionWorkspaceLocationUpdate = Partial<ProductionWorkspaceLocation>;

const STAGE_IDS = new Set<string>(PRODUCTION_STAGES.map((stage) => stage.id));

export function resolveProductionStage(value: string | null | undefined): ProductionStageId {
  return value && STAGE_IDS.has(value) ? value as ProductionStageId : "events";
}

export function mergeProductionWorkspaceLocation(
  current: ProductionWorkspaceLocation,
  next: ProductionWorkspaceLocationUpdate,
): ProductionWorkspaceLocation {
  return {
    stage: next.stage ?? current.stage,
    chapterId: Object.prototype.hasOwnProperty.call(next, "chapterId")
      ? next.chapterId
      : current.chapterId,
    episodeIndex: Object.prototype.hasOwnProperty.call(next, "episodeIndex")
      ? next.episodeIndex
      : current.episodeIndex,
    assetId: Object.prototype.hasOwnProperty.call(next, "assetId")
      ? next.assetId
      : current.assetId,
    jobId: Object.prototype.hasOwnProperty.call(next, "jobId")
      ? next.jobId
      : current.jobId,
  };
}

export function productionWorkspacePath(input: {
  bookId: string;
  seriesId: string;
  stage?: ProductionStageId;
  chapterId?: string;
  episodeIndex?: number;
  assetId?: string;
  jobId?: string;
}) {
  const parameters = new URLSearchParams({ book: input.bookId, series: input.seriesId });
  if (input.stage && input.stage !== "events") parameters.set("stage", input.stage);
  if (input.chapterId) parameters.set("chapter", input.chapterId);
  if (Number.isSafeInteger(input.episodeIndex) && input.episodeIndex! > 0) {
    parameters.set("episode", String(input.episodeIndex));
  }
  if (input.assetId) parameters.set("asset", input.assetId);
  if (input.jobId) parameters.set("job", input.jobId);
  return `?${parameters.toString()}`;
}

export function productionWorkspaceFromSearch(search: string) {
  const parameters = new URLSearchParams(search);
  const bookId = parameters.get("book")?.trim();
  const seriesId = parameters.get("series")?.trim();
  if (!bookId || !seriesId) return undefined;
  const rawEpisode = Number(parameters.get("episode"));
  return {
    bookId,
    seriesId,
    stage: resolveProductionStage(parameters.get("stage")),
    ...(parameters.get("chapter")?.trim() ? { chapterId: parameters.get("chapter")!.trim() } : {}),
    ...(Number.isSafeInteger(rawEpisode) && rawEpisode > 0 ? { episodeIndex: rawEpisode } : {}),
    ...(parameters.get("asset")?.trim() ? { assetId: parameters.get("asset")!.trim() } : {}),
    ...(parameters.get("job")?.trim() ? { jobId: parameters.get("job")!.trim() } : {}),
  };
}

export function normalizeJobProgress(status: JobStatus, progress: unknown) {
  if (status === "succeeded") return 100;
  const value = Number(progress);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

export function isTerminalJobStatus(status: JobStatus) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function jobStatusText(status: JobStatus) {
  if (status === "queued") return "任务已排队";
  if (status === "running") return "任务正在执行";
  if (status === "succeeded") return "任务已完成";
  if (status === "failed") return "任务失败";
  return "任务已取消";
}

export interface ImagePromptParts {
  evidence: string;
  sceneIntent: string;
  assetName: string;
  assetState?: string | null;
  subjectAction: string;
  environment: string;
  lightingComposition: string;
  styleConstraints: string;
}

export function assembleImagePrompt(parts: ImagePromptParts) {
  const fact = parts.evidence.trim();
  const intent = parts.sceneIntent.trim();
  const name = parts.assetName.trim();
  const state = parts.assetState?.trim();
  const sections = [
    fact ? `原文与批准稿事实：${fact}` : "",
    intent ? `场景意图：${intent}` : "",
    name ? `核心资产：${name}${state ? `（${state}）` : ""}` : "",
    parts.subjectAction.trim() ? `主体与动作：${parts.subjectAction.trim()}` : "",
    parts.environment.trim() ? `环境：${parts.environment.trim()}` : "",
    parts.lightingComposition.trim() ? `光线与构图：${parts.lightingComposition.trim()}` : "",
    "画幅：9:16 竖幅短视频构图，主体位于字幕安全区之外",
    parts.styleConstraints.trim() ? `风格与约束：${parts.styleConstraints.trim()}` : "",
  ].filter(Boolean);
  return sections.join("。") + "。";
}
