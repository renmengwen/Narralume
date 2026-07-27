import type { DatabaseSync } from "node:sqlite";

import type { ChapterTextModelConfig } from "./chapter-event-analyzer.js";
import { enqueueChapterEventsAnalysisJob } from "./chapter-events-job.js";
import { getJob } from "./job-store.js";
import {
  cancelSeriesPipelineRun,
  createSeriesPipelineRun,
  finishChapterAnalysis,
  failEmptyChapterAnalysisJobs,
  getCurrentSeriesPipelineRun,
  getMappedChapterJobs,
  getSeriesPipelineRun,
  listPipelineChapters,
  listRunnableSeriesPipelineRuns,
  mapSeriesPipelineJob,
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
