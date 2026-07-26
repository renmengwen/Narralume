import { responseJson } from "../client-logic";

export const MODEL_TYPES = ["text", "image", "tts"] as const;
export type ModelType = typeof MODEL_TYPES[number];

export interface ModelEntry {
  enabled: boolean;
  modelId: string;
  note: string;
  voiceId?: string;
  voiceLabel?: string;
  language?: string;
  gender?: "male" | "female" | "";
  wordBoundary?: boolean;
}

export interface ModelProvider {
  id: string;
  name: string;
  kind: "openai-compatible" | "edge-tts" | "minimax" | "mimo";
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  models: Record<ModelType, ModelEntry>;
}

export interface ModelConfig {
  providers: Record<string, ModelProvider>;
  active: Record<ModelType, string>;
}

export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  text: "分析与改编",
  image: "图片生成",
  tts: "语音合成",
};

export async function loadModelConfig() {
  const body = await responseJson<{ config: ModelConfig }>(await fetch("/api/config/models"));
  return body.config;
}

export async function saveModelConfig(config: ModelConfig) {
  const body = await responseJson<{ message: string; config: ModelConfig }>(
    await fetch("/api/config/models", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    }),
  );
  return body;
}

export function providerList(config: ModelConfig) {
  return Object.values(config.providers);
}

export function activeModelLabel(config: ModelConfig, type: ModelType) {
  const [providerId, modelType] = (config.active[type] ?? "").split("/");
  if (!providerId) return "未配置";
  const provider = config.providers[providerId];
  const model = provider?.models[modelType as ModelType];
  if (!provider || !model?.modelId) return "未配置";
  if (provider.kind === "edge-tts") return `${provider.name} / ${model.voiceLabel || model.voiceId || model.modelId}`;
  return `${provider.name} / ${model.modelId}`;
}

export function updateProvider(config: ModelConfig, provider: ModelProvider): ModelConfig {
  return { ...config, providers: { ...config.providers, [provider.id]: provider } };
}

export function updateActive(config: ModelConfig, type: ModelType, value: string): ModelConfig {
  const [providerId, modelType] = value.split("/");
  const provider = providerId && modelType === type ? config.providers[providerId] : undefined;
  if (!provider?.models[type]?.modelId) return { ...config, active: { ...config.active, [type]: value } };
  return updateProvider(
    { ...config, active: { ...config.active, [type]: value } },
    {
      ...provider,
      models: {
        ...provider.models,
        [type]: { ...provider.models[type], enabled: true },
      },
    },
  );
}
