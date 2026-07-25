# 源码来源记录

从外部项目复制或移植代码前，在此记录来源。只参考设计、不复制代码时也可以记录为 `reference-only`。

| 日期       | 类型           | 来源仓库                      | 来源提交                                   | 来源文件                     | Narralume 文件           | 修改说明                 |
| ---------- | -------------- | ----------------------------- | ------------------------------------------ | ---------------------------- | ------------------------ | ------------------------ |
| 2026-07-24 | reference-only | `dramaclaw/dramaclaw`         | `2864e72b3a717adbacfe09ded7b3ac6de2c2e28f` | 小说摄入、章节检测、任务系统 | `docs/project-design.md` | 仅吸收设计，未复制源码   |
| 2026-07-24 | reference-only | `HBAI-Ltd/Toonflow-app`       | `bc61ec7a1b5df31293b286981a5f4ad4635464ee` | 章节、改编工作区、资产关系   | `docs/project-design.md` | 仅吸收设计，未复制源码   |
| 2026-07-24 | reference-only | `alibaba/lumenx`              | `7a1213a0db73ab90ca976f5c4b4ca680e1ae1d2d` | Series/Episode、共享资产     | `docs/project-design.md` | 仅吸收设计，未复制源码   |
| 2026-07-24 | reference-only | `xuanyustudio/LocalMiniDrama` | `b695284b8288e392a4ce2a63717406f3830966af` | SQLite、TTS、字幕、FFmpeg    | `docs/project-design.md` | 仅吸收设计，未复制源码   |
| 2026-07-24 | reference-only | `renmengwen/MuseDock`         | 待抽取时冻结                               | TTS、图片、镜头数学、FFmpeg  | 待定                     | 仅登记候选，尚未复制源码 |
| 2026-07-24 | reference-only | `renmengwen/MuseDock`         | `de629e0212770e15c8165b5495454ca0b7dd8fd9` | `docs/superpowers/specs/2026-07-16-asset-first-agent-loop-design.md`；`docs/superpowers/plans/2026-07-16-asset-first-delivery-ledger.md`；`docs/superpowers/plans/2026-07-16-unified-visual-assets-implementation.md` | `AGENTS.md`；`docs/README.md`；`docs/loop/phase-1-7-implementation.md`；`docs/loop/phase-1-7-delivery-ledger.md` | 仅移植控制、冻结、双审查、验证和恢复方法；未复制业务代码或建立运行时依赖 |
| 2026-07-24 | copied-tooling | `manalkaff/opendesign` | `cecd9bb6b59408cb96a3974449b8e6ef9f5b17bb` | `skills/opendesign/viewer.html` | `opendesign/index.html` | 复制 OpenDesign 静态查看器作为仓库内设计评审工具；不进入 Narralume 产品运行时，产品设计规范与 mockup 均为本项目新建 |
| 2026-07-24 | verification-input | `Project Gutenberg` | eBook `#24264`，SHA-256 `ff1526996bf4b81807651921a85e5c1c0f1d1d123c9fa4553057ba6a3ec72011` | `https://www.gutenberg.org/cache/epub/24264/pg24264.txt`（《红楼梦》） | `apps/server/src/gates/phase1-large-text-gate.ts` | 公版真实长篇 TXT 仅下载到系统临时目录，用于 Phase 1 大文本门禁；不提交原文，不作为产品运行时依赖 |

## Phase 5 图片候选参考来源

