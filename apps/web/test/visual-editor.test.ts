import assert from "node:assert/strict";
import test from "node:test";

import type { TtsTimeline } from "../src/production/types.ts";
import { conflictRevision, nextVisualDraft, visualDraft, visualPlanStatus, visualSegmentPayload } from "../src/production/visual/visual-editor.ts";
import type { VisualSegment } from "../src/production/visual/types.ts";

const HASH = "a".repeat(64);
const timeline = { timelineHash: HASH, durationMs: 3000, cues: [0, 1, 2].map((index) => ({ index, segmentIndex: index, startMs: index * 1000, endMs: (index + 1) * 1000, text: `cue ${index}` })) } as TtsTimeline;
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

test("视觉计划不再用 8 至 15 个固定段数做导出门禁", () => {
  const three = [segment(0), segment(1), segment(2)];
  assert.equal(visualPlanStatus(timeline, three).productionReady, true);
  assert.equal(visualPlanStatus(timeline, three.map((item, index) => index === 1 ? { ...item, productionReady: false } : item)).productionReady, false);
  assert.equal(visualPlanStatus({ ...timeline, cues: [...timeline.cues, { index: 3, segmentIndex: 3, startMs: 3000, endMs: 4000, text: "cue 3" }] }, three).continuous, false);

  const longTimeline = { ...timeline, durationMs: 90000, cues: Array.from({ length: 18 }, (_, index) => ({ index, segmentIndex: index, startMs: index * 3750, endMs: (index + 1) * 3750, text: `cue ${index}` })) } as TtsTimeline;
  const eighteen = Array.from({ length: 18 }, (_, index) => ({ ...segment(index), startMs: index * 3750, endMs: (index + 1) * 3750 }));
  const longStatus = visualPlanStatus(longTimeline, eighteen);
  assert.equal(longStatus.productionReady, true);
  assert.equal(longStatus.suggestion.targetCount, 18);
  assert.equal(longStatus.suggestion.openingMin, 3);
  assert.equal(longStatus.suggestion.openingMax, 4);
});

test("冲突响应可刷新 expectedRevision 且不改草稿字段", () => {
  assert.equal(conflictRevision("视觉段已变化，请按 revision=12 重试"), 12);
  assert.equal(conflictRevision("字幕区间重叠"), undefined);
});
