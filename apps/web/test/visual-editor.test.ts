import assert from "node:assert/strict";
import test from "node:test";

import type { TtsTimeline } from "../src/production/types.ts";
import { conflictRevision, nextVisualDraft, visualDraft, visualPlanStatus, visualSegmentPayload } from "../src/production/visual/visual-editor.ts";
import type { VisualSegment } from "../src/production/visual/types.ts";

const HASH = "a".repeat(64);
const timeline = { timelineHash: HASH, cues: [0, 1, 2].map((index) => ({ index, segmentIndex: index, startMs: index * 1000, endMs: (index + 1) * 1000, text: `cue ${index}` })) } as TtsTimeline;
const segment = (index: number, ready = true): VisualSegment => ({
  id: `visual_${index}`, episodeId: "episode", segmentIndex: index, timelineHash: HASH,
  cueStartIndex: index, cueEndIndex: index, startMs: index * 1000, endMs: (index + 1) * 1000,
  motionKind: "none", motionAmountPpm: 0, fadeMs: 300, revision: 2, productionReady: ready,
  assets: [{ assetId: "asset", selectedCandidateId: "candidate", candidateReviewRevision: 1 }],
});

test("视觉段草稿从服务端 revision 恢复且新段只取第一个未覆盖 cue", () => {
  assert.equal(visualDraft(segment(0)).expectedRevision, 2);
  assert.deepEqual(nextVisualDraft(timeline, [segment(0), segment(2)]), {
    segmentIndex: 1, cueStartIndex: 1, cueEndIndex: 1, motionKind: "none", motionAmountPpm: 0,
    fadeMs: 300, expectedRevision: 0, assetIds: [], selectedAssetId: "", selectedCandidateId: "",
  });
});

test("视觉段提交只允许一张已选候选并保留其他显式资产", () => {
  assert.deepEqual(visualSegmentPayload(HASH, {
    segmentIndex: 0, cueStartIndex: 0, cueEndIndex: 1, motionKind: "pan-left", motionAmountPpm: 12000,
    fadeMs: 300, expectedRevision: 3, assetIds: ["asset_a", "asset_b", "asset_a"],
    selectedAssetId: "asset_b", selectedCandidateId: "candidate_b",
  }).assets, [{ assetId: "asset_a" }, { assetId: "asset_b", selectedCandidateId: "candidate_b" }]);
  assert.throws(() => visualSegmentPayload(HASH, {
    segmentIndex: 0, cueStartIndex: 0, cueEndIndex: 0, motionKind: "none", motionAmountPpm: 0,
    fadeMs: 0, expectedRevision: 0, assetIds: ["asset_a"], selectedAssetId: "asset_a", selectedCandidateId: "",
  }), /已批准候选图/);
});

test("联系表仅在 8 至 15 个连续且可生产视觉段时允许导出", () => {
  const eight = Array.from({ length: 8 }, (_, index) => ({ ...segment(index), cueStartIndex: index, cueEndIndex: index }));
  assert.deepEqual(visualPlanStatus(8, eight), { continuous: true, productionReady: true, withinTargetCount: true });
  assert.equal(visualPlanStatus(8, eight.map((item, index) => index === 4 ? { ...item, productionReady: false } : item)).productionReady, false);
  assert.equal(visualPlanStatus(9, eight).continuous, false);
  assert.equal(visualPlanStatus(3, [segment(0), segment(1), segment(2)]).withinTargetCount, false);
});

test("冲突响应可刷新 expectedRevision 且不改草稿字段", () => {
  assert.equal(conflictRevision("视觉段已变化，请按 revision=12 重试"), 12);
  assert.equal(conflictRevision("字幕区间重叠"), undefined);
});