| 日期 | 类型 | 来源仓库 | 来源提交 | 来源文件 | Narralume 文件 | 修改说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-25 | adapted-contract | `renmengwen/MuseDock` | `3cf8d392436983e9fa93f9cdf7aa3186780cd5dd` | `server/services/ai/aiImageModel.js`、`server/services/ai/aiModelConfig.js`、`server/services/source/sourceAssets.js` | `apps/server/src/image-provider.ts`、`apps/server/src/asset-candidate-store.ts`、`apps/server/src/gates/p5-image-candidates-gate.ts` | 参考已验证的 OpenAI 兼容生图合同、配置选择和外部图片下载边界，以 TypeScript 在 Narralume 内独立实现；正式运行时只读取 Narralume 自有注入或环境变量。真实 gate 只读 MuseDock 本机配置到内存，不复制业务限定，不持久化或输出密钥、地址、签名 URL，也不建立运行时依赖。 |
| 2026-07-25 | reference-only / port | `dramaclaw/dramaclaw` | `2864e72b3a717adbacfe09ded7b3ac6de2c2e28f` | `frontend/src/lib/episode-stage-registry.ts`、`frontend/src/components/layout/project-navigation-routes.ts`、`frontend/src/stores/episode-workbench-store.ts`、`frontend/src/task-center/provider.tsx`、`frontend/src/task-center/use-task-subscribe.ts`、`frontend/src/components/task-center/status-bar.tsx`、`frontend/src/components/task-center/task-actions.tsx` | `docs/reuse/pc-02-frontend-reference-sources.md`；PC-02 后续 web 文件 | 第一优先参考固定分集阶段、URL/作用域恢复、hydrate-first、轮询 fallback、任务进度和取消交互；按 Narralume 七阶段与现有 Job 合同重写，不复制许可证源码或引入其状态/路由依赖。 |
| 2026-07-25 | reference-only | `HBAI-Ltd/Toonflow-app` | `bc61ec7a1b5df31293b286981a5f4ad4635464ee` | `src/routes/novel/getNovelIndex.ts`、`src/routes/novel/getNovelData.ts`、`src/routes/novel/event/getEvent.ts`、`src/routes/script/getScrptApi.ts`、`src/routes/script/updateScript.ts`、`src/routes/assets/getAssetsApi.ts`、`src/routes/assets/pollingImageAssets.ts`、`src/routes/production/getFlowData.ts`、`src/routes/production/getStoryboardData.ts` | `docs/reuse/pc-02-frontend-reference-sources.md`；PC-02 后续 web 文件 | 第二优先参考章节按需取证、分层改编、资产候选和列表/工作区同源；冻结快照只有编译前端产物，按文档明确不反编译或复制 `data/web`，只映射到 Narralume 已有 API。 |
| 2026-07-25 | reference-only / port | `HBAI-Ltd/Toonflow-app` | `bc61ec7a1b5df31293b286981a5f4ad4635464ee` | `src/routes/assets/saveAssets.ts`、`src/routes/assetsGenerate/generateAssets.ts`、`src/utils/getPrompts.ts` | `docs/reuse/pc-02-frontend-reference-sources.md`；PC-02 后续资产/prompt 文件 | 参考主/子资产、生成占位状态、类型化 prompt 组装和显式保存动作；不复制固定 16:9、单 `imageId` 覆盖、内存任务或具体业务提示词，改用 Narralume append-only candidates/review/visual binding。 |
| 2026-07-25 | reference-only / port | `alibaba/lumenx` | `7a1213a0db73ab90ca976f5c4b4ca680e1ae1d2d` | `frontend/src/components/common/AssetCard.tsx`、`frontend/src/components/library/AssetLibraryPage.tsx`、`frontend/src/components/library/AssetInspector.tsx`、`frontend/src/components/modules/PromptBuilder.tsx`、`frontend/src/components/modules/storyboard-r2v/AssetChipBar.tsx`、`frontend/src/components/modules/storyboard-r2v/buildAssembledPrompt.ts`、`frontend/src/components/modules/storyboard-r2v/shot-panel/CandidatesSection.tsx`、`frontend/src/components/modules/storyboard-r2v/shot-panel/CandidateThumb.tsx`、`frontend/src/components/series/SeriesPromptConfigModal.tsx`、`src/apps/comic_gen/prompt_assembly.py` | `docs/reuse/pc-02-frontend-reference-sources.md`；PC-02 后续资产/prompt 文件 | 参考系列共享来源、变体/选中、Inspector、候选批次累积与显式 active、结构化资产 chip 和纯 prompt assembly；按 Narralume 已有 master/state/alias/candidate/review/visual relation 改写，不引入 Next.js/状态库/样式。 |
| 2026-07-25 | reference-only | `renmengwen/MuseDock` | `3cf8d392436983e9fa93f9cdf7aa3186780cd5dd` | `server/services/creative/generatedImagePlanner.js`、`server/services/ai/aiImageModel.js` | `docs/reuse/pc-02-frontend-reference-sources.md`；PC-02/PC-04 后续 prompt 规划文件 | 第五优先只补已验证 provider 合同与规划门禁：来源未覆盖才生图、场景 ID/配额/去重、严格 JSON、旁白不能直接当 prompt、画幅感知；不复制一键创作或 HTML 视频业务链。 |

