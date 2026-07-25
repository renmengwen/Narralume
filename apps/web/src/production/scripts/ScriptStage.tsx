import type { EpisodeSourceSnapshot, JobRecord, ScriptVersion } from "../types";
import { allowedSourceIndexes, canStartEpisodeScriptGeneration } from "./script-editor";
import { useScriptWorkspace } from "./use-script-workspace";

export function ScriptStage({
  seriesId, episodeIndex, busy, jobActive, currentJob, setBusy, setStatus, onEpisodeChange, onJobCreated,
}: {
  seriesId: string;
  episodeIndex: number;
  busy: boolean;
  jobActive: boolean;
  currentJob?: JobRecord;
  setBusy: (busy: boolean) => void;
  setStatus: (message: string) => void;
  onEpisodeChange: (index: number) => void;
  onJobCreated: (id: string) => void;
}) {
  const state = useScriptWorkspace({
    seriesId, episodeIndex, currentJob, jobActive, setBusy, setStatus, onJobCreated,
  });
  const faithful = state.scripts.filter((item) => item.kind === "faithful");
  const packaged = state.scripts.filter((item) => item.kind === "packaged");
  const parent = faithful.find((item) => item.id === state.parentVersionId);
  const allowed = new Set(allowedSourceIndexes(state.kind, state.episode?.sources.map((source) => source.sourceIndex) ?? [], parent));
  const sources = (state.episode?.sources ?? []).filter((source) => allowed.has(source.sourceIndex));
  const canGenerate = canStartEpisodeScriptGeneration(busy, jobActive, state.episode?.id);

  return <div className="grid grid-cols-[260px_minmax(0,1fr)_340px] border-t border-[var(--border-subtle)] max-xl:grid-cols-1">
    <aside className="border-r border-[var(--border-subtle)] p-5 max-xl:border-r-0 max-xl:border-b">
      <label className="text-xs text-[var(--fg-secondary)]">分集序号<input type="number" min={1} disabled={busy} value={episodeIndex} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value > 0) onEpisodeChange(value); }} className="mt-2 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
      <div className="mt-5 space-y-3 rounded border border-[var(--border-subtle)] p-3">
        <p className="text-xs font-semibold">跨章骨架与长稿</p>
        <label className="block text-xs text-[var(--fg-secondary)]">音色<input value={state.voice} disabled={busy || jobActive} onChange={(event) => state.setVoice(event.target.value)} className="mt-1 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
        <label className="block text-xs text-[var(--fg-secondary)]">语速<input type="number" min={-10} max={10} step={1} value={state.rate} disabled={busy || jobActive} onChange={(event) => state.setRate(Number(event.target.value))} className="mt-1 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
        <label className="block text-xs text-[var(--fg-secondary)]">暂定字/秒<input type="number" min={0.1} max={20} step={0.1} value={state.charactersPerSecond} disabled={busy || jobActive} onChange={(event) => state.setCharactersPerSecond(Number(event.target.value))} className="mt-1 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
        <label className="block text-xs text-[var(--fg-secondary)]">旁白占用率<input type="number" min={0.1} max={1} step={0.05} value={state.narrationOccupancy} disabled={busy || jobActive} onChange={(event) => state.setNarrationOccupancy(Number(event.target.value))} className="mt-1 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2" /></label>
        <button type="button" disabled={!canGenerate} onClick={() => void state.generateScripts()} className="w-full rounded bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{jobActive ? "生成任务处理中…" : "生成骨架、忠实稿与包装稿"}</button>
        <p className="text-xs leading-5 text-[var(--fg-tertiary)]">当前为短样校准前的暂定语速；生成后不会自动批准。</p>
      </div>
      <p className="mt-5 text-xs leading-6 text-[var(--fg-tertiary)]">也可继续人工整理；每次保存都会创建不可变新版本。</p>
      <VersionList title="忠实稿版本" items={faithful} onLoad={state.loadVersion} />
      <VersionList title="包装稿版本" items={packaged} onLoad={state.loadVersion} />
    </aside>

    <section className="p-6" aria-labelledby="script-editor-heading">
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <div><p id="script-editor-heading" className="text-xs font-bold tracking-wider">人工稿件编辑</p><p className="mt-1 text-xs text-[var(--fg-tertiary)]">新版本不会自动迁移现有批准指针。</p></div>
        <label className="ml-auto text-xs text-[var(--fg-secondary)]">稿件类型<select disabled={busy || !state.episode} value={state.kind} onChange={(event) => state.changeKind(event.target.value as "faithful" | "packaged")} className="ml-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2"><option value="faithful">忠实稿</option><option value="packaged">包装稿</option></select></label>
        {state.kind === "packaged" ? <label className="text-xs text-[var(--fg-secondary)]">忠实父稿<select disabled={busy} value={state.parentVersionId} onChange={(event) => state.setParentVersionId(event.target.value)} className="ml-2 max-w-60 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2"><option value="">请选择</option>{faithful.map((item) => <option key={item.id} value={item.id}>忠实稿 v{item.versionNumber}</option>)}</select></label> : null}
      </div>

      {!state.episode ? <p className="rounded border border-dashed border-[var(--border-subtle)] p-8 text-sm text-[var(--fg-tertiary)]">该分集尚未创建。请先在“故事弧与分集”保存故事弧和来源证据。</p> : <div className="space-y-5">
        {state.paragraphs.map((paragraph, index) => <article key={paragraph.key} className="rounded border border-[var(--border-subtle)] p-4">
          <div className="mb-3 flex items-center justify-between"><span className="font-mono text-xs text-[var(--fg-tertiary)]">段落 {index + 1}</span><button type="button" disabled={busy || state.paragraphs.length === 1} onClick={() => state.removeParagraph(paragraph.key)} className="text-xs text-[var(--fg-secondary)] disabled:opacity-40">移除</button></div>
          <textarea disabled={busy} rows={5} value={paragraph.text} onChange={(event) => state.updateParagraph(paragraph.key, { text: event.target.value })} placeholder="填写人工整理的旁白或画面稿" className="w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-3 text-sm leading-6" />
          <fieldset className="mt-3"><legend className="mb-2 text-xs text-[var(--fg-secondary)]">引用来源</legend><div className="grid gap-2">{sources.map((source) => <SourceOption key={source.sourceIndex} source={source} checked={paragraph.sourceIndexes.includes(source.sourceIndex)} disabled={busy} onChange={(checked) => state.updateParagraph(paragraph.key, { sourceIndexes: checked ? [...paragraph.sourceIndexes, source.sourceIndex] : paragraph.sourceIndexes.filter((item) => item !== source.sourceIndex) })} />)}{!sources.length ? <p className="text-xs text-[var(--fg-tertiary)]">当前没有可用来源；包装稿来源由忠实父稿冻结。</p> : null}</div></fieldset>
        </article>)}
        <div className="flex gap-3"><button type="button" disabled={busy} onClick={state.addParagraph} className="rounded border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:opacity-50">添加段落</button><button type="button" disabled={busy} onClick={() => void state.saveVersion()} className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "处理中…" : "创建不可变新版本"}</button></div>
      </div>}
    </section>

    <aside className="border-l border-[var(--border-subtle)] p-5 max-xl:border-l-0 max-xl:border-t">
      <h2 className="text-xs font-bold tracking-wider">人工批准</h2>
      <p className="mt-2 text-sm">状态：{approvalLabel(state.approval?.status)} · revision {state.approval?.revision ?? "—"}</p>
      {state.approval?.scriptVersionId ? <p className="mt-2 break-all font-mono text-[10px] text-[var(--fg-tertiary)]">当前批准：{state.approval.scriptVersionId}</p> : null}
      <label className="mt-5 block text-xs text-[var(--fg-secondary)]">待批准包装稿<select disabled={busy || !packaged.length} value={state.selectedPackagedId} onChange={(event) => state.setSelectedPackagedId(event.target.value)} className="mt-2 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] p-2"><option value="">请选择</option>{packaged.map((item) => <option key={item.id} value={item.id}>包装稿 v{item.versionNumber}</option>)}</select></label>
      <div className="mt-4 grid gap-2"><button type="button" disabled={busy || !state.approval || !state.selectedPackagedId} onClick={() => void state.changeApproval("approve")} className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">批准所选包装稿</button><button type="button" disabled={busy || state.approval?.status !== "approved"} onClick={() => void state.changeApproval("withdraw")} className="rounded border border-[var(--border-subtle)] px-4 py-2 text-sm disabled:opacity-50">撤回当前批准</button></div>
      <p className="mt-4 text-xs leading-6 text-[var(--fg-tertiary)]">批准与撤回使用页面当前 revision。若服务端返回冲突，页面只刷新状态，不会自动重放人工决定。</p>
    </aside>
  </div>;
}

