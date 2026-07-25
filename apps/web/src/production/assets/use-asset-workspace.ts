import { useEffect, useMemo, useState } from "react";

import { responseJson } from "../../client-logic";
import { assembleImagePrompt } from "../../production-logic";
import type { AssetGroup, AssetRecord, AssetType, CandidateRecord, EpisodeRecord, PromptParts } from "./types";
import { flattenAssets } from "./types";

export function useAssetWorkspace({ seriesId, episodeIndex, initialAssetId, busy, setBusy, setStatus, onAssetChange, onJobCreated }: { seriesId: string; episodeIndex: number; initialAssetId?: string; busy: boolean; setBusy: (busy: boolean) => void; setStatus: (message: string) => void; onAssetChange: (assetId: string | undefined) => void; onJobCreated: (jobId: string) => void }) {
  const [assets, setAssets] = useState<AssetGroup[]>([]);
  const [episode, setEpisode] = useState<EpisodeRecord>();
  const [selectedAssetId, setSelectedAssetId] = useState(initialAssetId);
  const [candidates, setCandidates] = useState<CandidateRecord[]>([]);
  const [newAssetName, setNewAssetName] = useState("");
  const [newAssetType, setNewAssetType] = useState<AssetType>("character");
  const [parentAssetId, setParentAssetId] = useState("");
  const [stateLabel, setStateLabel] = useState("");
  const [aliasDraft, setAliasDraft] = useState("");
  const [promptParts, setPromptParts] = useState<PromptParts>({ evidence: "", sceneIntent: "", subjectAction: "", environment: "", lightingComposition: "", styleConstraints: "写实悬疑，人物与年代细节一致，不虚构原文没有的品牌和文字" });
  const allAssets = useMemo(() => flattenAssets(assets), [assets]);
  const selectedAsset = allAssets.find((asset) => asset.id === selectedAssetId);
  const prompt = selectedAsset ? assembleImagePrompt({ ...promptParts, assetName: selectedAsset.name, assetState: selectedAsset.stateLabel }) : "";

  async function loadAssets(preferredId = selectedAssetId) {
    const body = await responseJson<{ items: AssetGroup[] }>(await fetch(`/api/series/${encodeURIComponent(seriesId)}/assets`));
    setAssets(body.items);
    const flattened = flattenAssets(body.items);
    const nextId = flattened.some((asset) => asset.id === preferredId) ? preferredId : flattened[0]?.id;
    setSelectedAssetId(nextId); onAssetChange(nextId); return flattened.length;
  }

  async function fetchCandidates(assetId: string) {
    const body = await responseJson<{ items: CandidateRecord[] }>(await fetch(`/api/assets/${encodeURIComponent(assetId)}/candidates`));
    return body.items;
  }

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      setBusy(true); setStatus("正在恢复资产、候选图和分集门禁…");
      try {
        const count = await loadAssets(initialAssetId);
        if (cancelled) return;
        try {
          const body = await responseJson<{ episode: EpisodeRecord }>(await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`));
          if (!cancelled) setEpisode(body.episode);
        } catch { if (!cancelled) setEpisode(undefined); }
        if (!cancelled) setStatus(`资产工作区已恢复，共 ${count} 个主/状态资产`);
      } catch (error) { if (!cancelled) setStatus(`资产工作区恢复失败：${(error as Error).message}`); }
      finally { if (!cancelled) setBusy(false); }
    }
    void hydrate(); return () => { cancelled = true; };
  }, [seriesId, episodeIndex]);

  useEffect(() => {
    if (!selectedAssetId) { setCandidates([]); return; }
    let cancelled = false;
    fetchCandidates(selectedAssetId)
      .then((items) => { if (!cancelled) setCandidates(items); })
      .catch((error) => { if (!cancelled) setStatus(`候选图加载失败：${(error as Error).message}`); });
    return () => { cancelled = true; };
  }, [selectedAssetId]);

  function chooseAsset(id: string) { setSelectedAssetId(id); onAssetChange(id); setCandidates([]); setStatus("正在加载该资产的候选图…"); }
  function updatePromptPart(key: keyof PromptParts, value: string) { setPromptParts((current) => ({ ...current, [key]: value })); }

  async function createAsset() {
    if (busy || !newAssetName.trim()) return;
    setBusy(true); setStatus(parentAssetId ? "正在创建状态资产…" : "正在创建主资产…");
    try {
      const body = await responseJson<{ message: string; asset: AssetRecord }>(await fetch(`/api/series/${encodeURIComponent(seriesId)}/assets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: newAssetType, name: newAssetName.trim(), ...(parentAssetId ? { parentAssetId, stateLabel: stateLabel.trim() } : {}) }) }));
      await loadAssets(body.asset.id); setNewAssetName(""); setParentAssetId(""); setStateLabel(""); setStatus(body.message);
    } catch (error) { setStatus(`资产创建失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function addAlias() {
    if (!selectedAsset || busy || !aliasDraft.trim()) return;
    setBusy(true); setStatus("正在保存资产别名…");
    try {
      const body = await responseJson<{ message: string }>(await fetch(`/api/assets/${encodeURIComponent(selectedAsset.id)}/aliases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aliases: [aliasDraft.trim()] }) }));
      await loadAssets(selectedAsset.id); setAliasDraft(""); setStatus(body.message);
    } catch (error) { setStatus(`别名保存失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function generateCandidate() {
    if (!selectedAsset || !episode || busy || !promptParts.evidence.trim() || !promptParts.sceneIntent.trim() || !promptParts.subjectAction.trim()) return;
    setBusy(true); setStatus("正在创建可恢复的生图任务…");
    try {
      const body = await responseJson<{ message: string; job: { id: string } }>(await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "image_candidate_generate", payload: { episodeId: episode.id, assetId: selectedAsset.id, prompt } }) }));
      onJobCreated(body.job.id); setStatus(body.message);
    } catch (error) { setStatus(`生图任务创建失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function reviewCandidate(candidate: CandidateRecord, action: "approve" | "reject") {
    if (busy) return;
    setBusy(true); setStatus(action === "approve" ? "正在批准候选图…" : "正在淘汰候选图…");
    try {
      await responseJson(await fetch(`/api/candidates/${encodeURIComponent(candidate.id)}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: candidate.reviewRevision, action }) }));
      setCandidates(await fetchCandidates(candidate.assetId)); setStatus(action === "approve" ? "候选图已批准，可供视觉段显式绑定" : "候选图已淘汰，历史仍保留");
    } catch (error) { setStatus(`候选审核失败：${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  return { assets, allAssets, episode, selectedAsset, candidates, newAssetName, setNewAssetName, newAssetType, setNewAssetType, parentAssetId, setParentAssetId, stateLabel, setStateLabel, aliasDraft, setAliasDraft, promptParts, updatePromptPart, prompt, chooseAsset, createAsset, addAlias, generateCandidate, reviewCandidate };
}
