import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { limitedJson, responseText } from "./chapter-event-analyzer.js";
import { EPISODE_DURATION_POLICY } from "./episode-policy.js";
import { createJob, getJob, type CreateJobInput, type JobRecord } from "./job-store.js";
import type { JobHandler } from "./job-worker.js";

export const EPISODE_RECOMMENDATION_JOB_TYPE = "episode_sources_recommend";

export interface EpisodeRecommendationInput {
  seriesId: string;
  episodeIndex: number;
  startChapterId?: string;
  targetDurationSeconds: number;
  endingPreference?: string;
}

interface ChapterSummary {
  id: string;
  index: number;
  title: string;
  events: Array<{ id: string; type: string; payload: Record<string, string> }>;
}

export interface EpisodeRecommendationModelInput {
  targetDurationSeconds: number;
  endingPreference: string | null;
  chapters: readonly ChapterSummary[];
  signal?: AbortSignal;
}

export type RecommendEpisodeSources = (input: EpisodeRecommendationModelInput) => Promise<{
  chapterIds: string[];
  eventIds: string[];
  estimatedCharacterCount: number;
  advice: "保留" | "压缩";
}>;

interface FrozenPayload extends EpisodeRecommendationInput {
  bookId: string;
  requestedStartChapterId: string | null;
  startChapterId: string;
  summaryHash: string;
  requestHash: string;
}

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }

function summaries(database: DatabaseSync, seriesId: string, episodeIndex: number, requestedStart?: string) {
  const project = database.prepare("SELECT book_id FROM series_projects WHERE id = ?").get(seriesId) as { book_id: string } | undefined;
  if (!project) throw new Error("系列项目不存在");
  let startChapterId = requestedStart?.trim();
  if (!startChapterId && episodeIndex > 1) {
    startChapterId = (database.prepare(
      `SELECT next.id FROM episodes previous
       JOIN episode_sources source ON source.episode_id = previous.id
       JOIN chapters current ON current.id = source.chapter_id
       JOIN chapters next ON next.book_id = current.book_id AND next.chapter_index = current.chapter_index + 1
       WHERE previous.series_project_id = ? AND previous.episode_index = ?
       ORDER BY current.chapter_index DESC LIMIT 1`,
    ).get(seriesId, episodeIndex - 1) as { id: string } | undefined)?.id;
    if (!startChapterId) throw new Error("上一集不存在或已到故事结尾，请明确选择故事起始章节");
  }
  const start = startChapterId
    ? database.prepare("SELECT id, chapter_index FROM chapters WHERE id = ? AND book_id = ?").get(startChapterId, project.book_id) as { id: string; chapter_index: number } | undefined
    : database.prepare("SELECT id, chapter_index FROM chapters WHERE book_id = ? ORDER BY chapter_index LIMIT 1").get(project.book_id) as { id: string; chapter_index: number } | undefined;
  if (!start) throw new Error(requestedStart ? "故事起始章节不属于当前书籍" : "没有可继续推荐的章节");
  const rows = database.prepare(
    `SELECT id, chapter_index, title FROM chapters
     WHERE book_id = ? AND chapter_index >= ? ORDER BY chapter_index`,
  ).all(project.book_id, start.chapter_index) as unknown as Array<{ id: string; chapter_index: number; title: string }>;
  const chapters: ChapterSummary[] = rows.map((chapter) => ({
    id: chapter.id,
    index: chapter.chapter_index,
    title: chapter.title,
    events: (database.prepare(
      "SELECT id, event_type, payload_json FROM chapter_events WHERE chapter_id = ? ORDER BY event_index",
    ).all(chapter.id) as unknown as Array<{ id: string; event_type: string; payload_json: string }>).map((event) => ({
      id: event.id, type: event.event_type, payload: JSON.parse(event.payload_json) as Record<string, string>,
    })),
  }));
  const firstMissing = chapters.findIndex((chapter) => chapter.events.length === 0);
  const available = firstMissing < 0 ? chapters : chapters.slice(0, firstMissing);
  if (Buffer.byteLength(JSON.stringify(available), "utf8") > 1024 * 1024) {
    throw new Error("连续章节事件摘要超过推荐安全上限，请选择更靠后的故事起点");
  }
  return {
    bookId: project.book_id,
    startChapterId: start.id,
    chapters: available,
    missingChapter: firstMissing < 0 ? undefined : chapters[firstMissing],
  };
}

function validateDuration(value: number) {
  if (!Number.isSafeInteger(value) || value < EPISODE_DURATION_POLICY.minimumSeconds || value > EPISODE_DURATION_POLICY.maximumSeconds) {
    throw new Error(`目标时长必须为 ${EPISODE_DURATION_POLICY.minimumSeconds} 至 ${EPISODE_DURATION_POLICY.maximumSeconds} 秒`);
  }
}

