import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import type { Chapter } from "../types";
import { pipelineIsTerminal, pipelineStatusPresentation, pipelineStatusText, type SeriesPipelineRun } from "./pipeline-logic";

type ControlAction = "pause" | "resume" | "retry" | "cancel";

export function PipelineProgress({ run, chapters, busyAction, operation, error, onControl, onReset }: {
  run: SeriesPipelineRun;
  chapters: Chapter[];
  busyAction?: string;
  operation: string;
  error?: string;
  onControl: (action: ControlAction) => void;
  onReset: () => void;
}) {
  const chapterName = (id: string) => {
    const chapter = chapters.find((item) => item.id === id);
    return chapter ? `第 ${chapter.chapter_index + 1} 章 · ${chapter.title}` : id;
  };
  const chapter = run.progress.chapterAnalysis;
  const story = run.progress.storyBible;
  const presentation = pipelineStatusPresentation(run.status);
  const primaryAction = run.actions.canResume ? "resume" : run.actions.canRetry ? "retry" : undefined;
  const primaryLabel = primaryAction === "resume" ? "继续全本改写" : "重试失败章节";
  const stateMessage = run.current
    ? `当前对象：${chapterName(run.current.subjectId)}；任务 ${run.current.jobId}`
    : pipelineStatusText(run);

  return <section className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[clamp(20px,4vw,44px)]" aria-labelledby="pipeline-progress-heading">
    <div className="mx-auto grid max-w-6xl gap-5">
      <div className="flex items-start justify-between gap-4 max-md:flex-col">
        <div>
          <p className="mb-2 font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">全本改写 / 真实进度</p>
          <h2 id="pipeline-progress-heading" className="m-0 text-2xl font-semibold tracking-[-.02em]">{presentation.heading}</h2>
          <p className="mt-2 font-mono text-xs text-[var(--fg-tertiary)]">RUN {run.id}</p>
        </div>
        <span className="min-h-11 border border-[var(--border-strong)] bg-[var(--bg-subtle)] px-4 py-3 text-sm font-semibold">状态：{presentation.label}</span>
      </div>

      <div className="min-h-11 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--fg-secondary)]" role="status" aria-live="polite">
        <span className="font-semibold text-[var(--fg-primary)]">当前进展：</span>{stateMessage}
        <span className="mt-1 block text-xs text-[var(--fg-tertiary)]">{operation}</span>
      </div>
      {error ? <div className="border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]" role="alert">{error}</div> : null}

      <dl className="grid grid-cols-4 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] max-md:grid-cols-2 max-sm:grid-cols-1" aria-label="本次全本改写冻结设置">
        <RunFact label="总集数" value={`${run.episodeCount}集`} />
        <RunFact label="单集时长" value={`${run.targetDurationSeconds}秒`} />
        <RunFact label="每批最多章节" value={`${run.chapterBatchSize}章`} />
        <RunFact label="并发批次" value={`${run.chapterConcurrency}批`} />
      </dl>

      <div className="grid border border-[var(--border-subtle)]" aria-label="全本改写阶段进度">
        <ProgressRow label="章节事件分析" count={`${chapter.completed}/${chapter.total}`} detail={`复用 ${chapter.reused} · 排队 ${chapter.queued} · 执行中 ${chapter.running} · 失败 ${chapter.failed}`} />
        <ProgressRow label="故事圣经构建" count={story.steps ? `${story.steps.completed}/${story.steps.total}` : `${story.completed}/${story.total}`} detail={stageDetail(run, "storyBible")} />
        <ProgressRow label="全书分集规划" count={`${run.progress.episodePlan.completed}/${run.progress.episodePlan.total}`} detail={stageDetail(run, "episodePlan")} />
        <ProgressRow label="忠实稿与包装稿" count={`${run.progress.scripts.completed}/${run.progress.scripts.total}`} detail={stageDetail(run, "scripts")} />
      </div>

      {run.failures.length ? <section className="border border-[var(--danger)] bg-[var(--danger-soft)]" aria-labelledby="pipeline-failures-heading">
        <h3 id="pipeline-failures-heading" className="m-0 border-b border-[var(--danger)] px-4 py-3 text-sm font-semibold text-[var(--danger)]">失败章节 {run.failures.length} 项</h3>
        <ul className="m-0 list-none p-0">
          {run.failures.map((failure) => <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-[color-mix(in_srgb,var(--danger)_35%,transparent)] px-4 py-3 last:border-b-0 max-md:grid-cols-1" key={`${failure.subjectId}:${failure.jobId}`}>
            <span><strong className="block text-sm">{chapterName(failure.subjectId)}</strong><span className="mt-1 block text-xs text-[var(--danger)]">{failure.message}</span></span>
            <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">{failure.jobId}</span>
          </li>)}
        </ul>
      </section> : null}

      <div className="flex flex-wrap justify-end gap-2">
        {pipelineIsTerminal(run) ? <button type="button" className="min-h-11 rounded border border-[var(--accent)] bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] disabled:opacity-50" disabled={!!busyAction} onClick={onReset}>返回全本改写设置</button> : null}
        {run.actions.canPause ? <button type="button" className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm font-semibold hover:bg-[var(--bg-subtle)] disabled:opacity-50" disabled={!!busyAction} onClick={() => onControl("pause")}>{busyAction === "pause" ? "正在暂停当前任务…" : "暂停当前任务"}</button> : null}
        {primaryAction ? <button type="button" className="min-h-11 rounded border border-transparent bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] disabled:opacity-50" disabled={!!busyAction} onClick={() => onControl(primaryAction)}>{busyAction === primaryAction ? operation : primaryLabel}</button> : null}
        {run.actions.canCancel ? <AlertDialog>
          <AlertDialogTrigger asChild><button type="button" className="min-h-11 rounded border border-[var(--danger)] px-4 text-sm font-semibold text-[var(--danger)] hover:bg-[var(--danger-soft)] disabled:opacity-50" disabled={!!busyAction}>取消全本改写</button></AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>取消这次全本改写？</AlertDialogTitle><AlertDialogDescription>取消后不再派发新任务；已完成的章节事件和其他持久结果会保留。需要重新开始时可返回设置创建新任务。</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter><AlertDialogCancel>继续执行</AlertDialogCancel><AlertDialogAction disabled={!!busyAction} onClick={() => onControl("cancel")}>确认取消</AlertDialogAction></AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog> : null}
      </div>
    </div>
  </section>;
}

function RunFact({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1 border-r border-[var(--border-subtle)] px-4 py-3 last:border-r-0 max-md:[&:nth-child(2)]:border-r-0 max-sm:border-r-0">
    <dt className="text-xs text-[var(--fg-tertiary)]">{label}</dt>
    <dd className="m-0 font-mono text-sm font-semibold">{value}</dd>
  </div>;
}

function ProgressRow({ label, count, detail }: { label: string; count: string; detail: string }) {
  return <div className="grid min-h-14 grid-cols-[minmax(180px,.7fr)_auto_minmax(220px,1fr)] items-center gap-4 border-b border-[var(--border-subtle)] px-4 py-3 last:border-b-0 max-md:grid-cols-1 max-md:gap-1">
    <strong className="text-sm">{label}</strong><span className="font-mono text-sm font-semibold">{count}</span><span className="text-xs text-[var(--fg-secondary)]">{detail}</span>
  </div>;
}

function stageDetail(run: SeriesPipelineRun, stage: "storyBible" | "episodePlan" | "scripts") {
  if (run.status === "paused") return "已暂停；已完成结果保留";
  if (run.status === "cancelled") return "已取消；不再派发任务";
  if (run.status === "failed" || run.failureMessage) return "存在失败项，请检查后重试";
  const presentation = pipelineStatusPresentation(run.status);
  if (stage === "scripts" && run.status === "checking_coverage") return "稿件生成完成；正在检查完整性";
  if (presentation.activeStage === stage) {
    const steps = stage === "storyBible" ? run.progress.storyBible.steps : null;
    return steps ? `当前阶段；已完成 ${steps.completed}/${steps.total} 个构建步骤`
      : currentJobDetail(run, stage);
  }
  if (stage === "scripts" && presentation.stageDetail) return presentation.stageDetail;
  const progress = run.progress[stage];
  return progress.total > 0 && progress.completed === progress.total ? "阶段已完成" : "等待上游阶段完成";
}

function currentJobDetail(run: SeriesPipelineRun, stage: "storyBible" | "episodePlan" | "scripts") {
  const current = run.current;
  if (!current || current.jobProgress === undefined) return "当前阶段；正在等待任务进度";
  const progress = `${Math.round(current.jobProgress * 100)}%`;
  const attempt = current.jobAttempts !== undefined && current.jobAttempts > 0 && current.jobMaxAttempts !== undefined
    ? `；第 ${current.jobAttempts}/${current.jobMaxAttempts} 次执行`
    : "";
  if (current.jobStatus === "queued") {
    const attempted = current.jobAttempts !== undefined && current.jobAttempts > 0 && current.jobMaxAttempts !== undefined
      ? `；已尝试 ${current.jobAttempts}/${current.jobMaxAttempts} 次`
      : "";
    return `当前任务等待执行${attempted}`;
  }
  if (stage === "episodePlan") return `当前规划任务 ${progress}${attempt}；并发上限 ${run.chapterConcurrency}`;
  if (stage === "scripts") {
    const episode = Math.min(run.episodeCount, Math.floor(run.progress.scripts.completed / 2) + 1);
    return `正在生成第 ${episode}/${run.episodeCount} 集；当前单集任务 ${progress}${attempt}；忠实稿并发上限 ${run.chapterConcurrency}`;
  }
  return `当前任务 ${progress}${attempt}`;
}
