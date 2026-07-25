import type { JobRecord } from "../types";
import { useAudioWorkspace } from "./use-audio-workspace";

export function AudioStage(props: {
  seriesId: string; episodeIndex: number; timelineHash?: string; busy: boolean; jobActive: boolean; currentJob?: JobRecord;
  setBusy: (busy: boolean) => void; setStatus: (message: string) => void;
  onEpisodeChange: (index: number) => void; onTimelineChange: (hash: string | undefined) => void; onJobCreated: (id: string) => void;
}) {
  const state = useAudioWorkspace(props);
  return <div className="grid grid-cols-[280px_minmax(0,1fr)] border-t border-[var(--border-subtle)] max-xl:grid-cols-1">
    <aside className="border-r border-[var(--border-subtle)] p-5 max-xl:border-r-0 max-xl:border-b">
      <label className="text-xs text-[var(--fg-secondary)]">分集序号<input type="number" min={1} disabled={props.busy} value={props.episodeIndex} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0) props.onEpisodeChange(value); }} className="mt-2 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
      <p className="mt-5 text-xs leading-6 text-[var(--fg-tertiary)]">首版只提供逐段试听，不冒充整集混音。时间轴和字幕身份来自持久层回读。</p>
      <p className="mt-4 break-all font-mono text-[10px] text-[var(--fg-tertiary)]">批准稿：{state.approval?.scriptVersionId ?? "未批准"}</p>
      <label className="mt-5 block text-xs text-[var(--fg-secondary)]">Windows 语音<input disabled={props.busy} value={state.voice} onChange={(event) => state.setVoice(event.target.value)} className="mt-2 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
      <label className="mt-4 block text-xs text-[var(--fg-secondary)]">语速（-10～10）<input type="number" min={-10} max={10} disabled={props.busy} value={state.rate} onChange={(event) => state.setRate(Number(event.target.value))} className="mt-2 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
      <button type="button" disabled={props.busy || props.jobActive || state.approval?.status !== "approved" || !state.voice.trim() || !Number.isInteger(state.rate) || state.rate < -10 || state.rate > 10} onClick={() => void state.createCalibration()} className="mt-5 w-full rounded border border-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--accent)] disabled:opacity-50">生成两个真实短样</button>
      <button type="button" disabled={props.busy || props.jobActive || state.approval?.status !== "approved" || !state.voice.trim() || !Number.isInteger(state.rate) || state.rate < -10 || state.rate > 10} onClick={() => void state.createTimeline()} className="mt-3 w-full rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">生成完整语音时间轴</button>
      <p className="mt-3 text-xs leading-5 text-[var(--fg-tertiary)]">{state.calibration?.selection
        ? `已选实测短样：${state.calibration.selection.voice} / rate ${state.calibration.selection.rate} / ${state.calibration.selection.charactersPerSecond.toFixed(3)} 字/秒`
        : "尚未选择短样；完整 TTS 使用当前 provisional 音色与语速。"}</p>
    </aside>
    <section className="p-6">
      {state.calibration?.samples.length ? <div className="mb-7 grid gap-4 md:grid-cols-2">{state.calibration.samples.map((sample) => <article key={sample.sampleId} className="rounded border border-[var(--border-subtle)] p-4">
        <div className="flex flex-wrap gap-3 text-xs text-[var(--fg-tertiary)]"><span>{sample.voice}</span><span>rate {sample.rate}</span><span>{formatMs(sample.durationMs)}</span><span>{sample.characterCount} 字符</span><span>{sample.charactersPerSecond.toFixed(3)} 字/秒</span></div>
        <p className="my-3 text-sm leading-6">{sample.exactText}</p>
        <audio controls preload="none" className="w-full" src={`/api/episodes/${encodeURIComponent(sample.episodeId)}/tts-calibration/${encodeURIComponent(sample.sampleId)}/audio`} />
        <button type="button" disabled={props.busy || props.jobActive || state.calibration?.selection?.sampleId === sample.sampleId} onClick={() => void state.selectCalibration(sample.sampleId)} className="mt-3 w-full rounded border border-[var(--border-subtle)] px-3 py-2 text-sm disabled:opacity-50">{state.calibration?.selection?.sampleId === sample.sampleId ? "当前已选短样" : "选择此短样"}</button>
      </article>)}</div> : null}
      {!state.episode ? <p className="rounded border border-dashed border-[var(--border-subtle)] p-8 text-sm text-[var(--fg-tertiary)]">该分集尚未创建，请先保存故事弧。</p> : !state.timeline ? <p className="rounded border border-dashed border-[var(--border-subtle)] p-8 text-sm text-[var(--fg-tertiary)]">{state.approval?.status === "approved" ? "批准稿尚无持久化语音时间轴。" : "请先在稿件阶段人工批准包装稿。"}</p> : <>
        <header className="mb-6 flex flex-wrap gap-x-8 gap-y-2 text-sm"><strong>{formatMs(state.timeline.durationMs)}</strong><span>{state.timeline.segmentCount} 段</span><span>{state.timeline.cueCount} 条 cue</span><span>复用段：{state.timeline.reusedSegments ?? "历史任务未记录"}</span><span>SRT：{state.timeline.srtIdentity}</span><span>ASS：{state.timeline.assIdentity}</span></header>
        <div className="grid gap-4">{state.timeline.segments.map((segment) => <article key={segment.index} className="rounded border border-[var(--border-subtle)] p-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--fg-tertiary)]"><span>段 {segment.index + 1}</span><span>真实时长 {formatMs(segment.durationMs)}</span><span>{segment.bytes} bytes</span></div>
          <p className="my-3 text-sm leading-6">{segment.text}</p>
          <audio controls preload="none" className="w-full" src={`/api/episodes/${encodeURIComponent(state.timeline!.episodeId)}/tts-timelines/${state.timeline!.timelineHash}/audio/${segment.index}`} />
          <div className="mt-3 grid gap-1 text-xs text-[var(--fg-tertiary)]">{state.timeline!.cues.filter((cue) => cue.segmentIndex === segment.index).map((cue) => <span key={cue.index}>cue {cue.index + 1} · {formatMs(cue.startMs)} → {formatMs(cue.endMs)} · {cue.text}</span>)}</div>
        </article>)}</div>
      </>}
    </section>
  </div>;
}

function formatMs(ms: number) { return `${(ms / 1000).toFixed(2)} 秒`; }
