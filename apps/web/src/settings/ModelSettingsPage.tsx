import { useEffect, useMemo, useState } from "react";

import {
  activeModelLabel,
  loadModelConfig,
  MODEL_TYPE_LABELS,
  MODEL_TYPES,
  providerList,
  saveModelConfig,
  updateActive,
  updateProvider,
  type ModelConfig,
  type ModelProvider,
  type ModelType,
} from "./model-settings";

interface ModelSettingsPageProps {
  onBack: () => void;
}

export function ModelSettingsPage({ onBack }: ModelSettingsPageProps) {
  const [config, setConfig] = useState<ModelConfig>();
  const [selectedProviderId, setSelectedProviderId] = useState("edge-tts");
  const [status, setStatus] = useState("正在加载模型配置…");
  const [statusTone, setStatusTone] = useState<"info" | "success" | "error" | "warning">("info");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatusTone("info");
    setStatus("正在加载模型配置…");
    loadModelConfig()
      .then((next) => {
        if (cancelled) return;
        setConfig(next);
        setStatusTone("success");
        setStatus("模型配置已加载。敏感字段只显示保存状态，不回显原值。");
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setStatusTone("error");
        setStatus(`模型配置加载失败：${error.message}`);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const providers = useMemo(() => config ? providerList(config) : [], [config]);
  const selectedProvider = config?.providers[selectedProviderId] ?? providers[0];

  function patchProvider(provider: ModelProvider) {
    if (!config) return;
    setConfig(updateProvider(config, provider));
    setDirty(true);
  }

  function patchTtsModel(provider: ModelProvider, field: string, value: string | boolean) {
    patchProvider({
      ...provider,
      models: {
        ...provider.models,
        tts: { ...provider.models.tts, [field]: value },
      },
    });
  }

  async function save() {
    if (!config || saving) return;
    setSaving(true);
    setStatusTone("info");
    setStatus("正在保存模型配置，请稍候…");
    try {
      const body = await saveModelConfig(config);
      setConfig(body.config);
      setDirty(false);
      setStatusTone("success");
      setStatus("模型配置已保存。默认 TTS 为 Edge TTS / Chinese - China - Yunjian。");
    } catch (error) {
      setStatusTone("error");
      setStatus(`模型配置保存失败：${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  function setActive(type: ModelType, value: string) {
    if (!config) return;
    setConfig(updateActive(config, type, value));
    setDirty(true);
  }

  function back() {
    if (!dirty || window.confirm("有未保存的模型配置，确定返回吗？")) onBack();
  }

  const statusClasses = {
    info: "border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--fg-secondary)]",
    success: "border-green-700/25 bg-green-700/10 text-green-800 dark:text-green-200",
    error: "border-red-700/25 bg-red-700/10 text-red-800 dark:text-red-200",
    warning: "border-amber-700/25 bg-amber-700/10 text-amber-800 dark:text-amber-200",
  };

  return (
    <main className="min-h-screen bg-[var(--bg-canvas)] p-7 text-[var(--fg-primary)] max-md:p-0">
      <div className="mx-auto min-h-[calc(100vh-56px)] w-full max-w-[1520px] border border-[var(--border-subtle)] bg-[var(--bg-surface)] max-md:min-h-screen max-md:border-0">
        <header className="flex min-h-28 items-center justify-between gap-6 border-b border-[var(--border-subtle)] px-7 py-6 max-md:flex-col max-md:items-start max-md:px-4">
          <div>
            <p className="mb-2 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--accent)]">NARRALUME / 全局设置</p>
            <h1 className="m-0 text-3xl font-semibold">模型设置中心</h1>
            <p className="mt-2 text-sm text-[var(--fg-secondary)]">配置分析、图片与语音模型，并指定各能力的默认运行模型。</p>
          </div>
          <div className="flex gap-2 max-md:w-full">
            <button className="min-h-11 rounded border border-[var(--border-strong)] px-4 text-sm text-[var(--fg-secondary)] hover:bg-[var(--bg-subtle)] max-md:flex-1" type="button" onClick={back}>返回上一页</button>
            <button className="min-h-11 rounded bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-contrast)] disabled:opacity-50 max-md:flex-1" type="button" disabled={!config || loading || saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存模型配置"}</button>
          </div>
        </header>

        <div className={`mx-7 mt-5 rounded border px-4 py-3 text-sm ${statusClasses[statusTone]}`} role={statusTone === "error" ? "alert" : "status"} aria-live="polite">
          {status}
        </div>
        <div className="mx-7 mt-3 flex min-h-12 items-center justify-between gap-4 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-2 text-sm text-[var(--fg-secondary)] max-md:flex-col max-md:items-start">
          <span>全局设置由书库与系列工作台共用，不属于七个制作阶段。</span>
          {dirty ? <span className="font-semibold text-amber-700 dark:text-amber-200">有未保存的修改</span> : <span className="font-mono text-[11px]">入口：顶栏「模型设置」</span>}
        </div>

        <section className="grid grid-cols-[240px_minmax(0,1fr)] gap-0 px-7 py-6 max-lg:grid-cols-1 max-md:px-4">
          <aside className="border-r border-[var(--border-subtle)] pr-4 max-lg:border-r-0 max-lg:pr-0">
            <p className="mb-3 font-mono text-[11px] font-semibold tracking-[.17em] text-[var(--fg-tertiary)]">供应商</p>
            <div className="grid gap-2 max-lg:grid-cols-2 max-sm:grid-cols-1">
              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={`min-h-16 rounded border px-3 py-2 text-left text-sm ${provider.id === selectedProvider?.id ? "border-[var(--border-strong)] bg-[var(--accent-soft)]" : "border-[var(--border-subtle)] hover:bg-[var(--bg-subtle)]"}`}
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  <strong className="block">{provider.name}</strong>
                  <span className="mt-1 block font-mono text-[11px] text-[var(--fg-tertiary)]">{provider.kind} · {provider.kind === "edge-tts" ? "默认" : provider.hasApiKey ? "已保存密钥" : "待配置"}</span>
                </button>
              ))}
            </div>
          </aside>

          <div className="min-w-0 pl-6 max-lg:mt-6 max-lg:pl-0">
            {config ? (
              <>
                <section className="border border-[var(--border-subtle)]">
                  <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3">
                    <h2 className="m-0 text-lg font-semibold">全局默认模型</h2>
                    <p className="mt-1 text-sm text-[var(--fg-secondary)]">生产任务只读取这里选中的模型；供应商编辑不会自动切换默认值。</p>
                  </div>
                  <div className="grid grid-cols-3 max-lg:grid-cols-1">
                    {MODEL_TYPES.map((type) => (
                      <label key={type} className="grid gap-2 border-r border-[var(--border-subtle)] p-4 last:border-r-0 max-lg:border-b max-lg:border-r-0 max-lg:last:border-b-0">
                        <span className="text-xs font-semibold text-[var(--fg-tertiary)]">{MODEL_TYPE_LABELS[type]}</span>
                        <select className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={config.active[type] ?? ""} onChange={(event) => setActive(type, event.target.value)}>
                          <option value="">未配置</option>
                          {providers.flatMap((provider) => {
                            const model = provider.models[type];
                            return model?.modelId ? [<option key={`${provider.id}/${type}`} value={`${provider.id}/${type}`}>{provider.kind === "edge-tts" ? `${provider.name} / ${model.voiceLabel}` : `${provider.name} / ${model.modelId}`}</option>] : [];
                          })}
                        </select>
                        <span className="truncate font-mono text-[11px] text-[var(--fg-tertiary)]">{activeModelLabel(config, type)}</span>
                      </label>
                    ))}
                  </div>
                </section>

                {selectedProvider ? (
                  <ProviderEditor provider={selectedProvider} onChange={patchProvider} onTtsChange={patchTtsModel} />
                ) : null}

                <section className="mt-5 border border-[var(--border-subtle)]">
                  <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3">
                    <h2 className="m-0 text-lg font-semibold">保存状态</h2>
                    <p className="mt-1 text-sm text-[var(--fg-secondary)]">提交时禁用重复保存；失败不会丢失页面草稿。</p>
                  </div>
                  <div className="grid grid-cols-4 gap-3 p-4 text-sm max-lg:grid-cols-2 max-sm:grid-cols-1">
                    {["正在保存模型配置，请稍候…", "模型配置已保存。", "模型配置保存失败：请检查配置。", "保存已中断，页面草稿仍保留。"].map((text) => <div className="min-h-12 border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2" key={text}>{text}</div>)}
                  </div>
                </section>
              </>
            ) : (
              <div className="border border-[var(--border-subtle)] p-8 text-sm text-[var(--fg-secondary)]">{loading ? "正在读取模型配置…" : "模型配置暂不可用。"}</div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function ProviderEditor({
  provider,
  onChange,
  onTtsChange,
}: {
  provider: ModelProvider;
  onChange: (provider: ModelProvider) => void;
  onTtsChange: (provider: ModelProvider, field: string, value: string | boolean) => void;
}) {
  const tts = provider.models.tts;
  const credentialed = provider.kind !== "edge-tts";
  return (
    <section className="mt-5 border border-[var(--border-subtle)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-4 py-3">
        <div>
          <h2 className="m-0 text-lg font-semibold">{provider.name}</h2>
          <p className="mt-1 text-sm text-[var(--fg-secondary)]">{provider.kind === "edge-tts" ? "内置零成本语音供应商，不需要 API Key。" : "保存页面草稿后，仍需点击顶部保存模型配置。"}</p>
        </div>
        <span className="rounded border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--fg-secondary)]">{credentialed && !provider.hasApiKey ? "待配置" : "已启用"}</span>
      </div>
      <div className="grid grid-cols-2 gap-4 p-4 max-lg:grid-cols-1">
        <label className="grid gap-2">
          <span className="text-xs font-semibold text-[var(--fg-tertiary)]">供应商名称</span>
          <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={provider.name} onChange={(event) => onChange({ ...provider, name: event.target.value })} />
        </label>
        {credentialed ? (
          <>
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">Base URL</span>
              <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={provider.baseUrl} onChange={(event) => onChange({ ...provider, baseUrl: event.target.value })} />
            </label>
            <label className="grid gap-2 lg:col-span-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">API Key</span>
              <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" type="password" value={provider.apiKey} placeholder={provider.hasApiKey ? `已保存 ${provider.apiKeyMasked}；输入新值可替换` : "请输入 API Key"} autoComplete="new-password" onChange={(event) => onChange({ ...provider, apiKey: event.target.value })} />
              <span className="text-xs text-[var(--fg-tertiary)]">保存后不再回显完整值；留空会保留已保存密钥。</span>
            </label>
          </>
        ) : null}
        <label className="grid gap-2">
          <span className="text-xs font-semibold text-[var(--fg-tertiary)]">{provider.kind === "edge-tts" ? "Voice" : "模型"}</span>
          <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={provider.kind === "edge-tts" ? tts.voiceLabel ?? "" : tts.modelId} disabled={provider.kind === "edge-tts"} onChange={(event) => onTtsChange(provider, "modelId", event.target.value)} />
        </label>
        {provider.kind === "edge-tts" ? (
          <>
            <div className="grid gap-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">Language / Gender</span>
              <div className="min-h-11 rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2 text-sm">中文 / 男性</div>
            </div>
            <div className="grid gap-2 lg:col-span-2">
              <span className="text-xs font-semibold text-[var(--fg-tertiary)]">逐词字幕</span>
              <div className="min-h-11 rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] px-3 py-2 text-sm">实际 voice ID：{tts.voiceId}；时间边界写入现有 cue 与 SRT/ASS，不建立独立字幕数据。</div>
            </div>
          </>
        ) : (
          <label className="grid gap-2">
            <span className="text-xs font-semibold text-[var(--fg-tertiary)]">Voice ID</span>
            <input className="min-h-11 rounded border border-[var(--border-strong)] bg-[var(--bg-inset)] px-3 text-sm" value={tts.voiceId ?? ""} onChange={(event) => onTtsChange(provider, "voiceId", event.target.value)} />
          </label>
        )}
      </div>
    </section>
  );
}
