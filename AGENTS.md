# 项目协作规则

- `main` 只保存已验收的稳定版本；日常开发、验证和推送只在 `dev` 或从 `dev` 派生的短期功能分支进行。未经用户明确授权，不合并到 `main`。
- 用户可见文案默认使用中文。
- 前端使用 React、TypeScript、Vite、Tailwind CSS，并优先使用官方 `shadcn/ui` 组件。
- 后端使用 Fastify 和 TypeScript。
- 本项目是独立产品，不运行时依赖 MuseDock、DramaClaw、Toonflow 或其他参考项目。
- 后续真实验收若需要生图、多模态或配音模型，可只读 `D:\code3\MuseDock` 中已经可用的本机配置与调用合同直接执行，不因普通模型测试配置暂停向用户提问；不得把 MuseDock 变成 Narralume 的运行时依赖，不得复制其业务限定，也不得把 API Key、账号或其他敏感配置写入代码、提交、Delivery Ledger 或输出。
- 从参考项目抽取代码前，先记录来源仓库、提交、源文件和修改说明。
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
