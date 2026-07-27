import type { DatabaseSync } from "node:sqlite";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { enqueueChapterEventsAnalysisJob } from "./chapter-events-job.js";
import {
  enqueueEpisodeScriptGenerationJob,
  type EpisodeScriptGenerationRequest,
  type ScriptHandoff,
} from "./episode-script-generation-job.js";
import { getJob } from "./job-store.js";
import {
  cancelSeriesPipelineRun,
  createSeriesPipelineRun,
  finishChapterAnalysis,
  failEmptyChapterAnalysisJobs,
  getCurrentSeriesPipelineRun,
  getMappedChapterJobs,
  getMappedScriptJobs,
  getSeriesPipelineRun,
  listPipelineChapters,
  listRunnableSeriesPipelineRuns,
  mapSeriesPipelineJob,
  mapSeriesPipelineScriptJob,
  pauseSeriesPipelineRun,
  resumeSeriesPipelineRun,
  retrySeriesPipelineRun,
  seriesPipelineView,
  setSeriesPipelineFailure,
  setSeriesPipelineStatus,
  type CreateSeriesPipelineRunInput,
} from "./series-pipeline-store.js";

export interface SeriesPipelineServiceOptions {
  database: DatabaseSync;
  dataRoot: string;
  resolveChapterTextProvider(): Promise<ChapterTextModelConfig | null>;
  scriptGenerationDefaults?: Pick<EpisodeScriptGenerationRequest,
    "voice" | "rate" | "charactersPerSecond" | "narrationOccupancy" | "calibration">;
}

export class SeriesPipelineService {
  constructor(private readonly options: SeriesPipelineServiceOptions) {}

  async create(input: CreateSeriesPipelineRunInput) {
    if (!await this.options.resolveChapterTextProvider()) {
      throw Object.assign(new Error("Narralume 文本模型尚未配置"), { statusCode: 409 });
    }
    return this.view(createSeriesPipelineRun(this.options.database, input));
  }

  current(seriesProjectId: string) {
    const run = getCurrentSeriesPipelineRun(this.options.database, seriesProjectId);
    return run ? this.view(run) : undefined;
  }

  get(id: string) {
    const run = getSeriesPipelineRun(this.options.database, id);
    return run ? this.view(run) : undefined;
  }

  pause(id: string) { return this.view(pauseSeriesPipelineRun(this.options.database, id)); }
  resume(id: string) { return this.view(resumeSeriesPipelineRun(this.options.database, id)); }
  cancel(id: string) { return this.view(cancelSeriesPipelineRun(this.options.database, id)); }
  retry(id: string) { return this.view(retrySeriesPipelineRun(this.options.database, id)); }

  private view(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>) {
    return seriesPipelineView(this.options.database, run);
  }

  async reconcile() {
    for (const candidate of listRunnableSeriesPipelineRuns(this.options.database)) {
      try {
        let run = candidate;
        if (run.status === "configured") {
          run = setSeriesPipelineStatus(this.options.database, run.id, "configured", "analyzing_chapters") ?? run;
        }
        if (run.status === "generating_scripts") {
          await this.reconcileScripts(run);
          continue;
        }
        if (run.status !== "analyzing_chapters") continue;

        const chapters = listPipelineChapters(this.options.database, run);
        failEmptyChapterAnalysisJobs(this.options.database, run.id);
        const mappings = getMappedChapterJobs(this.options.database, run.id);
        const mappedJobs = mappings.map((mapping) => ({ mapping, job: getJob(this.options.database, mapping.job_id) }));
        const completedChapterIds = new Set(chapters.filter((chapter) => chapter.hasEvents).map((chapter) => chapter.id));
        const relevantJobs = mappedJobs.filter((item) => !completedChapterIds.has(item.mapping.subject_id));
        const failed = relevantJobs.find((item) => item.job?.status === "failed" || item.job?.status === "cancelled");
        if (failed) {
          setSeriesPipelineFailure(
            this.options.database, run.id,
            failed.job!.status === "cancelled" ? "job_cancelled" : failed.job!.errorCode ?? "chapter_analysis_failed",
            failed.job!.status === "cancelled" ? "章节分析已中断，请重试该章节" : "章节分析失败，请重试该章节",
          );
          continue;
        }
        if (relevantJobs.some((item) => item.job?.status === "queued" || item.job?.status === "running")) continue;

        const mappedSubjects = new Set(mappings.map((mapping) => mapping.subject_id));
        const next = chapters.find((chapter) => !chapter.hasEvents && !mappedSubjects.has(chapter.id));
        if (!next) {
          const incomplete = relevantJobs.some((item) => item.job?.status !== "succeeded");
          if (!incomplete && chapters.every((chapter) => chapter.hasEvents)) {
            finishChapterAnalysis(this.options.database, run);
          }
          continue;
        }

        const provider = await this.options.resolveChapterTextProvider();
        if (!provider) {
          setSeriesPipelineFailure(this.options.database, run.id, "text_provider_unavailable", "Narralume 文本模型配置不可用");
          continue;
        }
        const result = await enqueueChapterEventsAnalysisJob(
          this.options.database,
          this.options.dataRoot,
          provider,
          { payload: { bookId: this.bookId(run.seriesProjectId), chapterId: next.id }, maxAttempts: 3 },
          () => getSeriesPipelineRun(this.options.database, run.id)?.status === "analyzing_chapters",
        );
        const current = getSeriesPipelineRun(this.options.database, run.id);
        if (current?.status === "analyzing_chapters") {
          mapSeriesPipelineJob(this.options.database, run.id, next.id, result.job.id);
        }
      } catch (error) {
        if (getSeriesPipelineRun(this.options.database, candidate.id)?.status === "paused") continue;
        setSeriesPipelineFailure(
          this.options.database,
          candidate.id,
          "pipeline_reconcile_failed",
          "流水线协调失败，请检查章节、模型配置或本地数据",
        );
      }
    }
  }

