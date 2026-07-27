import { createHash } from "node:crypto";

import {
  limitedJson,
  responseText,
  textModelRequest,
  type ChapterTextModelConfig,
} from "./chapter-event-analyzer.js";
import {
  FULL_BOOK_PLAN_JOB_CONTRACT_VERSION,
  buildFullBookPlanFinalRequest,
  buildFullBookPlanIntervalRequests,
  parseFullBookPlanFinalResponse,
  parseFullBookPlanIntervalResponse,
  type FullBookPlanBuildLimits,
  type FullBookPlanIntervalRequest,
} from "./full-book-plan-job.js";
import { JobCancelledError, type JobHandler } from "./job-worker.js";

export const FULL_BOOK_PLAN_JOB_TYPE = "full_book_plan_build";

export interface FullBookPlanJobPayload {
  contractVersion: typeof FULL_BOOK_PLAN_JOB_CONTRACT_VERSION;
  bookId: string;
  storyBible: { id: string; contentHash: string };
  episodeCount: number;
  intervals: FullBookPlanIntervalRequest[];
  limits: FullBookPlanBuildLimits;
  providerId: string;
  model: string;
  requestHash: string;
}

interface HandlerOptions { fetchImpl?: typeof fetch }

const HASH = /^[0-9a-f]{64}$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  }
  throw new Error("全书规划任务参数必须是有限 JSON");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function fullBookPlanJobRequestHash(
  payload: Omit<FullBookPlanJobPayload, "providerId" | "model" | "requestHash">,
) {
  return sha256(canonical({
    contractVersion: payload.contractVersion,
    bookId: payload.bookId,
    storyBible: payload.storyBible,
    episodeCount: payload.episodeCount,
    intervalIdentityHashes: payload.intervals.map(({ identityHash }) => identityHash),
    limits: payload.limits,
  }));
}

function strictKeys(value: object, expected: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function validateIntervals(payload: FullBookPlanJobPayload) {
  let previousEnd: number | undefined;
  let episodes = 0;
  for (const request of payload.intervals) {
    if (request?.kind !== "interval" || request.identity?.bookId !== payload.bookId ||
        request.identity.storyBibleId !== payload.storyBible.id ||
        request.identity.storyBibleContentHash !== payload.storyBible.contentHash ||
        request.provenance?.providerId !== payload.providerId || request.provenance?.model !== payload.model) {
      throw new Error("全书规划任务冻结身份不一致");
    }
    const chapters = request.chapterIds.map((chapterId) => ({
      chapterId,
      chapterIndex: request.sourceEvents.find((event) => event.chapterId === chapterId)?.chapterIndex ?? -1,
      sourceEvents: request.sourceEvents.filter((event) => event.chapterId === chapterId),
    }));
    const rebuilt = buildFullBookPlanIntervalRequests(
      payload.bookId,
      payload.storyBible,
      chapters,
      request.identity.episodeCount,
      { providerId: payload.providerId, model: payload.model },
      payload.limits,
    );
    if (rebuilt.length !== 1 || canonical(rebuilt[0]) !== canonical(request) ||
        (previousEnd !== undefined && request.identity.startChapterIndex !== previousEnd + 1)) {
      throw new Error("全书规划任务冻结身份不一致");
    }
    previousEnd = request.identity.endChapterIndex;
    episodes += request.identity.episodeCount;
  }
  if (episodes !== payload.episodeCount) throw new Error("全书规划区间配额总和必须恰好等于总集数");
}

function parsePayload(value: unknown, config: ChapterTextModelConfig): FullBookPlanJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      !strictKeys(value, ["bookId", "contractVersion", "episodeCount", "intervals", "limits", "model",
        "providerId", "requestHash", "storyBible"])) {
    throw new Error("全书规划任务冻结参数无效");
  }
  const payload = value as FullBookPlanJobPayload;
  if (payload.contractVersion !== FULL_BOOK_PLAN_JOB_CONTRACT_VERSION || typeof payload.bookId !== "string" ||
      payload.bookId !== payload.bookId.trim() || !payload.bookId || !Number.isSafeInteger(payload.episodeCount) ||
      payload.episodeCount < 1 || !Array.isArray(payload.intervals) || payload.intervals.length < 1 ||
      !payload.storyBible || typeof payload.storyBible !== "object" || Array.isArray(payload.storyBible) ||
      !strictKeys(payload.storyBible, ["contentHash", "id"]) || typeof payload.storyBible.id !== "string" ||
      !payload.storyBible.id || typeof payload.storyBible.contentHash !== "string" ||
      !HASH.test(payload.storyBible.contentHash) || typeof payload.providerId !== "string" ||
      typeof payload.model !== "string" || payload.providerId !== config.providerId.trim() ||
      payload.model !== config.model.trim() || typeof payload.requestHash !== "string" || !HASH.test(payload.requestHash) ||
      !payload.limits || typeof payload.limits !== "object" || Array.isArray(payload.limits) ||
      !strictKeys(payload.limits, ["maxChaptersPerInterval", "maxEventsPerInterval", "maxFinalInputBytes",
        "maxFinalIntervals", "maxInputBytesPerInterval"]) ||
      Object.values(payload.limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1) ||
      payload.intervals.length > payload.limits.maxFinalIntervals || Buffer.byteLength(canonical(payload), "utf8") > 10_000_000 ||
      fullBookPlanJobRequestHash(payload) !== payload.requestHash) {
    throw new Error("全书规划任务冻结参数无效");
  }
  validateIntervals(payload);
  return payload;
}

