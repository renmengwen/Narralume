# PC-02 前端参考逻辑来源

## 记录目的

本记录在 PC-02 抽取或改写参考逻辑前创建。Narralume 只复用通用交互、状态归一化和恢复方法，不复制参考项目的业务限定，也不产生运行时依赖。

## 来源基线

- 来源仓库：`D:\code3\MuseDock`
- 来源提交：`3cf8d392436983e9fa93f9cdf7aa3186780cd5dd`
- 来源分支（只作定位）：`dev`
- 使用方式：本机只读比较；Narralume 不 import、require、启动或读取 MuseDock 运行时代码。

## 文件与改造说明

| 来源文件 | 复用的方法 | Narralume 改造 |
| --- | --- | --- |
| `frontend-react/src/components/creative/CreativeWorkflowStepper.jsx` | 固定步骤的 done/active/failed/waiting 状态、`aria-current="step"` 和窄屏横向容器 | 改为 Narralume 七阶段；状态来自现有领域数据与 Job，不保留 MuseDock 十阶段名称和样式常量 |
| `frontend-react/src/components/creative/CreativeProgressPanel.jsx` | 当前阶段、总进度、失败信息和可展开详情的组织方式 | 改为 Narralume Job 的 `queued/running/succeeded/failed/cancelled`；不使用 MuseDock workflow/event 字段 |
| `frontend-react/src/components/creative/creativeProgress.js` | 进度钳制、终态归一化和有限事件列表方法 | 使用 Narralume Job `progress/result/error` 合同；只保留纯函数思想并改写为 TypeScript |
| `frontend-react/src/pages/oneClickCreative/creativeTaskStorage.js` | 活动任务的轻量恢复记录、无效本地值安全清理 | 以 `seriesId/episodeIndex/jobId` 为最小键；服务端 Job 仍是事实源，本地只保存导航恢复提示 |
| `frontend-react/src/pages/OneClickCreativePage.jsx` | 3 秒轮询、组件卸载取消、旧请求结果不得覆盖新任务、终态停止轮询 | 抽成小型 React hook；请求 Narralume `GET /api/jobs/:jobId`，不移植 SSE、重试计划和一键创作编排 |
| `frontend-react/src/components/creative-video-editor/ProjectStatusBar.jsx` | `aria-live` 状态条和“需要重新生产”的显式提示 | 改为每阶段中文 loading/成功/失败/中断与失效提示 |
| `frontend-react/src/api/client.js` | 集中 JSON 请求、保留服务端中文错误、统一取消入口 | 继续扩展 Narralume 已有 `responseJson`，不复制 MuseDock endpoint 或配置接口 |

## 明确不复用

- MuseDock 的创作 workflow、SSE 事件、HTML/CSS/GSAP 编辑器、重试计划和模型设置合同。
- MuseDock 的 React Router 页面结构、localStorage key、Tailwind 类名和产品文案。
- 任何 API Key、账号、本机模型配置或数据文件。

## PC-02 接线顺序

1. 先建立七阶段导航、Job 状态归一化与刷新恢复。
2. 接通章节事件、故事弧/分集、稿件版本与人工批准。
3. 接通资产/候选图审核、TTS 时间轴、视觉段、分片和最终导出。
4. 每一步以 Narralume 现有 API 为准；只有 UI 无法连续推进时才补最小后端查询或命令接口。
