# PC-02 前端参考逻辑来源

## 记录目的

本记录在 PC-02 抽取或改写参考逻辑前创建。参考顺序服从项目设计文档，不因本机仓库是否方便访问而改变。Narralume 只复用通用交互、状态归一化和恢复方法，不复制参考项目的业务限定，也不产生运行时依赖。

## 冻结优先级

1. DramaClaw：整体生产架构、分集工作区、阶段任务、任务中心和恢复。
2. Toonflow：章节按需取证、改编工作区、主/状态资产、候选图和显式关系。
3. LumenX：Series/Episode、系列共享资产、候选选择和人物变体。
4. LocalMiniDrama：持久化任务恢复展示、单项目包、TTS、字幕和生成历史。
5. MuseDock：模型调用、TTS 时间轴、音频检查、镜头数学和 FFmpeg；不是 PC-02 前端首选。

通用按钮、表单、对话框优先官方 `shadcn/ui`；只有项目已有控件或原生能力足够时才保持小闭包，不另造组件体系。

## 第一参考：DramaClaw

- 来源仓库：`dramaclaw/dramaclaw`
- 来源提交：`2864e72b3a717adbacfe09ded7b3ac6de2c2e28f`
- 本机审查方式：克隆到系统临时目录，只读比较，不进入 Narralume 提交或运行时。
- 许可证边界：以下均按 `reference-only` / `port` 重写行为，不直接复制源码。

| 来源文件 | 复用的方法 | Narralume 改造 |
| --- | --- | --- |
| `frontend/src/lib/episode-stage-registry.ts` | 单一阶段注册表绑定路由、任务类型、依赖和可用能力 | 改为 Narralume 七阶段，绑定现有 Job 类型和领域完成条件；不引入 DramaClaw 图标、类型或路由 |
| `frontend/src/components/layout/project-navigation-routes.ts` | 从 URL 派生项目区段，导航状态不另存第二份 | 使用原生查询参数保存 `book/series/stage/episode/job`，继续避免新增 Router 依赖 |
| `frontend/src/stores/episode-workbench-store.ts` | 对恢复地址和分集作用域做严格校验，坏本地状态回退 | 用小型纯函数和 URL 作为主恢复入口；不引入 Zustand，本地状态只保存服务端可复查的 Job ID |
| `frontend/src/task-center/provider.tsx` | hydrate-first、活动任务更新、轮询 fallback、卸载清理、旧终态不冒充新完成 | Narralume 当前无项目任务列表/SSE，改为按 Job ID 查询的 3 秒轮询；服务端 Job 是唯一事实源 |
| `frontend/src/task-center/use-task-subscribe.ts` | 回调用 ref 保持最新，终态不重复触发进度 | 改写为小型 React hook，防止旧请求覆盖新 Job，并在终态停止轮询 |
| `frontend/src/components/task-center/status-bar.tsx` | 当前任务、进度、连接/轮询健康和可展开详情的状态表达 | 收敛为工作区内 Job 状态条，显示中文 loading/成功/失败/取消、进度和下一步 |
| `frontend/src/components/task-center/task-actions.tsx` | 活动任务可取消，终态任务保留来源跳转 | 接通 `POST /api/jobs/:jobId/cancel`；来源跳转回对应 Narralume 阶段，不复制日志下载等非 MVP 功能 |

## 第二参考：Toonflow

- 来源仓库：`HBAI-Ltd/Toonflow-app`
- 来源提交：`bc61ec7a1b5df31293b286981a5f4ad4635464ee`
- 该快照未包含可维护的前端源码，只有编译产物；项目文档明确不复用编译后的前端，因此不从 `data/web` 反编译或复制 UI。

| 来源文件 | 复用的方法 | Narralume 改造 |
| --- | --- | --- |
| `src/routes/novel/getNovelIndex.ts`、`src/routes/novel/getNovelData.ts`、`src/routes/novel/event/getEvent.ts` | 章节索引与原文/事件按需读取 | 继续使用 Narralume 已有分页章节、原文切片和事件 API，不复制实现 |
| `src/routes/script/getScrptApi.ts`、`src/routes/script/updateScript.ts` | 改编产物与源章节分层，工作区按需查询 | 映射到 Narralume 故事弧、忠实稿、包装稿和不可变版本 API |
| `src/routes/assets/getAssetsApi.ts`、`src/routes/assets/pollingImageAssets.ts` | 资产列表、候选生成状态和批量工作区 | 映射到 Narralume 主/状态资产、候选审核与 Job，不采用内存 Promise 任务 |
| `src/routes/production/getFlowData.ts`、`src/routes/production/getStoryboardData.ts` | 列表和生产工作区读取同一业务数据 | Narralume 直接读取关系表 API，不维护重复工作区 JSON |

## 第三至第五参考的使用边界

- LumenX：PC-02 进入 Series/Episode 与共享资产选择时再冻结具体源文件；当前只沿用已落地的数据概念。
- LocalMiniDrama：PC-02 进入音频/字幕/生成历史恢复时再冻结具体源文件。
- MuseDock `3cf8d392436983e9fa93f9cdf7aa3186780cd5dd`：仅在前四级没有合适逻辑时参考通用任务显示；TTS、图片和 FFmpeg 继续按各自后续 Task 使用，不作为前端工作区骨架。

## 明确不复用

- 任一参考项目的完整运行时、业务对象、全局配置、路由体系、状态库、编译产物和产品文案。
- DramaClaw 的 Cognee、无限画布、AI 视频链；Toonflow 的内存 Promise 任务、无限画布、多层 Agent；MuseDock 的一键创作和 HTML 视频工作流。
- 任何 API Key、账号、本机模型配置或数据文件。

## PC-02 接线顺序

1. 以 DramaClaw 的阶段注册表/任务恢复方法为第一参考，建立七阶段导航和 Job 状态恢复。
2. 以 Toonflow 的按需取证/改编工作区方法为第二参考，接通章节事件、故事弧、稿件版本与批准。
3. 接通资产/候选图审核、TTS 时间轴、视觉段、分片和最终导出；到达具体能力时按冻结优先级继续审查来源。
4. 每一步以 Narralume 现有 API 为准；只有 UI 无法连续推进时才补最小后端查询或命令接口。