async function callModel(config: ChapterTextModelConfig, fetchImpl: typeof fetch, input: unknown, signal: AbortSignal) {
  const request = textModelRequest(config, [
    "你是全书分集规划器。只输出严格 JSON，不要输出 Markdown 或解释。",
    "只能引用输入中的 sourceEventIds；不得输出或推测字节范围。",
    "输出必须严格满足 request 中的集数、连续章节范围和区间配额。",
    canonical(input),
  ].join("\n"));
  const response = await fetchImpl(request.endpoint, {
    method: "POST", headers: request.headers, body: request.body, signal, redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`全书规划模型请求失败（HTTP ${response.status}）`);
  }
  try { return JSON.parse(responseText(await limitedJson(response))) as unknown; }
  catch (error) {
    if (error instanceof Error && /大小限制/u.test(error.message)) throw error;
    throw new Error("全书规划模型返回了无效 JSON");
  }
}

async function withCancellation<T>(context: Parameters<JobHandler>[0], call: (signal: AbortSignal) => Promise<T>) {
  context.throwIfCancellationRequested();
  const controller = new AbortController();
  const poll = setInterval(() => { if (context.isCancellationRequested()) controller.abort(); }, 50);
  try {
    return await call(AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
  } catch (error) {
    if (controller.signal.aborted || context.isCancellationRequested()) throw new JobCancelledError();
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("全书规划模型请求超时");
    throw error;
  } finally { clearInterval(poll); }
}

export function createFullBookPlanJobHandler(
  config: ChapterTextModelConfig,
  options: HandlerOptions = {},
): JobHandler {
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (context) => {
    if (context.job.type !== FULL_BOOK_PLAN_JOB_TYPE) throw new Error("全书规划任务类型无效");
    const task = parsePayload(context.job.payload, config);
    const verified = [];
    for (const [index, request] of task.intervals.entries()) {
      const raw = await withCancellation(context, (signal) => callModel(config, fetchImpl, {
        kind: "interval", request,
      }, signal));
      const parsed = parseFullBookPlanIntervalResponse(request, raw);
      context.throwIfCancellationRequested();
      verified.push(parsed);
      context.commitCheckpoint("full-book-plan-interval", request.identityHash, request.identityHash, () => undefined);
      context.reportProgress((index + 1) / (task.intervals.length + 1));
    }
    const finalRequest = buildFullBookPlanFinalRequest(
      task.bookId, task.storyBible, task.episodeCount, verified,
      { providerId: task.providerId, model: task.model }, task.limits,
    );
    const rawFinal = await withCancellation(context, (signal) => callModel(config, fetchImpl, {
      kind: "final", request: finalRequest,
    }, signal));
    const final = parseFullBookPlanFinalResponse(finalRequest, rawFinal);
    context.throwIfCancellationRequested();
    context.commitCheckpoint("full-book-plan-final", finalRequest.identityHash, finalRequest.identityHash, () => undefined);
    context.reportProgress(1);
    return {
      identityHash: finalRequest.identityHash,
      plan: final.content,
      planHash: final.contentHash,
      validation: {
        startChapterIndex: finalRequest.identity.startChapterIndex,
        endChapterIndex: finalRequest.identity.endChapterIndex,
        episodeCount: finalRequest.identity.episodeCount,
        sourceEvents: finalRequest.sourceEvents.map(({ id, chapterId, chapterIndex, byteRanges }) =>
          ({ id, chapterId, chapterIndex, byteRanges })),
        intervalQuotas: finalRequest.intervalQuotas,
      },
    };
  };
}
