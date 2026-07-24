# 项目协作规则

- 用户可见文案默认使用中文。
- 前端使用 React、TypeScript、Vite、Tailwind CSS，并优先使用官方 `shadcn/ui` 组件。
- 后端使用 Fastify 和 TypeScript。
- 本项目是独立产品，不运行时依赖 MuseDock、DramaClaw、Toonflow 或其他参考项目。
- 从参考项目抽取代码前，先记录来源仓库、提交、源文件和修改说明。
- 优先使用 Node.js 标准库、浏览器原生能力、SQLite 和系统 `ffmpeg`，不为少量逻辑新增依赖。
- 修改已有文件前先读取当前内容；不得覆盖无关未提交改动。
- 异步用户操作必须显示中文 loading、成功、失败或中断状态，并防止重复提交。
- Git 提交信息默认使用中文。
- 代码 review 结果和修复说明默认使用中文。
