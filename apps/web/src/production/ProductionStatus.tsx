import { isTerminalJobStatus, normalizeJobProgress } from "../production-logic";
import type { JobRecord } from "./types";

export function ProductionStatus({ status, busy, job, onCancel }: { status: string; busy: boolean; job?: JobRecord; onCancel: () => void }) {
  const progress = job ? normalizeJobProgress(job.status, job.progress) : 0;
  const active = !!job && !isTerminalJobStatus(job.status);
  return <div className="grid min-h-11 grid-cols-[auto_minmax(180px,1fr)_140px_auto_auto] items-center gap-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-7 text-[13px] text-[var(--fg-secondary)] max-md:grid-cols-[auto_1fr] max-md:px-4" role="status" aria-live="polite">
    <span className={`h-1.5 w-1.5 rounded-full ${busy || active ? "animate-pulse bg-[var(--accent)]" : "bg-[var(--fg-tertiary)]"}`} aria-hidden="true" /><span>{status}</span>
    {job ? <><progress className="h-1 w-36 accent-[var(--accent)] max-md:col-start-2" max="100" value={progress}>{progress}%</progress><span>{progress}%</span></> : null}
    {active ? <button type="button" className="border-0 bg-transparent text-xs font-semibold text-[var(--accent)] disabled:opacity-50" disabled={busy} onClick={onCancel}>取消任务</button> : null}
  </div>;
}