## PC-02 自动章节分析参考来源

| 日期 | 类型 | 来源仓库 | 来源提交 | 来源文件 | Narralume 文件 | 修改说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-25 | reference-only | `dramaclaw/dramaclaw` | `2864e72b3a717adbacfe09ded7b3ac6de2c2e28f` | `src/novelvideo/cognee/event_extractor.py`、`pipeline.py`、`task_backend/runners/graph_build.py` | `apps/server/src/chapter-event-analyzer.ts`、`apps/server/src/chapter-events-job.ts` | 第一优先参考事件提取和批处理流程；不复制 `str.find()` 弱定位、定位失败退整章或静默截断。 |
| 2026-07-25 | reference-only | `HBAI-Ltd/Toonflow-app` | `bc61ec7a1b5df31293b286981a5f4ad4635464ee` | `generateEvents.ts`、`cleanNovel.ts`、`getEvent.ts`、`getNovelEventState.ts` | `apps/server/src/chapter-events-job.ts`、`apps/web/src/production/ChapterEventsStage.tsx` | 第二优先参考批量入口和中文任务状态；不复制进程内 Promise 或字符串证据。 |
| 2026-07-25 | reference-only | `alibaba/lumenx` | `7a1213a0db73ab90ca976f5c4b4ca680e1ae1d2d` | 无适用章节 analyzer | 无 | 第三优先已核对，没有适配 Narralume 六类事件和字节证据合同的实现。 |
| 2026-07-25 | reference-only | `xuanyustudio/LocalMiniDrama` | `b695284b8288e392a4ce2a63717406f3830966af` | `propExtractionService.js`、`backgroundExtractionService.js`、`storyGenerationService.js`、`taskService.js` | `apps/server/src/chapter-event-analyzer.ts`、`apps/web/src/production/ChapterEventsStage.tsx` | 第四优先参考 JSON 归一化和中文状态；不复制弱恢复或独立任务体系。 |
| 2026-07-25 | port | `renmengwen/MuseDock` | `3cf8d392436983e9fa93f9cdf7aa3186780cd5dd` | `server/services/ai/aiTextModel.js`、`server/services/ai/aiModelConfig.js`、`server/services/creative/generatedImagePlanner.js` | `apps/server/src/chapter-event-analyzer.ts` | 第五优先只移植已验证的 OpenAI Responses 最小文本合同、严格 JSON、超时和脱敏边界；Narralume 独立实现，真实 gate 只读本机配置到内存，不复制密钥或建立运行时依赖。 |

## PC-02 稿件与批准前端接线参考来源