export function enqueueEpisodeRecommendationJob(database: DatabaseSync, input: EpisodeRecommendationInput, job: Omit<CreateJobInput, "id" | "type" | "payload"> = {}) {
  if (!Number.isSafeInteger(input.episodeIndex) || input.episodeIndex < 1) throw new Error("分集序号必须从 1 开始");
  validateDuration(input.targetDurationSeconds);
  const source = summaries(database, input.seriesId.trim(), input.episodeIndex, input.startChapterId);
  const summaryHash = sha256(JSON.stringify(source.chapters));
  const identity = {
    seriesId: input.seriesId.trim(), episodeIndex: input.episodeIndex, bookId: source.bookId,
    requestedStartChapterId: input.startChapterId?.trim() || null,
    startChapterId: source.startChapterId, targetDurationSeconds: input.targetDurationSeconds,
    endingPreference: input.endingPreference?.trim() || undefined, summaryHash,
  };
  const requestHash = sha256(JSON.stringify({ contract: "episode-sources-recommend-v1", ...identity }));
  const payload: FrozenPayload = { ...identity, requestHash };
  const id = `job_episode_recommend_${requestHash}`;
  const existing = getJob(database, id);
  if (existing) return { job: existing, created: false };
  return { job: createJob(database, { ...job, id, type: EPISODE_RECOMMENDATION_JOB_TYPE, payload }), created: true };
}

export function createEpisodeRecommendationJobHandler(database: DatabaseSync, recommend: RecommendEpisodeSources): JobHandler {
  return async (context) => {
    const task = context.job.payload as FrozenPayload;
    validateDuration(task.targetDurationSeconds);
    const source = summaries(database, task.seriesId, task.episodeIndex, task.requestedStartChapterId ?? undefined);
    if (source.bookId !== task.bookId || source.startChapterId !== task.startChapterId ||
        sha256(JSON.stringify(source.chapters)) !== task.summaryHash) throw new Error("章节事件摘要在推荐排队后已变化，请重新推荐");
    if (source.missingChapter && !source.chapters.length) return {
      status: "needs_analysis", startChapterId: task.startChapterId,
      missingChapters: [{ id: source.missingChapter.id, title: source.missingChapter.title }],
    };
    if (!source.chapters.length) throw new Error("起始章节缺少结构化事件分析");
    context.throwIfCancellationRequested();
    const controller = new AbortController();
    const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
    let proposed: Awaited<ReturnType<RecommendEpisodeSources>>;
    try {
      proposed = await recommend({
        targetDurationSeconds: task.targetDurationSeconds,
        endingPreference: task.endingPreference?.trim() || null,
        chapters: source.chapters,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      });
    } finally { clearInterval(poll); }
    context.throwIfCancellationRequested();
    const chapterIds = [...new Set(proposed.chapterIds)];
    const eventIds = [...new Set(proposed.eventIds)];
    if (!chapterIds.length || chapterIds.some((id, index) => source.chapters[index]?.id !== id)) {
      throw new Error("推荐模型返回了伪造或不连续的章节 ID");
    }
    const selected = new Set(chapterIds);
    const events = new Map(source.chapters.flatMap((chapter) => chapter.events.map((event) => [event.id, { ...event, chapterId: chapter.id }] as const)));
    if (!eventIds.length || eventIds.some((id) => !events.has(id) || !selected.has(events.get(id)!.chapterId))) {
      throw new Error("推荐模型返回了伪造或越界的事件 ID");
    }
    if (!Number.isSafeInteger(proposed.estimatedCharacterCount) || proposed.estimatedCharacterCount < 1 || proposed.estimatedCharacterCount > 1_000_000 ||
        (proposed.advice !== "保留" && proposed.advice !== "压缩")) throw new Error("推荐模型返回的预算建议无效");
    context.reportProgress(1);
    return {
      status: "recommended", startChapterId: chapterIds[0], endChapterId: chapterIds.at(-1),
      chapterIds, eventIds, events: eventIds.map((id) => events.get(id)!), estimatedCharacterCount: proposed.estimatedCharacterCount,
      estimatedDurationSeconds: task.targetDurationSeconds, targetDurationSeconds: task.targetDurationSeconds,
      advice: proposed.advice,
      missingChapters: source.missingChapter ? [{ id: source.missingChapter.id, title: source.missingChapter.title }] : [],
    };
  };
}

export function createOpenAiEpisodeRecommender(config: { baseUrl: string; apiKey: string; model: string }, fetchImpl: typeof fetch = fetch): RecommendEpisodeSources {
  const endpoint = new URL("responses", `${config.baseUrl.replace(/\/+$/, "")}/`);
  return async ({ targetDurationSeconds, endingPreference, chapters, signal }) => {
    const input = [
      "基于逐章结构化事件摘要推荐连续章节和真实事件。只输出严格 JSON。",
      "chapterIds 必须从第一章开始连续；eventIds 只能使用输入 ID。advice 只能是保留或压缩。",
      `目标时长秒数：${targetDurationSeconds}；结尾倾向：${endingPreference ?? "自然收束"}`,
      JSON.stringify(chapters),
      '输出：{"chapterIds":[],"eventIds":[],"estimatedCharacterCount":1200,"advice":"保留"}',
    ].join("\n");
    const response = await fetchImpl(endpoint, {
      method: "POST", signal, redirect: "error",
      headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, input }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`选材推荐模型请求失败（HTTP ${response.status}）`); }
    try { return JSON.parse(responseText(await limitedJson(response))) as Awaited<ReturnType<RecommendEpisodeSources>>; }
    catch { throw new Error("选材推荐模型返回了无效 JSON"); }
  };
}
