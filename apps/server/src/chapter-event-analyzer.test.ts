import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiResponsesChapterAnalyzer,
  parseChapterAnalysisEvents,
  textModelRequest,
  type ChapterEvidenceAtom,
} from "./chapter-event-analyzer.js";

test("文本模型请求默认保持非流式，只有显式选择才发送 stream", () => {
  const normal = JSON.parse(textModelRequest({
    baseUrl: "https://model.example/v1", apiKey: "key", model: "model", providerId: "provider",
  }, "input").body) as Record<string, unknown>;
  const streamed = JSON.parse(textModelRequest({
    baseUrl: "https://model.example/v1", apiKey: "key", model: "model", providerId: "provider",
    protocol: "anthropic-message",
  }, "input", 8192, true).body) as Record<string, unknown>;
  assert.equal("stream" in normal, false);
  assert.equal(streamed.stream, true);
});

const atoms: ChapterEvidenceAtom[] = [
  { id: "evidence_a", byteStart: 100, byteEnd: 112, text: "吴邪进入墓道" },
  { id: "evidence_b", byteStart: 120, byteEnd: 132, text: "血尸突然出现" },
];

test("自动分析只把已冻结 evidenceId 映射为服务端字节范围", () => {
  assert.deepEqual(parseChapterAnalysisEvents(JSON.stringify({
    events: [{
      type: "causality",
      payload: { cause: "吴邪进入墓道", effect: "血尸出现" },
      evidenceIds: ["evidence_a", "evidence_b"],
    }],
  }), atoms), [{
    type: "causality",
    payload: { cause: "吴邪进入墓道", effect: "血尸出现" },
    sources: [{ byteStart: 100, byteEnd: 112 }, { byteStart: 120, byteEnd: 132 }],
  }]);
});

test("自动分析拒绝未知、重复 evidenceId 和模型字节偏移", () => {
  assert.throws(() => parseChapterAnalysisEvents(JSON.stringify({
    events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_missing"] }],
  }), atoms), /未知证据 ID/);
  assert.throws(() => parseChapterAnalysisEvents(JSON.stringify({
    events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["evidence_a", "evidence_a"] }],
  }), atoms), /重复引用/);
  assert.throws(() => parseChapterAnalysisEvents(JSON.stringify({
    events: [{ type: "location", payload: { name: "墓道" }, byteStart: 0, byteEnd: 1 }],
  }), atoms), /必须引用/);
});

const config = {
  baseUrl: "https://model.example/v1",
  apiKey: "key",
  model: "model",
  providerId: "provider",
};

function modelResponse(value: unknown) {
  return new Response(JSON.stringify({ output_text: typeof value === "string" ? value : JSON.stringify(value) }));
}

test("证据 ID 首答非法时只纠错一次并接受严格合法答复", async () => {
  const modelAtoms = atoms.map((atom, index) => ({ ...atom, id: `evidence_${"a".repeat(64)}_${index}` }));
  const replies = [
    { events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["e_missing"] }] },
    { events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["e1"] }] },
  ];
  const requests: string[] = [];
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async (_input, init) => {
    requests.push(String(init?.body));
    return modelResponse(replies.shift());
  }) as typeof fetch);

  assert.deepEqual(await analyzer({ chapterId: "chapter", atoms: modelAtoms }), [{
    type: "location",
    payload: { name: "墓道" },
    sources: [{ byteStart: 100, byteEnd: 112 }],
    occurrence: 0,
  }]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.doesNotMatch(request, /evidence_/);
    assert.match(request, /e1/);
    assert.match(request, /e2/);
  }
});

test("证据 ID 纠错答复仍非法时失败且不做第三次请求", async () => {
  let calls = 0;
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
    calls += 1;
    return modelResponse({ events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["e_missing"] }] });
  }) as typeof fetch);

  await assert.rejects(() => analyzer({ chapterId: "chapter", atoms }), /未知证据 ID/);
  assert.equal(calls, 2);
});

test("HTTP 和非 JSON 错误不触发证据纠错请求", async () => {
  for (const response of [new Response("failed", { status: 500 }), modelResponse("not-json")]) {
    let calls = 0;
    const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
      calls += 1;
      return response;
    }) as typeof fetch);
    await assert.rejects(() => analyzer({ chapterId: "chapter", atoms }));
    assert.equal(calls, 1);
  }
});

test("Abort 后不触发证据纠错请求", async () => {
  const controller = new AbortController();
  let calls = 0;
  const analyzer = createOpenAiResponsesChapterAnalyzer(config, (async () => {
    calls += 1;
    controller.abort();
    return modelResponse({ events: [{ type: "location", payload: { name: "墓道" }, evidenceIds: ["e_missing"] }] });
  }) as typeof fetch);

  await assert.rejects(() => analyzer({ chapterId: "chapter", atoms, signal: controller.signal }), /未知证据 ID/);
  assert.equal(calls, 1);
});

test("分批合并后为重复事件身份稳定分配 occurrence", async () => {
  const repeatedAtoms = Array.from({ length: 11 }, (_, index): ChapterEvidenceAtom => ({
    id: `evidence_${index}`,
    byteStart: index === 10 ? 100 : 100 + index * 20,
    byteEnd: index === 10 ? 112 : 112 + index * 20,
    text: `原子-${index}`,
  }));
  const replies = [
    { events: [
      { type: "location", payload: { name: "地点甲" }, evidenceIds: ["e1"] },
      { type: "location", payload: { name: "地点乙" }, evidenceIds: ["e1"] },
      { type: "character", payload: { name: "人物甲" }, evidenceIds: ["e1"] },
      { type: "location", payload: { name: "地点丙" }, evidenceIds: ["e2"] },
    ] },
    { events: [{ type: "location", payload: { name: "地点丁" }, evidenceIds: ["e1"] }] },
  ];
  const run = async () => {
    let call = 0;
    const analyzer = createOpenAiResponsesChapterAnalyzer(
      config,
      (async () => modelResponse(replies[call++])) as typeof fetch,
    );
    return analyzer({ chapterId: "chapter", atoms: repeatedAtoms });
  };

  const first = await run();
  const second = await run();
  assert.deepEqual(first.map((event) => event.occurrence), [0, 1, 0, 0, 2]);
  assert.deepEqual(second, first);
});