| 日期 | 类型 | 来源仓库 | 来源提交 | 来源文件/能力 | Narralume 文件 | 修改说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-25 | reference-only | `dramaclaw/dramaclaw` | `2864e72b3a717adbacfe09ded7b3ac6de2c2e28f` | `script_writing`、`literal_script_writing`、task runner、episode source editor、scripts query | `apps/web/src/production/scripts/` | 仅参考忠实稿/包装稿分层、来源编辑和任务状态交互；稿件版本与批准完全复用 Narralume 现有 API。 |
| 2026-07-25 | reference-only | `HBAI-Ltd/Toonflow-app` | `bc61ec7a1b5df31293b286981a5f4ad4635464ee` | script GET/UPDATE/ADD、plan data | `apps/web/src/production/scripts/` | 仅参考稿件读取、编辑和追加版本交互；不复制可变覆盖存储。 |
| 2026-07-25 | reference-only | `alibaba/lumenx` | `7a1213a0db73ab90ca976f5c4b4ca680e1ae1d2d` | `ScriptProcessor`、structured editor 设计 | `apps/web/src/production/scripts/ScriptStage.tsx` | 仅参考结构化分段编辑器；不引入其处理器或状态体系。 |
| 2026-07-25 | reference-only | `xuanyustudio/LocalMiniDrama` | `b695284b8288e392a4ce2a63717406f3830966af` | `storyGeneration`、`useStoryGeneration`、`CanvasScriptPanel`、`useCanvasScript` | `apps/web/src/production/scripts/` | 仅参考中文编辑状态和画布交互；不复制生成或影子存储。 |
| 2026-07-25 | reference-only / minimal-port | `renmengwen/MuseDock` | `3cf8d392436983e9fa93f9cdf7aa3186780cd5dd` | `NarrationPanel`、`HtmlVideoDraftPanel`、`htmlVideoDraftService` | `apps/web/src/production/scripts/` | 极小移植人工稿件编辑与明确保存交互；核心合同仍为 Narralume 不可变版本和 revision 批准。 |

## PC-02B 可配置时长与跨章选材参考来源

| 日期 | 类型 | 来源仓库 | 来源提交 | 来源文件/能力 | Narralume 文件 | 修改说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-25 | reference-only | `dramaclaw/dramaclaw` | `2864e72b3a717adbacfe09ded7b3ac6de2c2e28f` | 分集工作台、任务恢复与取消 | `apps/web/src/production/episode/`、`apps/server/src/episode-recommendation-job.ts` | 仅参考分集作用域、URL/Job 恢复和取消方法；不引入其图谱、状态库或 Agent 运行时。 |
| 2026-07-25 | method-port / source-reference-only | `HBAI-Ltd/Toonflow-app` | `bc61ec7a1b5df31293b286981a5f4ad4635464ee` | `data/skills/script_agent_decision.md`、`script_execution_skeleton.md`、`script_execution_script.md` | `apps/server/src/episode-recommendation-job.ts`、`apps/web/src/production/episode/` | 移植“Agent 推荐范围、用户确认、再按骨架逐章取材”的方法；不复制源码、短漫剧时长/字数/固定章数/付费节奏或多层 Agent。 |
| 2026-07-25 | reference-only | `alibaba/lumenx` | `7a1213a0db73ab90ca976f5c4b4ca680e1ae1d2d` | Series/Episode 与显式候选确认 | `apps/web/src/production/episode/` | 仅参考系列/分集作用域和显式选择；没有适配逐章事件证据的推荐闭包。 |
| 2026-07-25 | reference-only | `xuanyustudio/LocalMiniDrama` | `b695284b8288e392a4ce2a63717406f3830966af` | SQLite 任务状态与恢复 | `apps/server/src/database.ts`、`apps/server/src/episode-recommendation-job.ts` | 仅参考本地持久任务方法；不复制第二套任务或 Episode 存储。 |
| 2026-07-25 | method-port / values-and-source-reference-only | `renmengwen/MuseDock` | `3cf8d392436983e9fa93f9cdf7aa3186780cd5dd` | `appSettings`、`CreativeDefaultsSettings`、`creativeWorkflows`、`OneClick` | `apps/server/src/episode-policy.ts`、`apps/server/src/episode-recommendation-job.ts`、`apps/web/src/production/episode/` | 移植“系统默认可读、单任务可覆写、恢复时冻结身份”的方法；不复制其短视频默认值、固定语速/字数、业务 Prompt 或一键创作链。 |
