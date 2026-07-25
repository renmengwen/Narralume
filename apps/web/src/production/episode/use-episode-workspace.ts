import { useEffect, useState } from "react";

import { responseJson } from "../../client-logic";
import type { Episode } from "../types";
import { emptyEpisodeDraft, episodeDraft, episodePutPayload, type EpisodeDraft } from "./episode-editor";

export function useEpisodeWorkspace({ seriesId, episodeIndex, busy, setBusy, setStatus }: { seriesId: string; episodeIndex: number; busy: boolean; setBusy: (busy: boolean) => void; setStatus: (message: string) => void }) {
  const [episode, setEpisode] = useState<Episode>();
  const [draft, setDraft] = useState<EpisodeDraft>(emptyEpisodeDraft);

  async function fetchEpisode() {
    const response = await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`);
    if (response.status === 404) return undefined;
    return (await responseJson<{ episode: Episode }>(response)).episode;
  }

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      setBusy(true); setStatus(`正在恢复第 ${episodeIndex} 集故事弧与证据…`);
      try {
        const restored = await fetchEpisode();
        if (cancelled) return;
        setEpisode(restored); setDraft(restored ? episodeDraft(restored) : emptyEpisodeDraft());
        setStatus(restored ? `第 ${episodeIndex} 集已恢复，可继续编辑` : `第 ${episodeIndex} 集尚未创建，可从当前章节事件开始首版`);
      } catch (error) { if (!cancelled) setStatus(`分集恢复失败：${(error as Error).message}`); }
      finally { if (!cancelled) setBusy(false); }
    }
    void hydrate(); return () => { cancelled = true; };
  }, [seriesId, episodeIndex]);

  function updateDraft(change: Partial<EpisodeDraft>) { setDraft((current) => ({ ...current, ...change })); }

  async function save() {
    if (busy) return;
    setBusy(true); setStatus(`正在保存第 ${episodeIndex} 集故事弧与证据…`);
    try {
      const payload = episodePutPayload(draft);
      await responseJson(await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      }));
      const restored = await fetchEpisode();
      if (!restored) throw new Error("保存后未能回读分集");
      setEpisode(restored); setDraft(episodeDraft(restored)); setStatus(`第 ${episodeIndex} 集已保存并从持久层回读`);
    } catch (error) { setStatus(`分集保存失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  return { episode, draft, updateDraft, save };
}
