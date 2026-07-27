import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ChapterEventsStage } from "../src/production/ChapterEventsStage.tsx";
import { PipelineProgress } from "../src/production/pipeline/PipelineProgress.tsx";
import {
  formatPipelineDuration,
  pipelineChapterEventsReadOnly,
  pipelineCreateInput,
  pipelineRangeCount,
  pipelineStatusText,
  type SeriesPipelineRun,
} from "../src/production/pipeline/pipeline-logic.ts";
import { readInitialRun } from "../src/production/pipeline/use-series-pipeline.ts";
import type { Chapter } from "../src/production/types.ts";

const chapters: Chapter[] = Array.from({ length: 3 }, (_, index) => ({
  id: `chapter_${index + 1}`,
  title: `第${index + 1}章`,
  chapter_index: index,
  char_count: 100,
  byte_start: index * 100,
  byte_end: (index + 1) * 100,
}));
const policy = { minimumSeconds: 60, defaultSeconds: 1200, maximumSeconds: 3600, stepSeconds: 30 };

function run(change: Partial<SeriesPipelineRun> = {}): SeriesPipelineRun {
  return {
    id: "pipeline_1",
    seriesProjectId: "series_1",
    status: "analyzing_chapters",
    resumeStatus: null,
    episodeCount: 10,
    targetDurationSeconds: 1200,
    sourceStartChapterId: "chapter_1",
    sourceEndChapterId: "chapter_3",
    failureCode: null,
    failureMessage: null,
    progress: {
      chapterAnalysis: { completed: 1, total: 3, reused: 1, queued: 1, running: 1, failed: 0 },
      storyBible: { completed: 0, total: 1 },
      episodePlan: { completed: 0, total: 10 },
      scripts: { completed: 0, total: 20 },
    },
    current: { stage: "chapter_analysis", subjectType: "chapter", subjectId: "chapter_2", jobId: "job_2" },
    failures: [],
    actions: { canPause: true, canResume: false, canCancel: true, canRetry: false },
    ...change,
  };
}

test("全本设置只接受连续范围、明确总集数和服务端时长策略", () => {
  const input = { episodeCount: 10, targetDurationSeconds: 1200, sourceStartChapterId: "chapter_1", sourceEndChapterId: "chapter_3" };
  assert.deepEqual(pipelineCreateInput(input, chapters, policy), input);
  assert.equal(pipelineRangeCount(chapters, "chapter_1", "chapter_3"), 3);
  assert.throws(() => pipelineCreateInput({ ...input, sourceStartChapterId: "chapter_3", sourceEndChapterId: "chapter_1" }, chapters, policy), /顺序正确/);
  assert.throws(() => pipelineCreateInput({ ...input, episodeCount: 0 }, chapters, policy), /1～1000/);
  assert.throws(() => pipelineCreateInput({ ...input, targetDurationSeconds: 61 }, chapters, policy), /30 秒递增/);
});

test("总目标时长只由用户集数和单集秒数计算", () => {
  assert.equal(formatPipelineDuration(10 * 1200), "3 小时 20 分钟");
  assert.equal(formatPipelineDuration(0), "待填写");
});

test("运行中章节事件只读，暂停后恢复人工修复", () => {
  assert.equal(pipelineChapterEventsReadOnly(run()), true);
  assert.equal(pipelineChapterEventsReadOnly(run({ status: "paused" })), false);
  assert.equal(pipelineStatusText(run({ status: "paused", current: null })), "任务已暂停。已完成结果已保留。");
  assert.equal(pipelineStatusText(run({ status: "cancelled", current: null })), "任务已取消。已完成章节事件已保留。");
});

test("URL 中跨系列 runId 不会被采用并回退当前系列 run", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "/api/pipeline-runs/pipeline_foreign") {
      return Response.json({ run: run({ id: "pipeline_foreign", seriesProjectId: "series_other" }) });
    }
    if (url === "/api/series/series_1/pipeline-runs/current") {
      return Response.json({ run: run({ id: "pipeline_current", seriesProjectId: "series_1" }) });
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  };
  try {
    const restored = await readInitialRun("series_1", "pipeline_foreign", new AbortController().signal);
    assert.equal(restored?.id, "pipeline_current");
    assert.equal(restored?.seriesProjectId, "series_1");
    assert.deepEqual(requests, [
      "/api/pipeline-runs/pipeline_foreign",
      "/api/series/series_1/pipeline-runs/current",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("全本进度渲染真实数量和当前章节，不伪造百分比", () => {
  const html = renderToString(createElement(PipelineProgress, {
    run: run(), chapters, operation: "已恢复全本改写任务。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(html, /1\/3/);
  assert.match(html, /复用 1/);
  assert.match(html, /第 2 章/);
  assert.match(html, /job_2/);
  assert.doesNotMatch(html, /<progress|%/);
  assert.match(html, /min-h-11/);
});

test("流水线只读不会锁死章节浏览，但会禁用事件写操作", () => {
  const html = renderToString(createElement(ChapterEventsStage, {
    chapters,
    total: chapters.length,
    selected: chapters[0],
    text: "原文",
    events: [],
    locked: false,
    readOnly: true,
    onSelect: () => undefined,
    onSave: () => undefined,
    onAnalyze: () => undefined,
  }));
  assert.match(html, /全本流水线运行期间章节事件只读/);
  assert.match(html, /自动分析本章<\/button>/);
  const chapterSection = html.match(/<section[^>]*aria-labelledby="production-chapters-heading"[^]*?<\/section>/)?.[0] ?? "";
  assert.match(chapterSection, /<button/);
  assert.doesNotMatch(chapterSection, /<button[^>]*disabled/);
});
