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

## 第一原则：先参考，再实现

资产管理、生图提示词和候选审核与工作区导航同等适用冻结优先级。进入任何具体能力前，必须先检查优先级更高的参考项目并登记来源文件，然后明确选择 `copy`、`port` 或 `reference-only`；只有确认参考项目不存在适合 Narralume 现有合同的最小闭包时，才允许新写最小实现。

该原则具体要求：

- 不把“前端页面已能展示”当成资产闭环；主资产、状态资产、别名、候选图、审核事件和视觉段绑定必须使用 Narralume 已有同源关系。
- 不把旁白原文、资产名称或一段自由文本直接拼成最终生图 prompt；提示词必须能追溯到原文事实、资产身份、场景意图、画幅和风格约束。
- 候选图只追加、不覆盖；已花费生成的候选必须进入审核、显式选择或淘汰路径，不能生成后成为无人消费的孤儿。
- 引用图和文字 prompt 是两类输入：界面可显示可读的资产标记，但模型调用时应把引用图作为独立参数传递，不把标记文本冒充视觉参考。
- 通用交互优先官方 `shadcn/ui`；参考项目提供业务行为和状态模型，不成为 Narralume 的组件运行时依赖。

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
| `src/routes/assets/saveAssets.ts` | 上传图和生成图都必须经过显式保存/选择动作 | 映射到 Narralume 候选上传、审核事件和视觉段候选绑定；不采用单个 `imageId` 覆盖历史候选 |
| `src/routes/assetsGenerate/generateAssets.ts` | 按角色/场景/道具组合画风、名称、资产描述，先写“生成中”再产图 | 仅 `port` 类型化 prompt assembly 与任务状态方法；不复用固定 16:9、单图覆盖和原始字段结构 |
| `src/utils/getPrompts.ts` | 提示词按任务类别集中管理，而非散落在事件处理器 | Narralume 将生图 prompt 的事实、资产、构图/光线、画幅和风格约束分段组装；不复制 Toonflow 的具体业务提示词 |
| `src/routes/production/getFlowData.ts`、`src/routes/production/getStoryboardData.ts` | 列表和生产工作区读取同一业务数据 | Narralume 直接读取关系表 API，不维护重复工作区 JSON |

## 第三参考：LumenX

- 来源仓库：`alibaba/lumenx`
- 来源提交：`7a1213a0db73ab90ca976f5c4b4ca680e1ae1d2d`
- 许可证：MIT；本轮仍以 `reference-only` / `port` 为主，不直接搬入其 Next.js、状态库或产品样式。

| 来源文件 | 复用的方法 | Narralume 改造 |
| --- | --- | --- |
| `frontend/src/components/common/AssetCard.tsx`、`frontend/src/components/library/AssetLibraryPage.tsx` | 明示系列共享来源；按资产类型/来源分组；搜索、星标、最近更新与 Inspector 共享单一数据源 | Narralume 只显示当前系列的主/状态资产树和别名，资产、候选与审核均直接读取现有 API；不另建前端影子资产库 |
| `frontend/src/components/library/AssetInspector.tsx` | `variants + selected_id`、变体 prompt/元数据、生成更多变体、轮询完成后按资产 ID 防止旧结果污染新选中项 | 映射为 append-only `asset_candidates`、审核 revision 和视觉段 `selected_candidate_id`；活动 Job 由服务端恢复，前端不虚构 selected 状态 |
| `frontend/src/components/modules/storyboard-r2v/shot-panel/CandidatesSection.tsx`、`CandidateThumb.tsx` | 候选按生成批次累积，保留旧批次；星标、标签、对比、取消/重试和显式 active | Narralume 首版复用“累积 + 审核 + 显式绑定”闭环；不靠时间窗口猜批次，优先使用已有 Job/request identity |
| `frontend/src/components/modules/PromptBuilder.tsx`、`AssetChipBar.tsx` | 资产引用与镜头字段使用结构化 segment/chip，不把所有信息压成不可编辑长字符串 | 映射到稳定 `assetId` 的资产引用；名称/别名只用于显示，提交时仍携带真实资产身份 |
| `frontend/src/components/modules/storyboard-r2v/buildAssembledPrompt.ts`、`src/apps/comic_gen/prompt_assembly.py` | 最终 prompt 按视觉叙事、光线、运镜、景别/机位、角色外观、约束组装；引用标签从文字 prompt 中剥离后单独传引用图 | Narralume 以纯函数组装并测试；原文事实和批准稿是输入，模型 prompt 不直接等于旁白，不复制 R2V 的 `characterN` 协议 |
| `frontend/src/components/series/SeriesPromptConfigModal.tsx` | 系列级 prompt 配置与系统默认分层，加载/保存有明确状态 | Narralume 后续若补系列风格配置，必须保持默认模板与系列覆写分离；PC-02 不先造一套全局 prompt 配置中心 |

