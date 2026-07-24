import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const PROVIDER_VERSION = "windows-system-speech-v1";
export const SYSTEM_SPEECH_UTF8_INPUT = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)";
const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
${SYSTEM_SPEECH_UTF8_INPUT}
Add-Type -AssemblyName System.Speech
$s = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $s.SelectVoice($env:NARRALUME_TTS_VOICE)
  $s.Rate = [int]$env:NARRALUME_TTS_RATE
  $s.SetOutputToWaveFile($env:NARRALUME_TTS_OUTPUT)
  $s.Speak([Console]::In.ReadToEnd())
} finally {
  $s.Dispose()
}
`;

export class TtsProviderError extends Error {}
export class TtsCancelledError extends TtsProviderError {}

export interface SystemSpeechInput {
  text: string;
  outputPath: string;
  scriptVersionId: string;
  contentHash: string;
  signal?: AbortSignal;
  voice?: string;
  rate?: number;
}

export function systemSpeechInputHash(input: Pick<SystemSpeechInput,
  "text" | "scriptVersionId" | "contentHash" | "voice" | "rate">) {
  const voice = input.voice ?? "Microsoft Huihui Desktop";
  const rate = input.rate ?? 0;
  return createHash("sha256").update(JSON.stringify({
    contract: PROVIDER_VERSION,
    scriptVersionId: input.scriptVersionId,
    contentHash: input.contentHash,
    text: input.text,
    voice,
    rate,
  })).digest("hex");
}

export async function synthesizeSystemSpeech(input: SystemSpeechInput) {
  const text = input.text.trim();
  const voice = input.voice ?? "Microsoft Huihui Desktop";
  const rate = input.rate ?? 0;
  if (!text) throw new TtsProviderError("语音文本不能为空");
  if (!input.scriptVersionId || !/^[0-9a-f]{64}$/.test(input.contentHash)) {
    throw new TtsProviderError("批准稿身份无效");
  }
  if (!voice.trim() || !Number.isInteger(rate) || rate < -10 || rate > 10) {
    throw new TtsProviderError("本机语音配置无效");
  }
  if (input.signal?.aborted) throw new TtsCancelledError("语音生成已取消");

  const outputPath = resolve(input.outputPath);
  const outputDirectory = dirname(outputPath);
  const temporaryPath = join(outputDirectory, `.${basename(outputPath)}.${randomUUID()}.tmp.wav`);
  await mkdir(outputDirectory, { recursive: true });
  try {
    await stat(outputPath);
    throw new TtsProviderError("语音输出已存在");
  } catch (error) {
    if (error instanceof TtsProviderError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let stderr = "";
  let published = false;
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT], {
      windowsHide: true,
      shell: false,
      signal: input.signal,
      env: {
        ...process.env,
        NARRALUME_TTS_VOICE: voice,
        NARRALUME_TTS_RATE: String(rate),
        NARRALUME_TTS_OUTPUT: temporaryPath,
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8192); });
    await new Promise<void>((resolvePromise, reject) => {
      let childError: Error | undefined;
      child.once("error", (error) => {
        if (child.pid === undefined) reject(error);
        else childError = error;
      });
      child.stdin.once("error", (error: NodeJS.ErrnoException) => {
        if (!input.signal?.aborted && error.code !== "EPIPE" && error.code !== "EOF") childError = error;
      });
      child.once("close", (code) => {
        if (input.signal?.aborted) reject(new TtsCancelledError("语音生成已取消"));
        else if (childError) reject(childError);
        else if (code === 0) resolvePromise();
        else reject(new TtsProviderError(`本机语音生成失败${stderr.trim() ? `：${stderr.trim()}` : ""}`));
      });
      child.stdin.end(text, "utf8");
    });
    const info = await stat(temporaryPath);
    if (!info.isFile() || info.size <= 44) throw new TtsProviderError("本机语音未生成有效 WAV 文件");
    const header = Buffer.alloc(12);
    const file = await open(temporaryPath, "r");
    try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
      throw new TtsProviderError("本机语音输出不是 WAV 文件");
    }
    // ponytail: P4-01 由单任务独占最终路径；出现并行同哈希生产时在 P4-02 加内容寻址复用。
    await rename(temporaryPath, outputPath);
    published = true;
    return {
      providerId: "windows-system-speech",
      voice,
      rate,
      inputHash: systemSpeechInputHash({ ...input, text, voice, rate }),
      outputPath,
      bytes: info.size,
    };
  } catch (error) {
    if (input.signal?.aborted || (error as NodeJS.ErrnoException).name === "AbortError") {
      throw new TtsCancelledError("语音生成已取消");
    }
    if (error instanceof TtsProviderError) throw error;
    throw new TtsProviderError(`本机语音生成失败：${error instanceof Error ? error.message : "未知错误"}`);
  } finally {
    if (!published) await rm(temporaryPath, { force: true });
  }
}
