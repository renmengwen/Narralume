import { useEffect, useMemo, useRef, useState } from "react";

import { responseJson } from "../../client-logic";
import type { AssetGroup, CandidateRecord } from "../assets/types";
import { flattenAssets } from "../assets/types";
import type { Episode, TtsTimeline, TtsTimelineSummary } from "../types";
import { conflictRevision, nextVisualDraft, visualDraft, visualPlanStatus, visualSegmentPayload } from "./visual-editor";
import type { ContactSheetResult, VisualAsset, VisualSegment, VisualSegmentDraft } from "./types";

export function useVisualWorkspace({ seriesId, episodeIndex, timelineHash, externalBusy, setBusy, setStatus, onEpisodeChange, onTimelineChange }: {
  seriesId: string; episodeIndex: number; timelineHash?: string; externalBusy: boolean;
  setBusy: (busy: boolean) => void; setStatus: (message: string) => void;
  onEpisodeChange: (index: number) => void; onTimelineChange: (hash: string | undefined) => void;
}) {
  const [episode, setEpisode] = useState<Episode>();
  const [timelines, setTimelines] = useState<TtsTimelineSummary[]>([]);
  const [timeline, setTimeline] = useState<TtsTimeline>();
  const [assets, setAssets] = useState<VisualAsset[]>([]);
  const [segments, setSegments] = useState<VisualSegment[]>([]);
  const [draft, setDraft] = useState<VisualSegmentDraft>();
  const [contactSheet, setContactSheet] = useState<ContactSheetResult>();
  const [loading, setLoading] = useState(false);
  const writing = useRef(false);
  const epoch = useRef(0);
  const routeKey = `${seriesId}:${episodeIndex}:${timelineHash ?? "latest"}`;
  const plan = useMemo(() => visualPlanStatus(timeline, segments), [segments, timeline]);
  const busy = externalBusy || loading;

  async function readSegments(episodeId: string, hash: string) {
    return (await responseJson<{ items: VisualSegment[] }>(await fetch(`/api/episodes/${encodeURIComponent(episodeId)}/visual-segments?timelineHash=${encodeURIComponent(hash)}`))).items;
  }

  useEffect(() => {
    const requestEpoch = ++epoch.current;
    setEpisode(undefined); setTimelines([]); setTimeline(undefined); setAssets([]); setSegments([]); setDraft(undefined); setContactSheet(undefined);
    setLoading(true); setBusy(true); setStatus(`正在恢复第 ${episodeIndex} 集视觉段…`);
    void (async () => {
      const episodeResponse = await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`);
      if (episodeResponse.status === 404) return undefined;
      const restoredEpisode = (await responseJson<{ episode: Episode }>(episodeResponse)).episode;
      const [timelineList, assetGroups] = await Promise.all([
        responseJson<{ items: TtsTimelineSummary[] }>(await fetch(`/api/episodes/${encodeURIComponent(restoredEpisode.id)}/tts-timelines`)).then((body) => body.items),
        responseJson<{ items: AssetGroup[] }>(await fetch(`/api/series/${encodeURIComponent(seriesId)}/assets`)).then((body) => body.items),
      ]);
      const hash = timelineHash ?? timelineList[0]?.timelineHash;
      if (!hash) return { episode: restoredEpisode, timelines: timelineList, timeline: undefined, assets: [], segments: [] };
      const flatAssets = flattenAssets(assetGroups);
      const [restoredTimeline, candidates, restoredSegments] = await Promise.all([
        responseJson<{ timeline: TtsTimeline }>(await fetch(`/api/episodes/${encodeURIComponent(restoredEpisode.id)}/tts-timelines/${encodeURIComponent(hash)}`)).then((body) => body.timeline),
        Promise.all(flatAssets.map(async (asset) => ({ ...asset, candidates: (await responseJson<{ items: CandidateRecord[] }>(await fetch(`/api/assets/${encodeURIComponent(asset.id)}/candidates`))).items }))),
        readSegments(restoredEpisode.id, hash),
      ]);
      return { episode: restoredEpisode, timelines: timelineList, timeline: restoredTimeline, assets: candidates, segments: restoredSegments, hash };
    })().then((snapshot) => {
      if (epoch.current !== requestEpoch) return;
      if (!snapshot) { setStatus(`第 ${episodeIndex} 集尚未创建`); return; }
      setEpisode(snapshot.episode); setTimelines(snapshot.timelines); setTimeline(snapshot.timeline); setAssets(snapshot.assets); setSegments(snapshot.segments);
      if (snapshot.hash && snapshot.hash !== timelineHash) onTimelineChange(snapshot.hash);
      setStatus(snapshot.timeline ? `视觉工作区已恢复：${snapshot.segments.length} 个视觉段` : "当前批准稿尚未生成语音时间轴");
    }).catch((error) => { if (epoch.current === requestEpoch) setStatus(`视觉工作区恢复失败：${(error as Error).message}`); })
      .finally(() => { if (epoch.current === requestEpoch) { setLoading(false); setBusy(false); } });
    return () => { epoch.current += 1; setBusy(false); };
  }, [routeKey]);

  function chooseTimeline(hash: string) { if (hash !== timelineHash) onTimelineChange(hash); }
  function chooseSegment(segment: VisualSegment) { setDraft(visualDraft(segment)); setContactSheet(undefined); setStatus(`正在编辑视觉段 ${segment.segmentIndex + 1}`); }
  function addSegment() {
    if (!timeline) return;
    const next = nextVisualDraft(timeline, segments);
    if (!next) { setStatus("全部字幕已被视觉段覆盖"); return; }
    setDraft(next); setContactSheet(undefined); setStatus(`已创建视觉段 ${next.segmentIndex + 1} 草稿，请绑定资产与批准候选`);
  }

  async function saveSegment() {
    if (!episode || !timeline || !draft || writing.current) return;
    let payload;
    try { payload = visualSegmentPayload(timeline.timelineHash, draft); }
    catch (error) { setStatus(`视觉段校验失败：${(error as Error).message}`); return; }
    writing.current = true; setLoading(true); setBusy(true); setContactSheet(undefined); setStatus("正在保存视觉段…");
    const requestEpoch = epoch.current;
    try {
      const response = await fetch(`/api/episodes/${encodeURIComponent(episode.id)}/visual-segments/${draft.segmentIndex}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      try { await responseJson(response); } catch (error) {
        if (response.status === 409) {
          const refreshed = await readSegments(episode.id, timeline.timelineHash);
          if (epoch.current !== requestEpoch) return;
          setSegments(refreshed);
          const server = refreshed.find((segment) => segment.segmentIndex === draft.segmentIndex);
          const revision = server?.revision ?? conflictRevision((error as Error).message);
          if (revision !== undefined) setDraft((current) => current?.segmentIndex === draft.segmentIndex ? { ...current, expectedRevision: revision } : current);
          setStatus(`视觉段发生冲突，服务端版本已刷新为 r${revision ?? "?"}；草稿未丢失，请核对后重试`);
          return;
        }
        throw error;
      }
      const refreshed = await readSegments(episode.id, timeline.timelineHash);
      if (epoch.current !== requestEpoch) return;
      setSegments(refreshed);
      const saved = refreshed.find((segment) => segment.segmentIndex === draft.segmentIndex);
      if (!saved) throw new Error("保存后未能回读视觉段");
      setDraft(visualDraft(saved)); setStatus(`视觉段 ${saved.segmentIndex + 1} 已保存并从持久层回读`);
    } catch (error) { if (epoch.current === requestEpoch) setStatus(`视觉段保存失败：${(error as Error).message}`); }
    finally { writing.current = false; if (epoch.current === requestEpoch) { setLoading(false); setBusy(false); } }
  }

  async function exportContactSheet() {
    if (!episode || !timeline || writing.current || !plan.productionReady) return;
    writing.current = true; setLoading(true); setBusy(true); setContactSheet(undefined); setStatus("正在验证并导出联系表…");
    const requestEpoch = epoch.current;
    try {
      const body = await responseJson<{ message: string; contactSheet: ContactSheetResult }>(await fetch(`/api/episodes/${encodeURIComponent(episode.id)}/contact-sheet`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timelineHash: timeline.timelineHash }),
      }));
      if (epoch.current !== requestEpoch) return;
      setContactSheet(body.contactSheet); setStatus("联系表已通过服务端真实门禁并耐久导出");
    } catch (error) { if (epoch.current === requestEpoch) setStatus(`联系表导出失败：${(error as Error).message}`); }
    finally { writing.current = false; if (epoch.current === requestEpoch) { setLoading(false); setBusy(false); } }
  }

  return { episode, timelines, timeline, assets, segments, draft, setDraft, contactSheet, plan, busy, chooseTimeline, chooseSegment, addSegment, saveSegment, exportContactSheet, onEpisodeChange };
}