## 第四至第五参考的使用边界

- LocalMiniDrama：PC-02 进入音频/字幕/生成历史恢复时再冻结具体源文件。
- MuseDock `3cf8d392436983e9fa93f9cdf7aa3186780cd5dd`：仅补前四级没有提供的已验证模型调用和消费门禁。`server/services/creative/generatedImagePlanner.js` 用于参考“只为来源素材未覆盖的场景生图”、合法场景 ID、配额与去重、严格 JSON、旁白不可直接当 prompt；`server/services/ai/aiImageModel.js` 继续只作为已登记的 provider 合同来源。Narralume 不复制 MuseDock 的一键创作/HTML 视频链。

## Narralume 资产与提示词映射决定

- `assets` 是语义身份：已有 `master/state`、`parent_asset_id`、`state_label` 和系列内别名继续作为唯一资产事实源。
- `asset_candidates` 是 append-only 变体：上传/生成来源、request/prompt hash、模型、尺寸、文件身份与 review revision 已有持久合同，不新增覆盖式 `imageId`。
- `visual_segment_assets.selected_candidate_id + candidate_review_revision` 是显式消费关系：只有已批准候选可进入联系表和渲染；资产卡上的“当前图”不得绕过该关系自行保存。
- PC-02 prompt UI 首先复用现有 `image_candidate_generate` Job；在确认 Job payload/checkpoint 是否足以恢复可编辑 prompt 前，不新增 prompt 表。若现有合同只保留 hash、无法满足版本/派生/审核恢复，再以独立最小 Task 补持久化，而不是把 prompt 藏在前端状态。
- 生图请求组装顺序固定为：原文/批准稿事实 → 场景意图 → 稳定资产引用及状态 → 主体动作与环境 → 光线/构图 → 9:16 画幅 → 系列风格与负面约束。生成计划按场景与请求身份去重，retry 必须保留资产语义。

## 明确不复用

- 任一参考项目的完整运行时、业务对象、全局配置、路由体系、状态库、编译产物和产品文案。
- DramaClaw 的 Cognee、无限画布、AI 视频链；Toonflow 的内存 Promise 任务、无限画布、多层 Agent；MuseDock 的一键创作和 HTML 视频工作流。
- 任何 API Key、账号、本机模型配置或数据文件。

## PC-02 接线顺序

1. 以 DramaClaw 的阶段注册表/任务恢复方法为第一参考，建立七阶段导航和 Job 状态恢复。
2. 以 Toonflow 的按需取证/改编工作区方法为第二参考，接通章节事件、故事弧、稿件版本与批准。
3. 以 Toonflow 的主/状态资产关系和 LumenX 的变体/候选/显式 active 方法接通资产、候选审核与生图 prompt；复用 Narralume 已有 append-only candidate、review revision 和视觉段绑定合同。
4. 接通 TTS 时间轴、视觉段、分片和最终导出；到达具体能力时按冻结优先级继续审查来源。
5. 每一步以 Narralume 现有 API 为准；只有 UI 无法连续推进时才补最小后端查询或命令接口。
