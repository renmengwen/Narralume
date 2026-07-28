import { useEffect, useState, type FormEvent } from "react";

import type { EpisodeDurationPolicy } from "../episode/episode-editor";
import type { Chapter } from "../types";
import {
  formatPipelineDuration,
  pipelineCreateInput,
  pipelineRangeCount,
  type PipelineCreateInput,
} from "./pipeline-logic";

export function PipelineSetup({ chapters, chapterTotal, policy, loading, submitting, operation, error, onCreate }: {
  chapters: Chapter[];
  chapterTotal: number;
  policy?: EpisodeDurationPolicy;
  loading: boolean;
  submitting: boolean;
  operation: string;
  error?: string;
  onCreate: (input: PipelineCreateInput) => void;
}) {
  const [startId, setStartId] = useState("");
  const [endId, setEndId] = useState("");
  const [episodeCount, setEpisodeCount] = useState("");
  const [targetDurationSeconds, setTargetDurationSeconds] = useState<number>();
  const [validationError, setValidationError] = useState<string>();

  useEffect(() => {
    if (!chapters.length) return;
    setStartId((current) => current || chapters[0]!.id);
    setEndId((current) => current || chapters.at(-1)!.id);
  }, [chapters]);

  useEffect(() => {
    if (policy) setTargetDurationSeconds((current) => current ?? policy.defaultSeconds);
  }, [policy]);

  const rangeCount = pipelineRangeCount(chapters, startId, endId);
  const totalDuration = Number(episodeCount) * (targetDurationSeconds ?? 0);
  const disabled = loading || submitting || !policy || !chapters.length;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!policy || disabled) return;
    try {
      const input = pipelineCreateInput({
        episodeCount: Number(episodeCount),
        targetDurationSeconds: targetDurationSeconds ?? Number.NaN,
        sourceStartChapterId: startId,
        sourceEndChapterId: endId,
      }, chapters, policy);
      setValidationError(undefined);
      onCreate(input);
    } catch (cause) {
      setValidationError((cause as Error).message);
    }
  }

  return <section className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] p-[clamp(20px,4vw,44px)]" aria-labelledby="pipeline-setup-heading">
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="max-w-3xl">
        <p className="mb-2 font-mono text-[11px] font-semibold tracking-[.14em] text-[var(--accent)]">全本改写 / 设置</p>
        <h2 id="pipeline-setup-heading" className="m-0 text-2xl font-semibold tracking-[-.02em]">确认范围、总集数与单集时长</h2>
        <p className="mt-3 text-sm leading-7 text-[var(--fg-secondary)]">启动一次后，固定流水线将依次补齐章节分析、故事圣经、全书计划、忠实稿和包装稿。稿件与媒体仍由你逐集审核。</p>
      </div>

      <div className="min-h-11 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3 text-sm text-[var(--fg-secondary)]" role="status" aria-live="polite">
        <span className="font-semibold text-[var(--fg-primary)]">当前状态：</span>{operation}
      </div>
      {error || validationError ? <div className="border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]" role="alert">{validationError ?? error}</div> : null}

      <form className="grid gap-5" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          <label className="grid gap-2 text-sm font-semibold">起始章节
            <select className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 font-normal" disabled={disabled} value={startId} onChange={(event) => setStartId(event.target.value)}>
              {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.chapter_index + 1} 章 · {chapter.title}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold">结束章节
            <select className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 font-normal" disabled={disabled} value={endId} onChange={(event) => setEndId(event.target.value)}>
              {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>第 {chapter.chapter_index + 1} 章 · {chapter.title}</option>)}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold">总集数
            <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 font-mono font-normal" type="number" min="1" max="1000" step="1" inputMode="numeric" placeholder="例如 100" disabled={disabled} value={episodeCount} onChange={(event) => setEpisodeCount(event.target.value)} />
          </label>
          <label className="grid gap-2 text-sm font-semibold">单集目标时长（秒）
            <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-canvas)] px-3 font-mono font-normal" type="number" min={policy?.minimumSeconds} max={policy?.maximumSeconds} step={policy?.stepSeconds} disabled={disabled} value={targetDurationSeconds ?? ""} onChange={(event) => setTargetDurationSeconds(Number(event.target.value))} />
            {policy ? <span className="text-xs font-normal text-[var(--fg-tertiary)]">允许 {policy.minimumSeconds}～{policy.maximumSeconds} 秒，按 {policy.stepSeconds} 秒递增。</span> : null}
          </label>
        </div>

        <dl className="grid grid-cols-3 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] max-md:grid-cols-1">
          <Fact label="原著章节" value={`${chapterTotal} 章`} />
          <Fact label="选中范围" value={rangeCount ? `${rangeCount} 章` : "范围待修正"} />
          <Fact label="总目标时长" value={formatPipelineDuration(totalDuration)} />
        </dl>
        <p className="m-0 text-xs leading-6 text-[var(--fg-tertiary)]">已有章节事件将在启动后由服务端按真实输入身份复用；创建成功后显示实际复用数量。</p>
        <div className="flex justify-end">
          <button className="min-h-11 rounded border border-transparent bg-[var(--accent)] px-5 text-sm font-semibold text-[var(--accent-contrast)] hover:bg-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={disabled || !episodeCount || !rangeCount}>
            {submitting ? "正在创建全本改写任务…" : "开始全本改写"}
          </button>
        </div>
      </form>
    </div>
  </section>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1 border-r border-[var(--border-subtle)] px-4 py-3 last:border-r-0 max-md:border-r-0 max-md:border-b max-md:last:border-b-0">
    <dt className="text-xs text-[var(--fg-tertiary)]">{label}</dt>
    <dd className="m-0 font-mono text-sm font-semibold">{value}</dd>
  </div>;
}