  private async reconcileScripts(run: NonNullable<ReturnType<typeof getSeriesPipelineRun>>) {
    const episodes = this.options.database.prepare(
      "SELECT id, episode_index FROM episodes WHERE series_project_id = ? ORDER BY episode_index",
    ).all(run.seriesProjectId) as unknown as Array<{ id: string; episode_index: number }>;
    if (episodes.length !== run.episodeCount || episodes.some((episode, index) => episode.episode_index !== index + 1)) {
      throw new Error("冻结分集与全书计划不一致");
    }
    const mappings = getMappedScriptJobs(this.options.database, run.id);
    const byEpisode = new Map(mappings.map((mapping) => [mapping.subject_id, getJob(this.options.database, mapping.job_id)]));
    let previousHandoff: ScriptHandoff | null = null;
    for (const episode of episodes) {
      const job = byEpisode.get(episode.id);
      if (job?.status === "failed" || job?.status === "cancelled") {
        setSeriesPipelineFailure(this.options.database, run.id,
          job.status === "cancelled" ? "job_cancelled" : job.errorCode ?? "script_generation_failed",
          `第 ${episode.episode_index} 集稿件生成失败，请从本集重试`);
        return;
      }
      if (job?.status === "queued" || job?.status === "running") return;
      if (job?.status === "succeeded") {
        previousHandoff = this.scriptHandoff(job);
        continue;
      }
      const provider = await this.options.resolveChapterTextProvider();
      if (!provider) {
        setSeriesPipelineFailure(this.options.database, run.id, "text_provider_unavailable", "Narralume 文本模型配置不可用");
        return;
      }
      const defaults = this.options.scriptGenerationDefaults ?? {
        voice: "Microsoft Huihui Desktop", rate: 0, charactersPerSecond: 4.5,
        narrationOccupancy: 0.8, calibration: { identity: "provisional" as const },
      };
      const queued = await enqueueEpisodeScriptGenerationJob(this.options.database, this.options.dataRoot, provider, {
        payload: {
          seriesId: run.seriesProjectId,
          episodeIndex: episode.episode_index,
          ...defaults,
          previousScriptHandoff: previousHandoff,
        },
        maxAttempts: 3,
      }, () => getSeriesPipelineRun(this.options.database, run.id)?.status === "generating_scripts");
      if (getSeriesPipelineRun(this.options.database, run.id)?.status === "generating_scripts") {
        mapSeriesPipelineScriptJob(this.options.database, run.id, episode.id, queued.job.id);
      }
      return;
    }
    setSeriesPipelineStatus(this.options.database, run.id, "generating_scripts", "checking_coverage");
  }

  private scriptHandoff(job: NonNullable<ReturnType<typeof getJob>>): ScriptHandoff {
    const handoff = (job.result as { scriptHandoff?: unknown } | null)?.scriptHandoff;
    if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) throw new Error("上一集稿件缺少连续性交接");
    const value = handoff as ScriptHandoff;
    if (typeof value.summary !== "string" || !value.summary || value.summary.length > 800 ||
        !Array.isArray(value.continuityNotes) || value.continuityNotes.length > 12 ||
        value.continuityNotes.some((note) => typeof note !== "string" || !note || note.length > 240)) {
      throw new Error("上一集稿件连续性交接无效");
    }
    return { summary: value.summary, continuityNotes: [...value.continuityNotes] };
  }

  private bookId(seriesProjectId: string) {
    const row = this.options.database.prepare("SELECT book_id FROM series_projects WHERE id = ?")
      .get(seriesProjectId) as { book_id: string } | undefined;
    if (!row) throw new Error("系列项目不存在");
    return row.book_id;
  }
}

export class SeriesPipelineWorker {
  #loop: Promise<void> | undefined;
  #stopRequested = false;
  #wake: (() => void) | undefined;

  constructor(
    private readonly service: SeriesPipelineService,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  start(pollMs = 100) {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("流水线轮询间隔无效");
    if (this.#loop) throw new Error("流水线 Worker 已启动");
    this.#stopRequested = false;
    this.#loop = (async () => {
      while (!this.#stopRequested) {
        try { await this.service.reconcile(); } catch (error) { this.onError(error); }
        if (!this.#stopRequested) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            this.#wake = () => { clearTimeout(timer); resolve(); };
          });
          this.#wake = undefined;
        }
      }
    })().finally(() => { this.#wake = undefined; this.#loop = undefined; });
  }

  poke() { this.#wake?.(); }

  async stop() {
    this.#stopRequested = true;
    this.#wake?.();
    await this.#loop;
  }
}
