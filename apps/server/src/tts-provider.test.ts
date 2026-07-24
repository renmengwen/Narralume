import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  synthesizeSystemSpeech,
  SYSTEM_SPEECH_UTF8_INPUT,
  systemSpeechInputHash,
  TtsCancelledError,
  TtsProviderError,
} from "./tts-provider.js";

test("System.Speech 生成原子 WAV，并清理失败与取消的临时文件", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "narralume-tts-provider-"));
  const identity = { scriptVersionId: "script_test", contentHash: "a".repeat(64) };
  try {
    const sample = "中文 Narralume";
    const decoder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `${SYSTEM_SPEECH_UTF8_INPUT}; ([Console]::In.ReadToEnd().ToCharArray() | ForEach-Object {[int]$_}) -join ','`,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
    decoder.stdout.setEncoding("utf8");
    let decoded = "";
    decoder.stdout.on("data", (chunk: string) => { decoded += chunk; });
    decoder.stdin.end(sample, "utf8");
    const [decoderCode] = await once(decoder, "close");
    assert.equal(decoderCode, 0);
    assert.equal(decoded.trim(), [...sample].map((character) => character.charCodeAt(0)).join(","));

    const outputPath = join(root, "voice.wav");
    const result = await synthesizeSystemSpeech({
      ...identity,
      text: "你好，这是 Narralume 的本机语音测试。",
      outputPath,
    });
    const bytes = await readFile(outputPath);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
    assert.equal(result.bytes, bytes.length);
    assert.notEqual(
      systemSpeechInputHash({ ...identity, text: "测试", rate: 0 }),
      systemSpeechInputHash({ ...identity, text: "测试", rate: 1 }),
      "语速变化必须改变输入身份",
    );

    await assert.rejects(
      synthesizeSystemSpeech({
        ...identity,
        text: "错误语音测试",
        outputPath: join(root, "invalid.wav"),
        voice: "不存在的 Narralume Voice",
      }),
      (error) => error instanceof TtsProviderError && /本机语音生成失败/.test(error.message),
    );

    const controller = new AbortController();
    const cancelled = synthesizeSystemSpeech({
      ...identity,
      text: "这段语音用于验证取消。".repeat(2_000),
      outputPath: join(root, "cancelled.wav"),
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await readdir(root)).some((name) => name.endsWith(".tmp.wav"))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert((await readdir(root)).some((name) => name.endsWith(".tmp.wav")), "取消前子进程必须已持有临时 WAV");
    controller.abort();
    await assert.rejects(cancelled, (error) => error instanceof TtsCancelledError);
    assert.deepEqual((await readdir(root)).sort(), ["voice.wav"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
