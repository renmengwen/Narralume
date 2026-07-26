# 项目协作规则

- `main` 只保存已验收的稳定版本；日常开发、验证和推送只在 `dev` 或从 `dev` 派生的短期功能分支进行。未经用户明确授权，不合并到 `main`。
- 用户可见文案默认使用中文。
- 前端使用 React、TypeScript、Vite、Tailwind CSS，并优先使用官方 `shadcn/ui` 组件。
- 涉及前端 UI 调整时，必须调用 OpenDesign 技能参与；优先加载 `opendesign/design-systems/narralume-product`，并让实现、文案和验收遵循现有产品设计系统。
- 后端使用 Fastify 和 TypeScript。
- 本项目是独立产品，不运行时依赖 MuseDock、DramaClaw、Toonflow 或其他参考项目。
- 后续真实验收若需要生图、多模态或配音模型，可只读 `D:\code3\MuseDock` 中已经可用的本机配置与调用合同直接执行，不因普通模型测试配置暂停向用户提问；不得把 MuseDock 变成 Narralume 的运行时依赖，不得复制其业务限定，也不得把 API Key、账号或其他敏感配置写入代码、提交、Delivery Ledger 或输出。
- 用户离线、休息或暂时不回复时，不把等待确认作为停止条件；在既定产品方向和安全边界内自主决策并持续执行到 Phase 1-7 根目标真实完成。只有缺少必须由用户提供的外部授权、需要显著改变产品方向、涉及不可逆或高风险外部操作、必须由用户作主观审美选择，或同一真实阻塞经充分排查仍无法解除时，才暂停并提问。
- 从参考项目抽取代码前，先记录来源仓库、提交、源文件和修改说明。
- “先参考成熟实现、再决定是否新写”是第一原则，适用于前端、后端、资产管理、生图提示词、任务恢复、候选审核和媒体生产。进入具体能力前，按 `DramaClaw → Toonflow → LumenX → LocalMiniDrama → MuseDock` 的冻结优先级搜索并记录来源，明确采用 `copy`、`port` 或 `reference-only`；只有确认参考项目没有适合 Narralume 现有合同的最小闭包时，才允许新写最小实现。通用前端组件优先官方 `shadcn/ui`，不得因为 MuseDock 更容易读取就提升其前端参考优先级。
- 优先使用 Node.js 标准库、浏览器原生能力、SQLite 和系统 `ffmpeg`，不为少量逻辑新增依赖。
- 修改已有文件前先读取当前内容；不得覆盖无关未提交改动。
- 异步用户操作必须显示中文 loading、成功、失败或中断状态，并防止重复提交。
- Git 提交信息默认使用中文。
- 代码 review 结果和修复说明默认使用中文。
- 修改前确认分支与 `git status --short`，先读取现有文件；不得清理、覆盖或混入无关未提交改动。
- 每个业务 Task 至少运行相关最小测试，并在提交前串行通过 `npm run typecheck`、`npm test`、`npm run build`；涉及真实文件、浏览器、`ffmpeg` 或恢复链路时，还必须完成对应真实工作流验收。
- Review 按“新增风险”而非业务名称分级：只有新增数据库迁移、文件耐久写入、编码核心、恢复原语、TTS/FFmpeg 或备份恢复核心时，才在同一冻结 candidate 上执行独立 Spec Review 和 Code Quality Review；复用已充分验证核心、仅做编排/接线/真实门禁的 Task 执行一次独立综合 Review；普通 API/UI 可综合 Review，纯文案、样式和明显一行修复可由 Coordinator 自审。发现问题后解除冻结、修复、重验并生成新 candidate，旧 Review 自动失效。每个 Phase 结束保留独立阶段门禁 Review；若 Phase 最后一个 Task 的综合 Review 已覆盖全阶段真实工作流，可同时作为阶段门禁，不重复审查。
- [`docs/loop/phase-1-7-delivery-ledger.md`](docs/loop/phase-1-7-delivery-ledger.md) 是 Phase 1-7 唯一动态状态源。只有 Coordinator 可以分配写租约、冻结 candidate、登记 Review/验证/提交证据、更新状态和恢复入口。
- Worker 不修改 Delivery Ledger；业务提交与总账控制提交分离，且都使用中文提交信息。`current-status.md` 若存在，只能从 Ledger 派生，不得维护第二套状态。
- 计划完成、单个 Task/Phase 完成、Review、提交、推送和上下文切换都只是内部 checkpoint；总目标完成或出现用户定义的真实阻塞前，Coordinator 自动进入下一个 ready Task。

## 全栈模块化与样式硬约束

- 前端样式以 Tailwind CSS utility 为第一选择；`styles.css` 只保留全局 token、reset/base、确有跨页面复用价值且 utility 无法清晰表达的少量规则。禁止继续用大段页面级手写 CSS 堆叠工作区、表单、资产卡、候选卡或响应式布局。
- 简单按钮、输入框和布局使用原生语义元素加 Tailwind；Dialog、Select、Tabs、Toast、Popover 等复杂通用交互优先采用官方 `shadcn/ui` 源码及其最小依赖，不自造一套组件系统，也不为少量静态控件无条件引入整套依赖。
- React 页面和工作区顶层组件只负责路由/恢复入口、领域状态组合和子组件编排。阶段导航、状态条、表单、资产树、Prompt Builder、候选审核、联系表等必须按独立变化原因拆成组件；数据读取/写入放在领域 hook 或 API client，纯组装/校验放在可单测纯函数，公共类型放在明确的领域类型模块。不得把 UI、请求、轮询、领域计算和大段布局同时塞进一个页面文件。
- 后端入口只负责 Fastify 实例装配、插件注册和进程生命周期；新增业务路由按领域拆为 Fastify plugin/route 模块。请求 Schema/校验、领域 service、SQLite store、Job handler、provider adapter、文件/媒体工具和错误映射分别放在对应模块，禁止继续把完整业务流程堆进 `app.ts`、`server.ts` 或单个大 service 文件。
- 前后端重复出现且语义稳定的类型、校验、状态归一化、哈希/身份、路径安全、轮询/取消和错误处理逻辑应抽取到公共模块；抽取后必须有明确调用边界和最小测试。不要复制粘贴相似实现，也不要为了追求文件数量机械拆分只有单一调用点、几行且没有独立领域含义的代码。
- 大文件判定以“是否同时承担多种变化原因”为主，不只看行数。若一个文件同时包含两类以上可独立演进的职责，修改前先拆边界；若因历史原因暂不做全量重构，本 Task 的新增代码也必须进入新模块，不得继续扩大旧大文件，并在 Delivery Ledger 登记剩余技术债。

## Git 提交信息规范

提交信息遵循 Conventional Commits：`<type>[(scope)]: <description>`。type 用英文（feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert），description 用中文。一个提交只做一件事，业务/总账/环境配置分别独立提交。
