import { useEffect, useMemo, useRef, useState } from "react";

import { responseJson } from "../../client-logic";
import { assembleImagePrompt } from "../../production-logic";
import type { JobRecord } from "../types";
import { assetGapCounts, canApplyCandidateRefresh, candidateUploadRequest, generatedCandidateAssetId } from "./asset-candidate-editor";
import type { AssetGroup, AssetRecord, AssetType, CandidateRecord, EpisodeRecord, PromptParts } from "./types";
import { flattenAssets } from "./types";

type CandidateMap = Record<string, CandidateRecord[]>;

export function useAssetWorkspace({ seriesId, episodeIndex, initialAssetId, busy: externalBusy, currentJob, setStatus, onAssetChange, onJobCreated }: { seriesId: string; episodeIndex: number; initialAssetId?: string; busy: boolean; currentJob?: JobRecord; setStatus: (message: string) => void; onAssetChange: (assetId: string | undefined) => void; onJobCreated: (jobId: string) => void }) {
  const [assets, setAssets] = useState<AssetGroup[]>([]);
  const [episode, setEpisode] = useState<EpisodeRecord>();
  const [selectedAssetId, setSelectedAssetId] = useState(initialAssetId);
  const [candidatesByAsset, setCandidatesByAsset] = useState<CandidateMap>({});
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const mutationLatch = useRef(false);
  const hydrateEpoch = useRef(0);
  const candidateEpochs = useRef<Record<string, number>>({});
  const [newAssetName, setNewAssetName] = useState("");
  const [newAssetType, setNewAssetType] = useState<AssetType>("character");
  const [parentAssetId, setParentAssetId] = useState("");
  const [stateLabel, setStateLabel] = useState("");
  const [aliasDraft, setAliasDraft] = useState("");
  const [promptParts, setPromptParts] = useState<PromptParts>({ evidence: "", sceneIntent: "", subjectAction: "", environment: "", lightingComposition: "", styleConstraints: "写实悬疑，人物与年代细节一致，不虚构原文没有的品牌和文字" });
  const allAssets = useMemo(() => flattenAssets(assets), [assets]);
  const selectedAsset = allAssets.find((asset) => asset.id === selectedAssetId);
  const candidates = selectedAssetId ? candidatesByAsset[selectedAssetId] ?? [] : [];
  const gaps = useMemo(() => assetGapCounts(allAssets, candidatesByAsset), [allAssets, candidatesByAsset]);
  const prompt = selectedAsset ? assembleImagePrompt({ ...promptParts, assetName: selectedAsset.name, assetState: selectedAsset.stateLabel }) : "";
  const busy = externalBusy || loading || mutating;

  async function fetchCandidates(assetId: string) {
    const body = await responseJson<{ items: CandidateRecord[] }>(await fetch(`/api/assets/${encodeURIComponent(assetId)}/candidates`));
    return body.items;
  }

  async function fetchAssetsAndCandidates() {
    const body = await responseJson<{ items: AssetGroup[] }>(await fetch(`/api/series/${encodeURIComponent(seriesId)}/assets`));
    const flattened = flattenAssets(body.items);
    const entries = await Promise.all(flattened.map(async (asset) => [asset.id, await fetchCandidates(asset.id)] as const));
    return { groups: body.items, flattened, candidates: Object.fromEntries(entries) as CandidateMap };
  }

  function applyAssetSnapshot(snapshot: Awaited<ReturnType<typeof fetchAssetsAndCandidates>>, preferredId: string | undefined) {
    setAssets(snapshot.groups);
    setCandidatesByAsset(snapshot.candidates);
    const nextId = snapshot.flattened.some((asset) => asset.id === preferredId) ? preferredId : snapshot.flattened[0]?.id;
    setSelectedAssetId(nextId);
    onAssetChange(nextId);
    return snapshot.flattened.length;
  }

  async function refreshCandidates(assetId: string) {
    const epoch = (candidateEpochs.current[assetId] ?? 0) + 1;
    candidateEpochs.current[assetId] = epoch;
    const items = await fetchCandidates(assetId);
    if (!canApplyCandidateRefresh(assetId, candidateEpochs.current[assetId] ?? 0, epoch, items)) return false;
    setCandidatesByAsset((current) => ({ ...current, [assetId]: items }));
    return true;
  }

  useEffect(() => {
    const epoch = ++hydrateEpoch.current;
    setLoading(true);
    setStatus("正在恢复系列资产、生产缺口和分集门禁…");
    async function hydrate() {
      try {
        const [snapshot, episodeResult] = await Promise.all([
          fetchAssetsAndCandidates(),
          fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`)
            .then((response) => responseJson<{ episode: EpisodeRecord }>(response))
            .catch(() => undefined),
        ]);
        if (hydrateEpoch.current !== epoch) return;
        const count = applyAssetSnapshot(snapshot, initialAssetId);
        setEpisode(episodeResult?.episode);
        setStatus(`系列资产生产缺口已恢复，共 ${count} 个主/状态资产`);
      } catch (error) {
        if (hydrateEpoch.current === epoch) setStatus(`资产工作区恢复失败：${(error as Error).message}`);
      } finally {
        if (hydrateEpoch.current === epoch) setLoading(false);
      }
    }
    void hydrate();
    return () => { hydrateEpoch.current += 1; };
  }, [seriesId, episodeIndex]);

  const completedAssetId = generatedCandidateAssetId(currentJob);
  useEffect(() => {
    if (!completedAssetId || !allAssets.some((asset) => asset.id === completedAssetId)) return;
    setStatus("生图任务已完成，正在回读对应资产候选图…");
    void refreshCandidates(completedAssetId)
      .then((applied) => { if (applied) setStatus("生图候选已从持久层回读"); })
      .catch((error) => setStatus(`生图候选回读失败：${(error as Error).message}`));
  }, [currentJob?.id, completedAssetId, allAssets]);

  function beginMutation(message: string) {
    if (externalBusy || mutationLatch.current) return false;
    mutationLatch.current = true;
    setMutating(true);
    setStatus(message);
    return true;
  }

  function endMutation() {
    mutationLatch.current = false;
    setMutating(false);
  }

  function chooseAsset(id: string) { setSelectedAssetId(id); onAssetChange(id); setStatus("已切换资产；候选图按该资产独立显示"); }
  function updatePromptPart(key: keyof PromptParts, value: string) { setPromptParts((current) => ({ ...current, [key]: value })); }

  async function createAsset() {
    if (!newAssetName.trim() || !beginMutation(parentAssetId ? "正在创建状态资产…" : "正在创建主资产…")) return;
    try {
      const body = await responseJson<{ message: string; asset: AssetRecord }>(await fetch(`/api/series/${encodeURIComponent(seriesId)}/assets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: newAssetType, name: newAssetName.trim(), ...(parentAssetId ? { parentAssetId, stateLabel: stateLabel.trim() } : {}) }) }));
      const snapshot = await fetchAssetsAndCandidates();
      applyAssetSnapshot(snapshot, body.asset.id);
      setNewAssetName(""); setParentAssetId(""); setStateLabel(""); setStatus(body.message);
    } catch (error) { setStatus(`资产创建失败：${(error as Error).message}`); }
    finally { endMutation(); }
  }

  async function addAlias() {
    if (!selectedAsset || !aliasDraft.trim() || !beginMutation("正在保存资产别名…")) return;
    const assetId = selectedAsset.id;
    try {
      const body = await responseJson<{ message: string }>(await fetch(`/api/assets/${encodeURIComponent(assetId)}/aliases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aliases: [aliasDraft.trim()] }) }));
      const snapshot = await fetchAssetsAndCandidates();
      applyAssetSnapshot(snapshot, assetId);
      setAliasDraft(""); setStatus(body.message);
    } catch (error) { setStatus(`别名保存失败：${(error as Error).message}`); }
    finally { endMutation(); }
  }

  async function uploadCandidate(file: File) {
    if (!selectedAsset || !beginMutation("正在上传原图候选…")) return;
    const assetId = selectedAsset.id;
    try {
      await responseJson(await fetch(`/api/assets/${encodeURIComponent(assetId)}/candidates/upload`, candidateUploadRequest(file)));
      await refreshCandidates(assetId);
      setStatus("原图候选已上传并从持久层回读");
    } catch (error) { setStatus(`原图上传失败：${(error as Error).message}`); }
    finally { endMutation(); }
  }

  async function generateCandidate() {
    if (!selectedAsset || !episode || !promptParts.evidence.trim() || !promptParts.sceneIntent.trim() || !promptParts.subjectAction.trim() || !beginMutation("正在创建可恢复的生图任务…")) return;
    try {
      const body = await responseJson<{ message: string; job: { id: string } }>(await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "image_candidate_generate", payload: { episodeId: episode.id, assetId: selectedAsset.id, prompt } }) }));
      onJobCreated(body.job.id); setStatus(body.message);
    } catch (error) { setStatus(`生图任务创建失败：${(error as Error).message}`); }
    finally { endMutation(); }
  }

  async function reviewCandidate(candidate: CandidateRecord, action: "approve" | "reject") {
    if (!beginMutation(action === "approve" ? "正在批准候选图…" : "正在淘汰候选图…")) return;
    try {
      await responseJson(await fetch(`/api/candidates/${encodeURIComponent(candidate.id)}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: candidate.reviewRevision, action }) }));
      await refreshCandidates(candidate.assetId);
      setStatus(action === "approve" ? "候选图已批准，可供视觉段显式绑定" : "候选图已淘汰，历史仍保留");
    } catch (error) { setStatus(`候选审核失败：${(error as Error).message}`); }
    finally { endMutation(); }
  }

  return { assets, allAssets, episode, selectedAsset, candidates, gaps, busy, newAssetName, setNewAssetName, newAssetType, setNewAssetType, parentAssetId, setParentAssetId, stateLabel, setStateLabel, aliasDraft, setAliasDraft, promptParts, updatePromptPart, prompt, chooseAsset, createAsset, addAlias, uploadCandidate, generateCandidate, reviewCandidate };
}
