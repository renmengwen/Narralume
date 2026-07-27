import { useCallback, useEffect, useRef, useState } from "react";

import { chapterPagePath, responseJson } from "./client-logic";
import {
  isTerminalJobStatus,
  mergeProductionWorkspaceLocation,
  productionWorkspaceFromSearch,
  productionWorkspacePath,
  PRODUCTION_STAGES,
  resolveProductionStage,
  updateWorkspaceStatusLayer,
  usesChapterWorkspaceStatus,
  type WorkspaceStatusLayers,
  type ProductionStageId,
} from "./production-logic";
import { AssetStage } from "./production/assets/AssetStage";
import { AudioStage } from "./production/audio/AudioStage";
import { chapterAnalysisJobPayload, chapterEventsJobPayload, remainingChapterEventPageOffsets, type ChapterEventDraft } from "./production/chapter-event-editor";
import { ChapterEventsStage } from "./production/ChapterEventsStage";
import { EpisodeStage } from "./production/episode/EpisodeStage";
import { ProductionHeader } from "./production/ProductionHeader";
import { ProductionStatus } from "./production/ProductionStatus";
import { ScriptStage } from "./production/scripts/ScriptStage";
import { StageNavigation } from "./production/StageNavigation";
import type { Chapter, ChapterEvent, JobRecord, SeriesProject } from "./production/types";
import { useJobPolling } from "./production/use-job-polling";
import { VisualStage } from "./production/visual/VisualStage";

