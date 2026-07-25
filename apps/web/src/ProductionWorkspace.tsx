import { useCallback, useEffect, useState } from "react";

import { chapterPagePath, responseJson } from "./client-logic";
import {
  isTerminalJobStatus,
  mergeProductionWorkspaceLocation,
  productionWorkspaceFromSearch,
  productionWorkspacePath,
  PRODUCTION_STAGES,
  resolveProductionStage,
  type ProductionStageId,
} from "./production-logic";
import { AssetStage } from "./production/assets/AssetStage";
import { ChapterEventsStage } from "./production/ChapterEventsStage";
import { ProductionHeader } from "./production/ProductionHeader";
import { ProductionStatus } from "./production/ProductionStatus";
import { StageNavigation } from "./production/StageNavigation";
import type { Chapter, ChapterEvent, JobRecord, SeriesProject } from "./production/types";
import { useJobPolling } from "./production/use-job-polling";

export function ProductionWorkspace({ bookId, series, initialStatus, onLeave }: { bookId: string; series: SeriesProject; initialStatus: string; onLeave: () => void }) {
  const restored = productionWorkspaceFromSearch(window.location.search);
  const [stage, setStage] = useState<ProductionStageId>(() => resolveProductionStage(restored?.stage));
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterTotal, setChapterTotal] = useState(0);
  const [selectedChapter, setSelectedChapter] = useState(restored?.chapterId);
  const [episodeIndex] = useState(restored?.episodeIndex ?? 1);
  const [selectedAssetId, setSelectedAssetId] = useState(restored?.assetId);
  const [chapterText, setChapterText] = useState("");
  const [events, setEvents] = useState<ChapterEvent[]>([]);
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState(restored?.jobId);
  const job = useJobPolling(jobId, setStatus);

  const replaceLocation = useCallback((next: { stage?: ProductionStageId; chapterId?: string; episodeIndex?: number; assetId?: string; jobId?: string }) => {
    const location = mergeProductionWorkspaceLocation({ stage, chapterId: selectedChapter, episodeIndex, assetId: selectedAssetId, jobId }, next);
    window.history.replaceState(null, "", productionWorkspacePath({ bookId, seriesId: series.id, ...location }));
  }, [bookId, episodeIndex, jobId, selectedAssetId, selectedChapter, series.id, stage]);

  useEffect(() => {
    let cancelled = false;
    async function loadChapters() {
      setBusy(true); setStatus("正在加载章节工作区…");
      try {
        const body = await responseJson<{ items: Chapter[]; total: number }>(await fetch(chapterPagePath(bookId, 0)));
        if (!cancelled) { setChapters(body.items); setChapterTotal(body.total); setStatus(`章节工作区已就绪，共 ${body.total} 章`); }
      } catch (error) { if (!cancelled) setStatus(`章节工作区加载失败：${(error as Error).message}`); }
      finally { if (!cancelled) setBusy(false); }
    }
    void loadChapters(); return () => { cancelled = true; };
  }, [bookId]);

  useEffect(() => {
    if (!selectedChapter) return;
    let cancelled = false;
    async function loadChapter() {
      setBusy(true); setStatus("正在读取原文与结构化事件…");
      try {
        const [textBody, eventsBody] = await Promise.all([
          responseJson<{ text: string }>(await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(selectedChapter!)}/text`)),
          responseJson<{ items: ChapterEvent[]; total: number }>(await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(selectedChapter!)}/events?limit=100&offset=0`)),
        ]);
        if (!cancelled) { setChapterText(textBody.text); setEvents(eventsBody.items); setStatus(eventsBody.total ? `已加载 ${eventsBody.total} 个结构化事件` : "本章尚未生成结构化事件"); }
      } catch (error) { if (!cancelled) setStatus(`章节证据加载失败：${(error as Error).message}`); }
      finally { if (!cancelled) setBusy(false); }
    }
    void loadChapter(); return () => { cancelled = true; };
  }, [bookId, selectedChapter]);

  async function cancelJob() {
    if (!jobId || !job || isTerminalJobStatus(job.status) || busy) return;
    setBusy(true); setStatus("正在请求取消任务…");
    try {
      const body = await responseJson<{ message: string; job: JobRecord }>(await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }));
      setStatus(body.message);
      if (isTerminalJobStatus(body.job.status)) { setJobId(undefined); replaceLocation({ jobId: undefined }); }
    } catch (error) { setStatus(`取消任务失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  function selectStage(next: ProductionStageId) { setStage(next); replaceLocation({ stage: next }); setStatus(`已切换到「${PRODUCTION_STAGES.find((item) => item.id === next)!.label}」`); }
  function selectChapter(id: string) { setSelectedChapter(id); replaceLocation({ chapterId: id }); }
  function selectAsset(id: string | undefined) { setSelectedAssetId(id); replaceLocation({ assetId: id }); }
  function trackJob(id: string) { setJobId(id); replaceLocation({ jobId: id }); }

  return <main className="min-h-screen bg-[var(--bg-canvas)] p-7 text-[var(--fg-primary)] max-md:p-0">
    <div className="mx-auto min-h-[calc(100vh-56px)] w-full max-w-[1640px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-[var(--shadow)] max-md:min-h-screen max-md:border-0">
      <ProductionHeader series={series} onLeave={onLeave} />
      <StageNavigation stage={stage} onChange={selectStage} />
      <ProductionStatus status={status} busy={busy} job={job} onCancel={() => void cancelJob()} />
      {stage === "events" ? <ChapterEventsStage chapters={chapters} total={chapterTotal} selectedId={selectedChapter} text={chapterText} events={events} busy={busy} onSelect={selectChapter} /> : stage === "assets" ? <AssetStage seriesId={series.id} episodeIndex={episodeIndex} initialAssetId={selectedAssetId} busy={busy} setBusy={setBusy} setStatus={setStatus} onAssetChange={selectAsset} onJobCreated={trackJob} /> : <StagePlaceholder stage={stage} />}
    </div>
  </main>;
}

function StagePlaceholder({ stage }: { stage: ProductionStageId }) {
  return <section className="p-[clamp(40px,8vw,120px)]"><p className="mb-2 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">{stage.toUpperCase()}</p><h2 className="m-0 font-serif text-[clamp(36px,6vw,76px)] font-semibold leading-none tracking-[-.055em]">{PRODUCTION_STAGES.find((item) => item.id === stage)!.label}</h2><p className="mt-7 max-w-3xl text-[15px] leading-8 text-[var(--fg-secondary)]">该阶段将直接接通 Narralume 现有领域 API；当前导航和恢复入口已经可用，业务表单正在按固定优先级继续接线。</p></section>;
}
