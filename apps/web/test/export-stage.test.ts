import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ExportStage } from "../src/production/export/ExportStage.tsx";
import {
  exportArtifactUrl,
  exportReadinessUrl,
  exportWorkflowState,
  parseExportApiJob,
  parseExportReadiness,
  selectReadinessJob,
  type ExportReadiness,
} from "../src/production/export/export-logic.ts";
import type { JobRecord } from "../src/production/types.ts";
import { readinessOperationStatus, terminalJobForRefresh } from "../src/production/export/use-export-workspace.ts";

const timelineHash = "a".repeat(64);
const exportHash = "b".repeat(64);
const fileHash = "c".repeat(64);
const identity = { episodeId: "episode_1", timelineHash };

function readiness(patch: Partial<ExportReadiness> = {}): ExportReadiness {
  return {
    ...identity,
    productionReady: true,
    blockers: [],
    renderChunks: { ready: false, completed: 0, total: 2 },
    jobs: { renderChunks: null, finalVideo: null },
    finalExport: null,
    ...patch,
  };
}

function job(status: JobRecord["status"], type = "render_chunks"): JobRecord {
  return { id: "job_1", type, status, progress: 0.5, attempts: 1, maxAttempts: 3, cancelRequested: false, errorMessage: null, payload: identity };
}

test("服务端复核合同拒绝身份错配和自相矛盾的门禁", () => {
  const valid = { readiness: readiness({ productionReady: false, blockers: [{ code: "script", message: "包装稿尚未批准" }] }) };
  assert.equal(parseExportReadiness(valid, identity).blockers[0]?.message, "包装稿尚未批准");
  assert.throws(() => parseExportReadiness({ readiness: { ...valid.readiness, episodeId: "episode_2" } }, identity), /不属于当前分集/);
  assert.throws(() => parseExportReadiness({ readiness: { ...valid.readiness, productionReady: true } }, identity), /阻断清单不一致/);
  assert.throws(() => parseExportReadiness({ readiness: readiness({ renderChunks: { ready: true, completed: 1, total: 2 } }) }, identity), /分片复核计数不一致/);
});

test("无 URL Job 时从 readiness 恢复当前 running 任务", () => {
  const parsed = parseExportReadiness({ readiness: {
    ...readiness(),
    jobs: { renderChunks: { id: "render_running", type: "render_chunks", status: "running", progress: 0.4, errorMessage: null }, finalVideo: null },
  } }, identity);
  assert.equal(selectReadinessJob(parsed)?.id, "render_running");
  assert.equal(selectReadinessJob(parsed)?.status, "running");
});

test("URL Job 拒绝 foreign identity、坏状态和错误类型", () => {
  const valid = { job: job("running") };
  assert.equal(parseExportApiJob(valid, identity).id, "job_1");
  assert.throws(() => parseExportApiJob({ job: { ...valid.job, payload: { ...identity, episodeId: "episode_2" } } }, identity), /不属于当前分集/);
  assert.throws(() => parseExportApiJob({ job: { ...valid.job, status: "waiting" } }, identity), /任务摘要格式无效/);
  assert.throws(() => parseExportReadiness({ readiness: { ...readiness(), jobs: { renderChunks: { id: "bad", type: "final_video", status: "running", progress: 0, errorMessage: null }, finalVideo: null } } }, identity), /任务摘要格式无效/);
});

test("readiness 恢复当前阶段 terminal 失败任务并保留原因", () => {
  const parsed = parseExportReadiness({ readiness: {
    ...readiness(),
    jobs: { renderChunks: { id: "render_failed", type: "render_chunks", status: "failed", progress: 0.7, errorMessage: "FFmpeg 失败" }, finalVideo: null },
  } }, identity);
  const recovered = selectReadinessJob(parsed);
  assert.equal(recovered?.id, "render_failed");
  assert.deepEqual(readinessOperationStatus(parsed, recovered), { message: "渲染分片任务失败：FFmpeg 失败", error: "FFmpeg 失败" });
});

