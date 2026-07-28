const MAX_STREAM_BYTES = 1024 * 1024;

type TextModelProtocol = "openai-response" | "anthropic-message";

interface StreamTextOptions {
  signal?: AbortSignal;
  onActivity?: () => void;
}

function streamError(message: string) {
  return new Error(`模型流式响应无效：${message}`);
}

async function readWithSignal(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  if (!signal) return reader.read();
  signal.throwIfAborted();
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export async function streamedText(
  response: Response,
  protocol: TextModelProtocol,
  options: StreamTextOptions = {},
) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_STREAM_BYTES) {
    await response.body?.cancel();
    throw streamError("原始响应超过大小限制");
  }
  if (!response.body) throw streamError("没有返回内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let rawBytes = 0;
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let text = "";
  let terminal = false;

  const append = (value: string) => {
    text += value;
    if (text.length > MAX_STREAM_BYTES) throw streamError("文本超过大小限制");
  };
  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = "";
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    const named = eventName;
    eventName = "";
    if (data === "[DONE]") return;
    let value: Record<string, unknown>;
    try { value = JSON.parse(data) as Record<string, unknown>; }
    catch { throw streamError("事件不是有效 JSON"); }
    const type = typeof value.type === "string" ? value.type : named;
    if (protocol === "openai-response") {
      if (type === "response.output_text.delta") {
        if (typeof value.delta !== "string") throw streamError("文本增量缺失");
        append(value.delta);
      } else if (type === "response.completed") terminal = true;
      else if (["response.failed", "response.incomplete", "error"].includes(type)) {
        throw streamError(`收到失败终态 ${type}`);
      }
      return;
    }
    if (type === "content_block_start") {
      const block = value.content_block as { type?: unknown; text?: unknown } | undefined;
      if (block?.type === "text" && typeof block.text === "string") append(block.text);
    } else if (type === "content_block_delta") {
      const delta = value.delta as { type?: unknown; text?: unknown } | undefined;
      if (delta?.type === "text_delta") {
        if (typeof delta.text !== "string") throw streamError("文本增量缺失");
        append(delta.text);
      }
    } else if (type === "message_stop") terminal = true;
    else if (type === "error") throw streamError("收到失败终态 error");
  };
  const line = (value: string) => {
    if (value === "") return dispatch();
    if (value.startsWith(":")) return;
    const separator = value.indexOf(":");
    const field = separator < 0 ? value : value.slice(0, separator);
    let fieldValue = separator < 0 ? "" : value.slice(separator + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    if (field === "event") eventName = fieldValue;
    else if (field === "data") {
      dataLines.push(fieldValue);
      if (dataLines.join("\n").length > MAX_STREAM_BYTES) throw streamError("事件超过大小限制");
    }
  };
  const consumeLines = (eof = false) => {
    let start = 0;
    for (let cursor = 0; cursor < buffer.length; cursor += 1) {
      const character = buffer[cursor];
      if (character !== "\r" && character !== "\n") continue;
      if (character === "\r" && cursor === buffer.length - 1 && !eof) break;
      line(buffer.slice(start, cursor));
      if (character === "\r" && buffer[cursor + 1] === "\n") cursor += 1;
      start = cursor + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > MAX_STREAM_BYTES) throw streamError("行缓冲超过大小限制");
    if (eof && buffer) {
      line(buffer);
      buffer = "";
    }
    if (eof) dispatch();
  };

  try {
    while (!terminal) {
      const { done, value } = await readWithSignal(reader, options.signal);
      if (done) {
        try { buffer += decoder.decode(); }
        catch { throw streamError("UTF-8 编码无效"); }
        consumeLines(true);
        break;
      }
      rawBytes += value.byteLength;
      if (rawBytes > MAX_STREAM_BYTES) throw streamError("原始响应超过大小限制");
      if (value.byteLength > 0) options.onActivity?.();
      try { buffer += decoder.decode(value, { stream: true }); }
      catch { throw streamError("UTF-8 编码无效"); }
      consumeLines();
    }
    if (!terminal) throw streamError("连接结束前没有明确成功终态");
    return text;
  } finally {
    try { await reader.cancel(); } catch { /* fetch abort may already have errored the stream */ }
    reader.releaseLock();
  }
}
