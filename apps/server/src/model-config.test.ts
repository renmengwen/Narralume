import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildApp } from "./app.js";
import {
  defaultModelConfig,
  modelConfigPath,
  readModelConfig,
  resolveRuntimeModelConfig,
  toPublicModelConfig,
  writeModelConfig,
} from "./model-config.js";

test("默认模型配置使用 Edge TTS 中文男声", () => {
  const config = defaultModelConfig();
  const tts = resolveRuntimeModelConfig("tts", config);

  assert.equal(config.active.tts, "edge-tts/tts");
  assert.equal(tts?.providerKind, "edge-tts");
  assert.equal(tts?.modelId, "node-edge-tts");
  assert.equal(tts?.voiceId, "zh-CN-YunjianNeural");
  assert.equal(tts?.voiceLabel, "Chinese - China - Yunjian");
  assert.equal(tts?.language, "zh-CN");
  assert.equal(tts?.gender, "male");
  assert.equal(tts?.wordBoundary, true);
});

test("active 模型保存后自动启用供 runtime 消费", () => {
  const config = defaultModelConfig();
  const minimax = config.providers.minimax!;
  const saved = {
    ...config,
    providers: {
      ...config.providers,
      minimax: {
        ...minimax,
        apiKey: "secret",
        models: {
          ...minimax.models,
          tts: { ...minimax.models.tts, enabled: false },
        },
      },
    },
    active: { ...config.active, tts: "minimax/tts" },
  };

  const runtime = resolveRuntimeModelConfig("tts", saved);

  assert.equal(runtime?.providerKind, "minimax");
  assert.equal(runtime?.modelId, "speech-2.8-hd");
});

test("保存配置不回显完整 key，空 key 保留旧 key", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-model-config-"));
  try {
    await writeModelConfig(dataRoot, {
      providers: {
        minimax: {
          name: "MiniMax",
          kind: "minimax",
          baseUrl: "https://api.minimaxi.com/v1/",
          apiKey: "sk-secret-1234",
          models: { tts: { enabled: true, modelId: "speech-2.8-hd", voiceId: "voice-a" } },
        },
      },
      active: { tts: "minimax/tts" },
    });
    const preserved = await writeModelConfig(dataRoot, {
      providers: {
        minimax: {
          name: "MiniMax",
          kind: "minimax",
          baseUrl: "https://api.minimaxi.com/v1",
          apiKey: "",
          models: { tts: { enabled: true, modelId: "speech-2.8-hd", voiceId: "voice-b" } },
        },
      },
      active: { tts: "minimax/tts" },
    });
    const publicConfig = toPublicModelConfig(preserved);
    const publicMiniMax = publicConfig.providers.minimax;
    const runtime = resolveRuntimeModelConfig("tts", preserved);
    const raw = JSON.parse(await readFile(modelConfigPath(dataRoot), "utf8"));

    assert.ok(publicMiniMax);
    assert.equal(runtime?.apiKey, "sk-secret-1234");
    assert.equal(runtime?.baseUrl, "https://api.minimaxi.com/v1");
    assert.equal(runtime?.voiceId, "voice-b");
    assert.equal(publicMiniMax.apiKey, "");
    assert.equal(publicMiniMax.hasApiKey, true);
    assert.equal(publicMiniMax.apiKeyMasked, "sk-****1234");
    assert.equal(raw.providers.minimax.apiKey, "sk-secret-1234");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("模型配置 HTTP API 支持读取、保存和重启恢复", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-model-config-api-"));
  let app = buildApp({ dataRoot, logger: false });

  try {
    const defaults = await app.inject({ method: "GET", url: "/api/config/models" });
    assert.equal(defaults.statusCode, 200);
    assert.equal(defaults.json().config.active.tts, "edge-tts/tts");
    assert.equal(defaults.json().config.providers["edge-tts"].apiKey, "");

    const saved = await app.inject({
      method: "PUT",
      url: "/api/config/models",
      payload: {
        providers: {
          minimax: {
            name: "MiniMax",
            kind: "minimax",
            baseUrl: "https://api.minimaxi.com/v1",
            apiKey: "secret-9999",
            models: { tts: { enabled: true, modelId: "speech-2.8-hd", voiceId: "voice-c" } },
          },
        },
        active: { tts: "minimax/tts" },
      },
    });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().config.providers.minimax.apiKey, "");
    assert.equal(saved.json().config.providers.minimax.apiKeyMasked, "****9999");

    await app.close();
    app = buildApp({ dataRoot, logger: false });
    const restored = await app.inject({ method: "GET", url: "/api/config/models" });
    const stored = await readModelConfig(dataRoot);
    assert.equal(restored.json().config.active.tts, "minimax/tts");
    assert.equal(resolveRuntimeModelConfig("tts", stored)?.apiKey, "secret-9999");
  } finally {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
