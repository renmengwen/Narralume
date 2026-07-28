import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ChapterEventsStage } from "../src/production/ChapterEventsStage.tsx";
import { PipelineSetup } from "../src/production/pipeline/PipelineSetup.tsx";
import { PipelineProgress } from "../src/production/pipeline/PipelineProgress.tsx";
import {
  formatPipelineDuration,
  pipelineChapterEventsReadOnly,
  pipelineCreateInput,
  pipelineRangeCount,
  pipelineStatusPresentation,
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
    chapterBatchSize: 10,
    chapterConcurrency: 8,
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

test("全本设置只接受连续范围、成片规格和安全的分析批次", () => {
  const input = { episodeCount: 10, targetDurationSeconds: 1200, chapterBatchSize: 10, chapterConcurrency: 8, sourceStartChapterId: "chapter_1", sourceEndChapterId: "chapter_3" };
  assert.deepEqual(pipelineCreateInput(input, chapters, policy), input);
  assert.equal(pipelineRangeCount(chapters, "chapter_1", "chapter_3"), 3);
  assert.throws(() => pipelineCreateInput({ ...input, sourceStartChapterId: "chapter_3", sourceEndChapterId: "chapter_1" }, chapters, policy), /顺序正确/);
  assert.throws(() => pipelineCreateInput({ ...input, episodeCount: 0 }, chapters, policy), /1～1000/);
  assert.throws(() => pipelineCreateInput({ ...input, targetDurationSeconds: 61 }, chapters, policy), /30 秒递增/);
  assert.throws(() => pipelineCreateInput({ ...input, chapterBatchSize: 21 }, chapters, policy), /1～20/);
  assert.throws(() => pipelineCreateInput({ ...input, chapterConcurrency: 9 }, chapters, policy), /1～8/);
});

test("全本设置展示默认批次、并发和输入安全说明", () => {
  const html = renderToString(createElement(PipelineSetup, {
    chapters,
    chapterTotal: chapters.length,
    policy,
    loading: false,
    submitting: false,
    operation: "设置已就绪",
    onCreate: () => undefined,
  }));
  assert.match(html, /每批最多章节数/);
  assert.match(html, /value="10"/);
  assert.match(html, /实际批次会按输入安全上限自动缩小/);
  assert.match(html, /并发批次数/);
  assert.match(html, /value="8"/);
  assert.match(html, /并发越高越可能触发供应商限流/);
  assert.match(html, /min-h-11/);
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

test("运行页如实展示后端冻结的旧任务单批单并发设置", () => {
  const html = renderToString(createElement(PipelineProgress, {
    run: run({ chapterBatchSize: 1, chapterConcurrency: 1 }),
    chapters,
    operation: "已恢复全本改写任务。",
    onControl: () => undefined,
    onReset: () => undefined,
  }));
  assert.match(html, /本次全本改写冻结设置/);
  assert.match(html, /每批最多章节/);
  assert.match(html, />1章</);
  assert.match(html, /并发批次/);
  assert.match(html, />1批</);
  assert.doesNotMatch(html, />10章|>8批/);
});

test("覆盖检查保持处理中语义，自动生产完成后明确等待逐集审核", () => {
  const completeProgress = {
    chapterAnalysis: { completed: 3, total: 3, reused: 0, queued: 0, running: 0, failed: 0 },
    storyBible: { completed: 1, total: 1 },
    episodePlan: { completed: 3, total: 3 },
    scripts: { completed: 6, total: 6 },
  };
  const checking = run({ status: "checking_coverage", current: null, episodeCount: 3, progress: completeProgress });
  assert.equal(pipelineStatusPresentation(checking.status).heading, "固定流水线正在处理全书");
  assert.equal(pipelineStatusText(checking), "正在生成并检查全本稿件。");
  const checkingHtml = renderToString(createElement(PipelineProgress, {
    run: checking, chapters, operation: "正在检查稿件覆盖。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(checkingHtml, /固定流水线正在处理全书/);
  assert.match(checkingHtml, /状态：<!-- -->检查覆盖/);
  assert.match(checkingHtml, /当前阶段；单次模型请求不显示虚构百分比/);

  const awaiting = run({
    status: "awaiting_review", current: null, episodeCount: 3, progress: completeProgress,
    actions: { canPause: false, canResume: false, canCancel: false, canRetry: false },
  });
  assert.equal(pipelineStatusText(awaiting), "自动生产完成，等待逐集审核。");
  const awaitingHtml = renderToString(createElement(PipelineProgress, {
    run: awaiting, chapters, operation: "已恢复全本改写任务。", onControl: () => undefined, onReset: () => undefined,
  }));
  assert.match(awaitingHtml, /自动生产完成，等待逐集审核/);
  assert.match(awaitingHtml, /状态：<!-- -->等待审核/);
  assert.match(awaitingHtml, /自动生产已完成，等待逐集审核/);
  assert.doesNotMatch(awaitingHtml, /固定流水线正在处理全书|暂停后续任务|取消全本改写/);
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