function VersionList({ title, items, onLoad }: { title: string; items: ScriptVersion[]; onLoad: (version: ScriptVersion) => void }) {
  return <div className="mt-5"><h3 className="text-xs font-semibold">{title}</h3><div className="mt-2 grid gap-2">{items.map((item) => <button type="button" key={item.id} onClick={() => onLoad(item)} className="rounded border border-[var(--border-subtle)] p-2 text-left text-xs">v{item.versionNumber} · {item.paragraphs.length} 段</button>)}{!items.length ? <p className="text-xs text-[var(--fg-tertiary)]">暂无版本</p> : null}</div></div>;
}

function SourceOption({ source, checked, disabled, onChange }: { source: EpisodeSourceSnapshot; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex gap-2 rounded bg-[var(--bg-canvas)] p-2 text-xs leading-5"><input type="checkbox" disabled={disabled} checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><span className="font-mono text-[10px] text-[var(--fg-tertiary)]">来源 {source.sourceIndex} · {source.byteStart}–{source.byteEnd}</span><br />{source.sourceText}</span></label>;
}

function approvalLabel(status?: "unapproved" | "approved" | "withdrawn") {
  return status === "approved" ? "已批准" : status === "withdrawn" ? "已撤回" : status === "unapproved" ? "未批准" : "未加载";
}
