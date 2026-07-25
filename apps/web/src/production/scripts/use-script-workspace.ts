import { useEffect, useRef, useState } from "react";

import { responseJson } from "../../client-logic";
import type { Episode, ScriptApproval, ScriptVersion, ScriptVersionKind } from "../types";
import {
  approvalPutPayload,
  emptyScriptParagraph,
  scriptDraft,
  scriptPostPayload,
  type ScriptParagraphDraft,
} from "./script-editor";

interface WorkspaceSnapshot {
  episode: Episode;
  scripts: ScriptVersion[];
  approval: ScriptApproval;
}

export function useScriptWorkspace({ seriesId, episodeIndex, setBusy, setStatus }: {
  seriesId: string;
  episodeIndex: number;
  setBusy: (busy: boolean) => void;
  setStatus: (message: string) => void;
}) {
  const [episode, setEpisode] = useState<Episode>();
  const [scripts, setScripts] = useState<ScriptVersion[]>([]);
  const [approval, setApproval] = useState<ScriptApproval>();
  const [kind, setKind] = useState<ScriptVersionKind>("faithful");
  const [parentVersionId, setParentVersionId] = useState("");
  const [paragraphs, setParagraphs] = useState<ScriptParagraphDraft[]>(() => [emptyScriptParagraph()]);
  const [selectedPackagedId, setSelectedPackagedId] = useState("");
  const writing = useRef(false);
  const mounted = useRef(true);
  const routeKey = `${seriesId}:${episodeIndex}`;
  const currentRoute = useRef(routeKey);
  currentRoute.current = routeKey;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; currentRoute.current = ""; setBusy(false); };
  }, []);

  const baseUrl = `/api/series/${encodeURIComponent(seriesId)}/episodes/${episodeIndex}`;

  async function readWorkspace(expectedRoute: string): Promise<WorkspaceSnapshot | undefined> {
    const episodeResponse = await fetch(baseUrl);
    if (episodeResponse.status === 404) return undefined;
    const restoredEpisode = (await responseJson<{ episode: Episode }>(episodeResponse)).episode;
    const [scriptsBody, approvalBody] = await Promise.all([
      responseJson<{ items: ScriptVersion[] }>(await fetch(`${baseUrl}/scripts`)),
      responseJson<{ approval: ScriptApproval }>(await fetch(`${baseUrl}/approval`)),
    ]);
    if (!mounted.current || currentRoute.current !== expectedRoute) return undefined;
    return { episode: restoredEpisode, scripts: scriptsBody.items, approval: approvalBody.approval };
  }

  function applySnapshot(snapshot: WorkspaceSnapshot | undefined, draftKind = kind) {
    setEpisode(snapshot?.episode);
    setScripts(snapshot?.scripts ?? []);
    setApproval(snapshot?.approval);
    if (!snapshot) {
      setParagraphs([emptyScriptParagraph()]);
      setParentVersionId("");
      setSelectedPackagedId("");
      return;
    }
    const latestFaithful = snapshot.scripts.filter((item) => item.kind === "faithful").at(-1);
    const packaged = snapshot.scripts.filter((item) => item.kind === "packaged");
    const latest = draftKind === "faithful" ? latestFaithful : packaged.at(-1);
    setParagraphs(scriptDraft(latest));
    setParentVersionId(draftKind === "packaged" ? latest?.parentVersionId ?? latestFaithful?.id ?? "" : "");
    setSelectedPackagedId((current) => packaged.some((item) => item.id === current)
      ? current
      : snapshot.approval.scriptVersionId ?? packaged.at(-1)?.id ?? "");
  }

  useEffect(() => {
    const expectedRoute = routeKey;
    setEpisode(undefined); setScripts([]); setApproval(undefined);
    setKind("faithful"); setParentVersionId(""); setParagraphs([emptyScriptParagraph()]); setSelectedPackagedId("");
    setBusy(true); setStatus(`正在恢复第 ${episodeIndex} 集稿件与批准状态…`);
    void readWorkspace(expectedRoute).then((snapshot) => {
      if (!mounted.current || currentRoute.current !== expectedRoute) return;
      applySnapshot(snapshot, "faithful");
      setStatus(snapshot ? `第 ${episodeIndex} 集稿件与批准状态已从服务端恢复` : `第 ${episodeIndex} 集尚未创建，请先保存故事弧`);
    }).catch((error) => {
      if (mounted.current && currentRoute.current === expectedRoute) setStatus(`稿件工作区恢复失败：${(error as Error).message}`);
    }).finally(() => {
      if (mounted.current && currentRoute.current === expectedRoute) setBusy(false);
    });
  }, [seriesId, episodeIndex]);

  function changeKind(nextKind: ScriptVersionKind) {
    setKind(nextKind);
    const faithful = scripts.filter((item) => item.kind === "faithful");
    const latest = scripts.filter((item) => item.kind === nextKind).at(-1);
    setParagraphs(scriptDraft(latest));
    setParentVersionId(nextKind === "packaged" ? latest?.parentVersionId ?? faithful.at(-1)?.id ?? "" : "");
  }

  function loadVersion(version: ScriptVersion) {
    setKind(version.kind); setParagraphs(scriptDraft(version));
    setParentVersionId(version.parentVersionId ?? "");
  }

  function chooseParent(id: string) {
    const parent = scripts.find((item) => item.id === id && item.kind === "faithful");
    setParentVersionId(id);
    if (parent) setParagraphs(scriptDraft(parent));
  }

  function updateParagraph(key: string, change: Partial<ScriptParagraphDraft>) {
    setParagraphs((current) => current.map((paragraph) => paragraph.key === key ? { ...paragraph, ...change } : paragraph));
  }

  async function refreshAfterWrite(expectedRoute: string) {
    const snapshot = await readWorkspace(expectedRoute);
    if (mounted.current && currentRoute.current === expectedRoute) applySnapshot(snapshot);
  }

  async function saveVersion() {
    if (writing.current || !episode) return;
    writing.current = true;
    const expectedRoute = routeKey;
    setBusy(true); setStatus(`正在创建第 ${episodeIndex} 集${kind === "faithful" ? "忠实稿" : "包装稿"}不可变新版本…`);
    let message = "";
    try {
      const parent = scripts.find((item) => item.id === parentVersionId);
      const payload = scriptPostPayload(kind, paragraphs, parent);
      const response = await fetch(`${baseUrl}/scripts`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const body = await responseJson<{ message: string }>(response);
      message = `${body.message}；新版本不会自动迁移批准指针`;
    } catch (error) {
      message = `稿件保存失败：${(error as Error).message}`;
    }
    try { await refreshAfterWrite(expectedRoute); }
    catch (error) { message += `；服务端回读失败：${(error as Error).message}`; }
    if (mounted.current && currentRoute.current === expectedRoute) { setStatus(message); setBusy(false); }
    writing.current = false;
  }

  async function changeApproval(action: "approve" | "withdraw") {
    if (writing.current || !approval) return;
    writing.current = true;
    const expectedRoute = routeKey;
    setBusy(true); setStatus(action === "approve" ? "正在提交人工批准…" : "正在撤回人工批准…");
    let message = "";
    try {
      const payload = approvalPutPayload(action, approval, selectedPackagedId);
      const response = await fetch(`${baseUrl}/approval`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      if (response.status === 409) {
        try { await responseJson(response); } catch (error) { message = `批准状态已变化：${(error as Error).message}；已刷新，请重新确认`; }
      } else {
        const body = await responseJson<{ message: string }>(response);
        message = body.message;
      }
    } catch (error) {
      message = `批准操作失败：${(error as Error).message}`;
    }
    try { await refreshAfterWrite(expectedRoute); }
    catch (error) { message += `；服务端回读失败：${(error as Error).message}`; }
    if (mounted.current && currentRoute.current === expectedRoute) { setStatus(message); setBusy(false); }
    writing.current = false;
  }

  return {
    episode, scripts, approval, kind, parentVersionId, paragraphs, selectedPackagedId,
    setParentVersionId: chooseParent, setSelectedPackagedId, changeKind, loadVersion, updateParagraph,
    addParagraph: () => setParagraphs((current) => [...current, emptyScriptParagraph()]),
    removeParagraph: (key: string) => setParagraphs((current) => current.length === 1 ? current : current.filter((item) => item.key !== key)),
    saveVersion, changeApproval,
  };
}
