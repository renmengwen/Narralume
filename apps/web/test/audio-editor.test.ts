import assert from "node:assert/strict";
import test from "node:test";

import { mergeProductionWorkspaceLocation, productionWorkspaceFromSearch, productionWorkspacePath, usesChapterWorkspaceStatus } from "../src/production-logic.ts";
import { completedTtsTimelineHash } from "../src/production/audio/audio-editor.ts";

test("语音时间轴 URL 只恢复 64 位小写 sha256", () => {
  const hash = "a".repeat(64);
  const path = productionWorkspacePath({ bookId: "book_1", seriesId: "series_1", stage: "audio", episodeIndex: 2, timelineHash: hash });
  assert.equal(productionWorkspaceFromSearch(path)?.timelineHash, hash);
  assert.equal(productionWorkspaceFromSearch(`${path.slice(0, -1)}A`)?.timelineHash, undefined);
  assert.equal(mergeProductionWorkspaceLocation({ stage: "audio", timelineHash: hash }, { timelineHash: undefined }).timelineHash, undefined);
});

test("语音任务结果必须匹配类型、终态、分集与时间轴身份", () => {
  const hash = "b".repeat(64);
  const job = { id: "job_1", type: "tts_timeline", status: "succeeded" as const, progress: 1, attempts: 1,
    maxAttempts: 3, cancelRequested: false, errorMessage: null, result: { episodeId: "episode_1", timelineHash: hash } };
  assert.equal(completedTtsTimelineHash(job, "episode_1"), hash);
  assert.equal(completedTtsTimelineHash({ ...job, status: "running" }, "episode_1"), undefined);
  assert.equal(completedTtsTimelineHash(job, "episode_2"), undefined);
  assert.equal(completedTtsTimelineHash({ ...job, result: { episodeId: "episode_1", timelineHash: "bad" } }, "episode_1"), undefined);
});

test("章节后台恢复只允许覆盖依赖章节的阶段文案", () => {
  assert.equal(usesChapterWorkspaceStatus("events"), true);
  assert.equal(usesChapterWorkspaceStatus("episode"), true);
  assert.equal(usesChapterWorkspaceStatus("audio"), false);
  assert.equal(usesChapterWorkspaceStatus("scripts"), false);
});
