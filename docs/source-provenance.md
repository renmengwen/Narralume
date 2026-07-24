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