test("导出状态机严格执行分片到最终视频并支持中断或失败局部重试", () => {
  assert.equal(exportWorkflowState(readiness(), undefined, identity).action, "render");
  assert.equal(exportWorkflowState(readiness(), job("running"), identity).action, "cancel");
  assert.equal(exportWorkflowState(readiness(), job("cancelled"), identity).action, "retry");
  assert.equal(exportWorkflowState(readiness(), job("failed", "final_video"), identity).action, "render");
  assert.equal(exportWorkflowState(readiness({ renderChunks: { ready: true, completed: 2, total: 2 } }), job("succeeded"), identity).action, "finalize");
  assert.equal(exportWorkflowState(readiness({ renderChunks: { ready: true, completed: 2, total: 2 } }), job("failed", "final_video"), identity).action, "retry");
  assert.equal(exportWorkflowState(readiness({ renderChunks: { ready: true, completed: 2, total: 2 }, finalExport: { exportHash, fileHash, verified: true, bytes: 10, durationMs: 1000 } }), job("succeeded", "final_video"), identity).action, "download");
  assert.equal(exportWorkflowState(readiness(), { ...job("failed"), payload: { ...identity, episodeId: "old" } }, identity).action, "render");
});

test("无 readiness 或生产门禁未通过时禁止重试终态任务", () => {
  assert.equal(exportWorkflowState(undefined, job("failed"), identity).action, "refresh");
  const blocked = readiness({ productionReady: false, blockers: [{ code: "approval", message: "包装稿尚未批准" }] });
  assert.equal(exportWorkflowState(blocked, job("cancelled"), identity).action, "none");
});

test("分片未就绪时旧 final_video 失败不得越序重试", () => {
  assert.equal(exportWorkflowState(readiness(), job("failed", "final_video"), identity).action, "render");
});

test("已有 verified final 时下载优先于旧失败任务", () => {
  const verified = readiness({
    renderChunks: { ready: true, completed: 2, total: 2 },
    finalExport: { exportHash, fileHash, verified: true, bytes: 10, durationMs: 1000 },
  });
  assert.equal(exportWorkflowState(verified, job("failed", "render_chunks"), identity).action, "download");
  assert.equal(exportWorkflowState(verified, job("cancelled", "final_video"), identity).action, "download");
});

test("受控下载地址只由分集和哈希构造", () => {
  assert.equal(exportReadinessUrl("episode/1", timelineHash), `/api/episodes/episode%2F1/export-readiness?timelineHash=${timelineHash}`);
  assert.equal(exportArtifactUrl("episode/1", exportHash, "video"), `/api/episodes/episode%2F1/exports/${exportHash}/video`);
});

test("终态任务刷新 readiness 后仍保留失败原因或中断状态", () => {
  assert.deepEqual(readinessOperationStatus(readiness(), { ...job("failed"), errorMessage: "FFmpeg 合成失败" }), {
    message: "渲染分片任务失败：FFmpeg 合成失败",
    error: "FFmpeg 合成失败",
  });
  assert.deepEqual(readinessOperationStatus(readiness(), job("cancelled")), {
    message: "渲染分片任务已中断",
    error: undefined,
  });
});

test("手工重新复核只保留当前身份的 failed 或 cancelled Job", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const current = { ...job(status), errorMessage: status === "failed" ? "首次复核失败" : null };
    const terminal = terminalJobForRefresh(current, identity);
    assert.equal(terminal, current);
    const operation = readinessOperationStatus(readiness(), terminal);
    assert.equal(operation.message, status === "failed" ? "渲染分片任务失败：首次复核失败" : "渲染分片任务已中断");
  }
  assert.equal(terminalJobForRefresh({ ...job("failed"), payload: { ...identity, episodeId: "episode_2" } }, identity), undefined);
  assert.equal(terminalJobForRefresh(job("succeeded"), identity), undefined);
});

test("独立导出页保留单主操作、44px 控件和明确禁用的项目包入口", () => {
  const html = renderToString(createElement(ExportStage, identity));
  assert.match(html, /审核与导出/);
  assert.match(html, /这里不会批准任何上游产物/);
  assert.match(html, /min-h-11/);
  assert.match(html, /创建服务端项目包（尚未接线）/);
  assert.match(html, /disabled=""/);
  assert.equal((html.match(/bg-\[var\(--accent\)\]/g) ?? []).length, 1);
});