export function ProductionWorkspace({ bookId, series, initialStatus, onLeave, onOpenSettings }: { bookId: string; series: SeriesProject; initialStatus: string; onLeave: () => void; onOpenSettings: () => void }) {
  const restored = productionWorkspaceFromSearch(window.location.search);
  const [stage, setStage] = useState<ProductionStageId>(() => resolveProductionStage(restored?.stage));
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterTotal, setChapterTotal] = useState(0);
  const [selectedChapter, setSelectedChapter] = useState(restored?.chapterId);
  const [episodeIndex, setEpisodeIndex] = useState(restored?.episodeIndex ?? 1);
  const [selectedAssetId, setSelectedAssetId] = useState(restored?.assetId);
  const [timelineHash, setTimelineHash] = useState(restored?.timelineHash);
  const [chapterText, setChapterText] = useState("");
  const [events, setEvents] = useState<ChapterEvent[]>([]);
  const [statusLayers, setStatusLayers] = useState<WorkspaceStatusLayers>({ operation: initialStatus });
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(restored?.jobId);
  const currentStage = useRef(stage);
  currentStage.current = stage;
  const setWorkspaceStatus = useCallback((message: string) => {
    setStatusLayers((current) => updateWorkspaceStatusLayer(current, message));
  }, []);
  const dismissPersistentError = useCallback(() => {
    setStatusLayers((current) => ({ ...current, persistentError: undefined }));
  }, []);
  const job = useJobPolling(jobId, setWorkspaceStatus);
  const currentJob = job?.id === jobId ? job : undefined;
  const completedChapterJobId = (currentJob?.type === "chapter_events_replace" || currentJob?.type === "chapter_events_analyze") && currentJob.status === "succeeded" ? currentJob.id : undefined;
  const jobActive = !!jobId && (!currentJob || !isTerminalJobStatus(currentJob.status));
  const selectedChapterRecord = chapters.find((chapter) => chapter.id === selectedChapter);

  const replaceLocation = useCallback((next: { stage?: ProductionStageId; chapterId?: string; episodeIndex?: number; assetId?: string; timelineHash?: string; jobId?: string }) => {
    const location = mergeProductionWorkspaceLocation({ stage, chapterId: selectedChapter, episodeIndex, assetId: selectedAssetId, timelineHash, jobId }, next);
    window.history.replaceState(null, "", productionWorkspacePath({ bookId, seriesId: series.id, ...location }));
  }, [bookId, episodeIndex, jobId, selectedAssetId, selectedChapter, series.id, stage, timelineHash]);

  useEffect(() => {
    let cancelled = false;
    async function loadChapters() {
      if (usesChapterWorkspaceStatus(currentStage.current)) { setBusy(true); setWorkspaceStatus("正在加载章节工作区…"); }
      try {
        const body = await responseJson<{ items: Chapter[]; total: number }>(await fetch(chapterPagePath(bookId, 0)));
        if (!cancelled) { setChapters(body.items); setChapterTotal(body.total); if (usesChapterWorkspaceStatus(currentStage.current)) setWorkspaceStatus(`章节工作区已就绪，共 ${body.total} 章`); }
      } catch (error) { if (!cancelled && usesChapterWorkspaceStatus(currentStage.current)) setWorkspaceStatus(`章节工作区加载失败：${(error as Error).message}`); }
      finally { if (!cancelled && usesChapterWorkspaceStatus(currentStage.current)) setBusy(false); }
    }
    void loadChapters(); return () => { cancelled = true; };
  }, [bookId]);

  useEffect(() => {
    if (!selectedChapter || !selectedChapterRecord) return;
    let cancelled = false;
    async function loadChapter() {
      if (usesChapterWorkspaceStatus(currentStage.current)) { setBusy(true); setWorkspaceStatus("正在读取原文与结构化事件…"); }
      try {
        const [textBody, firstEventsBody] = await Promise.all([
          responseJson<{ text: string }>(await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(selectedChapter!)}/text`)),
          responseJson<{ items: ChapterEvent[]; total: number }>(await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(selectedChapter!)}/events?limit=100&offset=0`)),
        ]);
        const remainingPages = await Promise.all(remainingChapterEventPageOffsets(firstEventsBody.total, firstEventsBody.items.length).map(async (offset) =>
          responseJson<{ items: ChapterEvent[]; total: number }>(await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(selectedChapter!)}/events?limit=100&offset=${offset}`)),
        ));
        const loadedEvents = [firstEventsBody.items, ...remainingPages.map((page) => page.items)].flat();
        if (loadedEvents.length !== firstEventsBody.total) throw new Error("章节事件分页读取不完整，请刷新后重试");
        if (!cancelled) { setChapterText(textBody.text); setEvents(loadedEvents); if (usesChapterWorkspaceStatus(currentStage.current)) setWorkspaceStatus(firstEventsBody.total ? `已加载 ${firstEventsBody.total} 个结构化事件` : "本章尚未生成结构化事件"); }
      } catch (error) { if (!cancelled && usesChapterWorkspaceStatus(currentStage.current)) setWorkspaceStatus(`章节证据加载失败：${(error as Error).message}`); }
      finally { if (!cancelled && usesChapterWorkspaceStatus(currentStage.current)) setBusy(false); }
    }
    void loadChapter(); return () => { cancelled = true; };
  }, [bookId, completedChapterJobId, selectedChapter, selectedChapterRecord]);

  async function saveChapterEvents(drafts: ChapterEventDraft[]) {
    if (!selectedChapterRecord || busy || jobActive) return;
    setBusy(true); setWorkspaceStatus("正在创建章节事件持久任务…");
    try {
      const payload = chapterEventsJobPayload(bookId, selectedChapterRecord, drafts);
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "chapter_events_replace", payload }),
      }));
      setJobId(body.job.id); replaceLocation({ jobId: body.job.id }); setWorkspaceStatus(body.message);
    } catch (error) { setWorkspaceStatus(`章节事件保存失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function analyzeChapterEvents() {
    if (!selectedChapterRecord || busy || jobActive) return;
    setBusy(true); setWorkspaceStatus("正在创建章节自动分析任务…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "chapter_events_analyze", payload: chapterAnalysisJobPayload(bookId, selectedChapterRecord) }),
      }));
      setJobId(body.job.id); replaceLocation({ jobId: body.job.id }); setWorkspaceStatus(body.message);
    } catch (error) { const message = (error as Error).message; setWorkspaceStatus(`章节自动分析失败：${message}${message.includes("人工事件入口") ? "" : "；仍可使用人工事件入口"}`); }
    finally { setBusy(false); }
  }

  async function cancelJob() {
    if (!jobId || !currentJob || isTerminalJobStatus(currentJob.status) || busy) return;
    setBusy(true); setWorkspaceStatus("正在请求取消任务…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }));
      setWorkspaceStatus(body.message);
      if (isTerminalJobStatus(body.job.status)) { setJobId(undefined); replaceLocation({ jobId: undefined }); }
    } catch (error) { setWorkspaceStatus(`取消任务失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  function selectStage(next: ProductionStageId) { setStage(next); replaceLocation({ stage: next }); setWorkspaceStatus(`已切换到「${PRODUCTION_STAGES.find((item) => item.id === next)!.label}」`); }
  function selectChapter(id: string) {
    if (id === selectedChapter) return;
    setBusy(true); setSelectedChapter(id); setChapterText(""); setEvents([]); setJobId(undefined); replaceLocation({ chapterId: id, jobId: undefined });
  }
  function selectAsset(id: string | undefined) { setSelectedAssetId(id); replaceLocation({ assetId: id }); }
  function selectEpisode(index: number) { if (index === episodeIndex) return; setEpisodeIndex(index); setTimelineHash(undefined); setJobId(undefined); replaceLocation({ episodeIndex: index, timelineHash: undefined, jobId: undefined }); }
  function selectTimeline(hash: string | undefined) { setTimelineHash(hash); replaceLocation({ timelineHash: hash }); }
  function trackJob(id?: string) { setJobId(id); replaceLocation({ jobId: id }); }

  return <main className="min-h-screen bg-[var(--bg-canvas)] p-4 text-[var(--fg-primary)] max-md:p-0">
    <div className="mx-auto min-h-[calc(100vh-32px)] w-full max-w-[1640px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow)] max-md:min-h-screen max-md:border-0">
      <ProductionHeader series={series} onLeave={onLeave} onOpenSettings={onOpenSettings} />
      <StageNavigation stage={stage} onChange={selectStage} />
      <ProductionStatus operation={statusLayers.operation} persistentError={statusLayers.persistentError} busy={busy} job={currentJob} onDismissError={dismissPersistentError} onCancel={() => void cancelJob()} />
      {stage === "events" ? <ChapterEventsStage chapters={chapters} total={chapterTotal} selected={selectedChapterRecord} text={chapterText} events={events} locked={busy || jobActive} onSelect={selectChapter} onSave={(drafts) => void saveChapterEvents(drafts)} onAnalyze={() => void analyzeChapterEvents()} /> : stage === "episode" ? <EpisodeStage bookId={bookId} seriesId={series.id} episodeIndex={episodeIndex} chapters={chapters} startChapterId={selectedChapter} currentJob={currentJob} busy={busy} setBusy={setBusy} setStatus={setWorkspaceStatus} onEpisodeChange={selectEpisode} onStartChapterChange={(id) => id ? selectChapter(id) : (setSelectedChapter(undefined), setJobId(undefined), replaceLocation({ chapterId: undefined, jobId: undefined }))} onJobCreated={trackJob} onOpenScripts={() => selectStage("scripts")} /> : stage === "scripts" ? <ScriptStage seriesId={series.id} episodeIndex={episodeIndex} busy={busy} jobActive={jobActive} currentJob={currentJob} setBusy={setBusy} setStatus={setWorkspaceStatus} onEpisodeChange={selectEpisode} onJobCreated={trackJob} /> : stage === "assets" ? <AssetStage seriesId={series.id} episodeIndex={episodeIndex} initialAssetId={selectedAssetId} busy={busy} currentJob={currentJob} setStatus={setWorkspaceStatus} onAssetChange={selectAsset} onJobCreated={trackJob} /> : stage === "audio" ? <AudioStage seriesId={series.id} episodeIndex={episodeIndex} timelineHash={timelineHash} busy={busy} jobActive={jobActive} currentJob={currentJob} setBusy={setBusy} setStatus={setWorkspaceStatus} onEpisodeChange={selectEpisode} onTimelineChange={selectTimeline} onJobCreated={trackJob} /> : stage === "visual" ? <VisualStage seriesId={series.id} episodeIndex={episodeIndex} timelineHash={timelineHash} externalBusy={busy} setBusy={setBusy} setStatus={setWorkspaceStatus} onEpisodeChange={selectEpisode} onTimelineChange={selectTimeline} /> : <StagePlaceholder stage={stage} />}
    </div>
  </main>;
}

function StagePlaceholder({ stage }: { stage: ProductionStageId }) {
  return <section className="p-[clamp(40px,8vw,120px)]"><p className="mb-2 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">{stage.toUpperCase()}</p><h2 className="m-0 font-serif text-[clamp(36px,6vw,76px)] font-semibold leading-none tracking-[-.055em]">{PRODUCTION_STAGES.find((item) => item.id === stage)!.label}</h2><p className="mt-7 max-w-3xl text-[15px] leading-8 text-[var(--fg-secondary)]">该阶段将直接接通 Narralume 现有领域 API；当前导航和恢复入口已经可用，业务表单正在按固定优先级继续接线。</p></section>;
}
