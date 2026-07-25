import type { SeriesProject } from "./types";

export function ProductionHeader({ series, onLeave }: { series: SeriesProject; onLeave: () => void }) {
  return (
    <header className="flex min-h-28 items-center justify-between gap-6 border-b border-[var(--border-subtle)] px-7 py-6 max-md:flex-col max-md:items-start max-md:px-4">
      <div>
        <p className="mb-2 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">NARRALUME / 系列生产</p>
        <div className="flex items-center gap-3"><h1 className="m-0 text-3xl font-semibold tracking-[-.03em]">{series.title}</h1><span className="border border-[var(--border-strong)] px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-[var(--fg-tertiary)]">SERIES</span></div>
        <p className="mt-2 text-sm text-[var(--fg-secondary)]">原文证据、阶段依赖与真实任务状态在同一工作台推进。</p>
      </div>
      <button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)] disabled:opacity-50" type="button" onClick={onLeave}>返回书库</button>
    </header>
  );
}
