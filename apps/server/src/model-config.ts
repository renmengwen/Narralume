import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const MODEL_CONFIG_TYPES = ["text", "image", "tts"] as const;
export type ModelConfigType = typeof MODEL_CONFIG_TYPES[number];

const DEFAULT_EDGE_VOICE_ID = "zh-CN-YunjianNeural";
const DEFAULT_EDGE_VOICE_LABEL = "Chinese - China - Yunjian";

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
  models: Record<ModelConfigType, ModelEntry>;
}

export interface StoredModelConfig {
  providers: Record<string, ModelProvider>;
  active: Record<ModelConfigType, string>;
}

export interface RuntimeModelConfig {
  enabled: true;
  type: ModelConfigType;
  providerId: string;
  providerName: string;
  providerKind: ModelProvider["kind"];
  baseUrl: string;
  apiKey: string;
  modelId: string;
  voiceId?: string;
  voiceLabel?: string;
  language?: string;
  gender?: "male" | "female" | "";
  wordBoundary?: boolean;
}

function emptyModel(): ModelEntry {
  return { enabled: false, modelId: "", note: "" };
}

function defaultModels(overrides: Partial<Record<ModelConfigType, Partial<ModelEntry>>> = {}) {
  const models = {} as Record<ModelConfigType, ModelEntry>;
  for (const type of MODEL_CONFIG_TYPES) models[type] = { ...emptyModel(), ...overrides[type] };
  return models;
}

