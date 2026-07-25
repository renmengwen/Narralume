import assert from "node:assert/strict";
import test from "node:test";

import { parseChapterAnalysisEvents, type ChapterEvidenceAtom } from "./chapter-event-analyzer.js";

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