export function defaultModelConfig(): StoredModelConfig {
  return {
    providers: {
      "edge-tts": {
        id: "edge-tts",
        name: "Edge TTS",
        kind: "edge-tts",
        baseUrl: "",
        apiKey: "",
        models: defaultModels({
          tts: {
            enabled: true,
            modelId: "node-edge-tts",
            note: "默认中文男声，支持逐词时间边界。",
            voiceId: DEFAULT_EDGE_VOICE_ID,
            voiceLabel: DEFAULT_EDGE_VOICE_LABEL,
            language: "zh-CN",
            gender: "male",
            wordBoundary: true,
          },
        }),
      },
      minimax: {
        id: "minimax",
        name: "MiniMax",
        kind: "minimax",
        baseUrl: "https://api.minimaxi.com/v1",
        apiKey: "",
        models: defaultModels({
          tts: { enabled: false, modelId: "speech-2.8-hd", note: "", voiceId: "Chinese_deep_voiced_male_nv1" },
        }),
      },
      mimo: {
        id: "mimo",
        name: "MiMo",
        kind: "mimo",
        baseUrl: "https://api.xiaomimimo.com/v1",
        apiKey: "",
        models: defaultModels({
          tts: { enabled: false, modelId: "mimo-v2.5-tts", note: "", voiceId: "mimo_default" },
        }),
      },
      "openai-compatible": {
        id: "openai-compatible",
        name: "OpenAI 兼容",
        kind: "openai-compatible",
        baseUrl: "",
        apiKey: "",
        models: defaultModels(),
      },
    },
    active: { text: "", image: "", tts: "edge-tts/tts" },
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKind(value: unknown): ModelProvider["kind"] {
  const kind = stringValue(value);
  return kind === "edge-tts" || kind === "minimax" || kind === "mimo" || kind === "openai-compatible"
    ? kind
    : "openai-compatible";
}

function normalizeGender(value: unknown): "male" | "female" | "" {
  return value === "male" || value === "female" ? value : "";
}

function normalizeModelEntry(type: ModelConfigType, input: unknown): ModelEntry {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const entry: ModelEntry = {
    enabled: raw.enabled === true,
    modelId: stringValue(raw.modelId),
    note: stringValue(raw.note),
  };
  if (type === "tts") {
    entry.voiceId = stringValue(raw.voiceId);
    entry.voiceLabel = stringValue(raw.voiceLabel);
    entry.language = stringValue(raw.language);
    entry.gender = normalizeGender(raw.gender);
    entry.wordBoundary = raw.wordBoundary === true;
  }
  return entry;
}

function normalizeProvider(id: string, input: unknown, previous?: ModelProvider): ModelProvider {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawModels = raw.models && typeof raw.models === "object" ? raw.models as Record<string, unknown> : {};
  const provider: ModelProvider = {
    id,
    name: stringValue(raw.name) || id,
    kind: normalizeKind(raw.kind),
    baseUrl: stringValue(raw.baseUrl).replace(/\/+$/, ""),
    apiKey: stringValue(raw.apiKey) || previous?.apiKey || "",
    models: defaultModels(),
  };
  for (const type of MODEL_CONFIG_TYPES) provider.models[type] = normalizeModelEntry(type, rawModels[type]);
  if (provider.kind === "edge-tts") {
    provider.apiKey = "";
    provider.baseUrl = "";
    provider.models.tts = {
      ...provider.models.tts,
      enabled: true,
      modelId: provider.models.tts.modelId || "node-edge-tts",
      voiceId: provider.models.tts.voiceId || DEFAULT_EDGE_VOICE_ID,
      voiceLabel: provider.models.tts.voiceLabel || DEFAULT_EDGE_VOICE_LABEL,
      language: provider.models.tts.language || "zh-CN",
      gender: provider.models.tts.gender || "male",
      wordBoundary: true,
    };
  }
  return provider;
}

function normalizeActive(input: unknown) {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const active = {} as Record<ModelConfigType, string>;
  for (const type of MODEL_CONFIG_TYPES) active[type] = stringValue(raw[type]);
  if (!active.tts) active.tts = "edge-tts/tts";
  return active;
}

export function normalizeModelConfig(input: unknown, previous?: StoredModelConfig): StoredModelConfig {
  const defaults = defaultModelConfig();
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const rawProviders = raw.providers && typeof raw.providers === "object"
    ? raw.providers as Record<string, unknown>
    : {};
  const providers: Record<string, ModelProvider> = { ...defaults.providers };
  for (const [id, value] of Object.entries(rawProviders)) {
    providers[id] = normalizeProvider(id, value, previous?.providers[id]);
  }
  providers["edge-tts"] ??= defaults.providers["edge-tts"]!;
  const active = normalizeActive(raw.active);
  for (const type of MODEL_CONFIG_TYPES) {
    const [providerId, modelType] = active[type].split("/");
    const model = providerId && modelType === type ? providers[providerId]?.models[type] : undefined;
    if (model?.modelId) model.enabled = true;
  }
  return { providers, active };
}

function maskApiKey(apiKey: string) {
  if (!apiKey) return "";
  if (apiKey.length <= 4) return "****";
  return `${apiKey.startsWith("sk-") ? "sk-" : ""}****${apiKey.slice(-4)}`;
}

export function toPublicModelConfig(config: StoredModelConfig) {
  const publicProviders: Record<string, Omit<ModelProvider, "apiKey"> & {
    apiKey: "";
    hasApiKey: boolean;
    apiKeyMasked: string;
  }> = {};
  const normalized = normalizeModelConfig(config);
  for (const [id, provider] of Object.entries(normalized.providers)) {
    publicProviders[id] = {
      ...provider,
      apiKey: "",
      hasApiKey: !!provider.apiKey,
      apiKeyMasked: maskApiKey(provider.apiKey),
    };
  }
  return { providers: publicProviders, active: normalized.active };
}

export function modelConfigPath(dataRoot: string) {
  return join(dataRoot, "config", "models.json");
}

export async function readModelConfig(dataRoot: string): Promise<StoredModelConfig> {
  try {
    return normalizeModelConfig(JSON.parse(await readFile(modelConfigPath(dataRoot), "utf8")));
  } catch {
    return defaultModelConfig();
  }
}

export async function writeModelConfig(dataRoot: string, input: unknown) {
  const previous = await readModelConfig(dataRoot);
  const config = normalizeModelConfig(input, previous);
  const file = modelConfigPath(dataRoot);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2), "utf8");
  await rename(temporary, file);
  return config;
}

export function resolveRuntimeModelConfig(
  type: ModelConfigType,
  config: StoredModelConfig,
): RuntimeModelConfig | null {
  const normalized = normalizeModelConfig(config);
  const [providerId, modelType] = (normalized.active[type] || "").split("/");
  if (!providerId) return null;
  if (modelType !== type) return null;
  const provider = normalized.providers[providerId];
  const model = provider?.models[type];
  if (!provider || !model?.enabled || !model.modelId) return null;
  if (provider.kind !== "edge-tts" && !provider.apiKey) return null;
  return {
    enabled: true,
    type,
    providerId,
    providerName: provider.name,
    providerKind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    modelId: model.modelId,
    voiceId: model.voiceId,
    voiceLabel: model.voiceLabel,
    language: model.language,
    gender: model.gender,
    wordBoundary: model.wordBoundary,
  };
}
