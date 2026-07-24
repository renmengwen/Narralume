# Narralume Phase 1-7 Delivery Ledger

> **唯一动态状态源。** Task、Requirement、租约、candidate、Review、验证、提交、风险和恢复入口只在本文件更新。implementation 计划、聊天记录和 `current-status.md` 不维护第二套状态。

## 根目标与固定边界

- Goal ID：`NARRALUME-P1-P7`
- 根目标：持续完成 Narralume Phase 1-7，直到真实 3～5 分钟 9:16 样片和可在空数据目录恢复的项目包验收完成。
- 仓库：`D:\code3\Narralume`
- 不可变基线：`main@e75b1c33140f92703cce07c89673ec06b8393f92`
- 集成分支：`dev`；默认只推送 `origin/dev`，未经用户明确授权不合并 `main`。
- 独立边界：不在 MuseDock 开发，不运行时依赖任何参考项目。
- 停止条件：根目标完成，或出现用户列明的真实外部授权/方向/高风险/主观审美/充分排查后仍无法解除的阻塞。

## 状态机与字段规则

Task 状态：`queued → leased → implementing → frozen_for_review → verified → committed → complete`；Review 失败进入 `changes_requested → implementing`。可进入 `blocked/cancelled`。只有 Coordinator 更新状态。

每个 Task 必填：依赖、Owner/写租约、candidate revision/tree、冻结控制提交、适用的 Review Verdict、验证证据、业务提交 SHA、剩余风险和恢复动作。高风险 Task 填独立 Spec/Code Quality Review；普通 Task 的两个 Review 列共同引用同一次独立综合 Review；低风险 Task 标记 Coordinator 自审。未产生的字段使用 `-`，不得用推测填充。控制提交自己的 SHA 由 Git 历史定位，不写入自身，避免自引用。

普通业务 Task 的写租约必须排除本 Ledger；Coordinator 在 `dev` 串行完成 Ledger 冻结控制提交，Reviewer Verdict 必须绑定 `reviewed_ledger_commit` 和 `reviewed_revision`。`CTRL-01` 首次创建 Ledger 时使用一次性 bootstrap：先提交完整控制面，将不可变 commit/tree 作为 candidate；双 Review 后由下一条控制提交登记结果。之后不得再次使用该例外。

2026-07-24 用户再次确认首版以复用代码为主、边界不细拆且减少 Review：只有真正新造高风险核心才双 Review；大量复用已验证核心并做迁移接线、编排和真实门禁时只执行一次独立综合 Review；低风险 Coordinator 自审。Phase 结束保留阶段门禁，但最后一个 Task 的综合 Review 已覆盖全阶段真实工作流时可合并，不重复审查。

## 当前恢复入口

- 当前分支：`dev`
- 当前 HEAD：`67f589d1ca6954a58851786143855219936f39f5`（P5-01 首轮 finding 控制提交；本控制提交后以 Git 历史定位最新 HEAD）
- 工作区：`dev` 仅本 Ledger 待提交；P5-01 已仅修改并重新 stage `database.ts/database.test.ts`，其余 6 个路径保持冻结，第二版 candidate tree 已冻结且零额外 unstaged/untracked。
- 最近验证：2026-07-25 P5-01 Worker 实现态；全量 `typecheck/test/build` 与 diff GREEN，server 64/64、web 6/6；真实资产 gate 建立人物/两个状态/场景/道具及四组别名，重启稳定与系列级联 GREEN。
- 当前 Task：`P5-01`
- 唯一下一动作：由独立 Reviewer 绑定第二版冻结控制提交/revision 复审，确认数据库直接 SQL 已拒绝 `master→state→state` 且原合同、三门和真实 gate 无回归。

## 当前写租约

| Task | Owner | Worktree / branch / base | 允许路径 | 状态所有权 | 排他资源 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| P5-01 | Coordinator | `D:\code3\Narralume-worktrees\P5-01` / `codex/p5-01` / `eb4ac1020bbff394859a0df12d7284537747f682` | 8 个冻结业务路径；排除本 Ledger | 主资产、状态资产、系列级别名、重启恢复 | SQLite schema、`app.ts`、Worker Git index | `frozen_for_review` |

## Phase 依赖

`Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7`。Phase 状态从 Task/Requirement 派生，不单独维护手写进度。

## Task DAG 与唯一状态

| Task | 状态 | 依赖 | Owner / 写租约 | Candidate revision / tree | 冻结控制提交 | Spec Review | Code Quality Review | 验证证据 | 业务提交 SHA | 剩余风险 / 恢复动作 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CTRL-01 控制面初始化 | `complete` | Phase 0 | Coordinator / 已释放 | `git-commit-tree-v1:428af35a9e015a2f39431f12ab7709074fc5f5cb:1f9ac40cd2c35557cbeedb46fe13d3a436695000` | bootstrap candidate 即 `428af35` | PASS，绑定同一 revision | PASS，绑定同一 revision | Phase 0 三门通过；commit/tree 复算；`git diff --check` 通过 | `428af35a9e015a2f39431f12ab7709074fc5f5cb` | 无；进入 P1-01 |
| P1-01 数据根与 SQLite 基线 | `complete` | CTRL-01 | Coordinator / 已释放 | `git-index-tree-v1:e6452d35788543cadd5908da60061e851a3a7dc7:15b1cb4f3667a1afaf8b9c3d3712c06f35d42447` | `72438d0` | PASS，绑定 `72438d0`/第二版 revision | PASS，绑定 `72438d0`/第二版 revision | 集成态全量 `typecheck/test/build` GREEN；3 项 server tests；Windows 失败后文件删除 GREEN | `154a391` | Node 22 SQLite 实验性警告；进入 P1-02 |
| P1-02 TXT 流式导入 | `complete` | P1-01 | Coordinator / 已释放 | `git-index-tree-v1:154a391eb1795aeebff2260f5e6a1eae2b0ea3de:2a74235c0e3c98d26ad3c65a46068564123730d5` | `eeced89` | PASS，绑定第三版 revision | PASS，绑定第三版 revision | 集成态 8 项 server tests；全量三门 GREEN；并发/失败清理/fsync | `8884491` | Node SQLite 实验性警告；进入 P1-03 |
| P1-03 编码与章节索引 | `complete` | P1-02 | Coordinator / 已释放 | `git-index-tree-v1:8884491a865b9ed334c2ca493621c7e93e4f51da:325e71d7da8923bf65b3c8bedd96457c8325d063` | `8110fe7` | PASS，绑定第二版 revision | PASS，绑定第二版 revision | 集成态 12 项 server tests；全量三门 GREEN；编码/内存/事务真实探针 | `9df94e2` | 1 MiB 单行门；进入 P1-04 |
| P1-04 书库 API 与最小 UI | `complete` | P1-03 | Coordinator / 已释放 | `git-index-tree-v1:9df94e21f03ef41f33271b45317cde142cba6fa9:b0aaa519364e4dd3f92ed1a48050db7dc2a063e4` | `c92c1aa` | PASS，绑定 `c92c1aa`/第二版 revision | PASS，绑定同一次独立综合 Review | 集成态全量三门 GREEN；server 13 项、web 6 项；2 章与 105 章真实 UI 流程；OpenDesign 第二版核验 PASS | `0837567` | Node SQLite 实验性警告；真实大文本性能与重启门进入 P1-05 |
| P1-05 真实大文本门禁 | `complete` | P1-04 | Coordinator / 已释放 | `git-index-tree-v1:083756749e3487fad3529eb28493bafcfd8d66ca:3eb226b3dcc244b2c08318b5d4be9eee4c3f59e6` | `a7de1e2` | PASS，绑定 `a7de1e2`/第二版 revision | PASS，绑定同一次 Phase 1 阶段门禁综合 Review | 集成态全量三门与真实门禁 GREEN；124 章、RSS 增量 9,027,584 bytes；故障清理探针 GREEN | `7d23438` | Node SQLite 实验性警告；Phase 1 complete，进入 P2-01 |
| P2-01 持久化任务状态机 | `complete` | P1-05 | Coordinator / 已释放 | `git-index-tree-v1:7d234384deee8e7ebe5f24accfc13144e44f8d7c:0c7ba6e3d055f3f8ca12d62348a1b0114952d026` | `e575591` | PASS，绑定 `e575591`/candidate revision | PASS，绑定 `e575591`/candidate revision | 集成态全量三门/diff GREEN；server 27 项、web 6 项；Quality 时序重复 5/5 | `d8dff8f` | Node SQLite 实验性警告；协作取消与外部副作用幂等进入 P2-02 |
| P2-02 checkpoint 与恢复 | `complete` | P2-01 | Coordinator / 已释放 | `git-index-tree-v1:d8dff8fcc2831c10c55654d958225fad7c2e8c6d:e162f18ddfbf033c85a6e4b6cbae5790eb285973` | `cee11c6` | PASS，绑定 `cee11c6`/第三版 revision | PASS，绑定 `cee11c6`/第三版 revision | 集成态全量三门/diff GREEN；server 36 项、web 6 项；恢复 gate 最终 succeeded、attempts=2、重复结果 0 | `fbc1d65` | Node SQLite 实验性警告；受限 transaction 的复杂语句限制进入真实调用验证 |
| P2-03 章节事件合同 | `complete` | P2-02 | Coordinator / 已释放 | `git-index-tree-v1:fbc1d652d3170a6d1c142b6c01ac8c4db955e913:03911512550f2dbe8d414412588aea3b144ea1e6` | `a1d7417` | PASS，绑定 `a1d7417`/冻结 revision | PASS，绑定 `a1d7417`/冻结 revision | 集成态全量三门/diff GREEN；server 42、web 6；P2 恢复 gate、真实 124 章门禁 GREEN | `9d75144` | 极端短证据性能不阻塞首版；未来 handler 需校验 prepared chapterId |
| P2-04 真实章节任务门禁 | `complete` | P2-03 | Coordinator / 已释放 | `git-index-tree-v1:9d75144a73bdb12a8a4d573c20e9f9672fd1cdf4:4b59c6d54aa8889655cfe0fe71d5c5934130482a` | `14c31c3` | PASS，绑定 `14c31c3`/冻结 revision | PASS，绑定同一次 Phase 2 综合 Review | 集成态全量三门/diff GREEN；server 44、web 6；P2 恢复 gate GREEN；真实 3 章 gate：硬退出 91、attempts=2、processed=1/reused=2、取消 checkpoint=0、重启六类事件 6 条 | `86ce213` | 人工 PUT 后旧 checkpoint 可能命中；Node SQLite 实验性警告；Phase 2 complete |
| P3-01 故事弧与分集证据 | `complete` | P2-04 | Coordinator / 已释放 | `git-index-tree-v1:86ce213515c4b2d598651a5feb88200cd22f4672:ba09275959aca1349712f0dce86670355ba38144` | `6341496` | PASS，绑定 `6341496`/冻结 revision | PASS，绑定 `6341496`/冻结 revision | 集成态全量三门/diff GREEN；server 49、web 6；真实 gate：3 章、6 来源事件、240 秒单集、6 证据快照、重启查询与重复 PUT 幂等 | `b83f774` | Node SQLite 实验性警告；进入 P3-02 |
| P3-02 稿件版本 | `complete` | P3-01 | Coordinator / 已释放 | `git-index-tree-v1:b83f77410b93aa6f1d0fe44c6ef13e767b40685d:aeaee1d97291f3b716fd8ff5b00a350125d0c7f5` | `8670066` | PASS，绑定 `8670066396f55211a939245877595bc8bb33d2ca`/第二版 revision | PASS，绑定 `8670066396f55211a939245877595bc8bb33d2ca`/第二版 revision | 集成态全量三门/diff GREEN；server 54/54、web 6/6；双连接相同内容同 ID/v1 且库内仅 1 版本；真实三版本、幂等 POST、重启查询 gate GREEN | 冻结 `b0259dd`；集成 `eecdde2` | Node SQLite 实验性警告；首轮并发幂等 finding 已关闭；进入 P3-03 |
| P3-03 人工批准闸门 | `complete` | P3-02 | Coordinator / 已释放 | `git-index-tree-v1:01b34531a84cf7150e407be20736f6784f143baa:7b078e0190daf74f63ee03b096e285be8cf20a48` | `0b41f55` | PASS，绑定 `0b41f559741418b99eb24ca5df42596f564f6269`/冻结 revision | PASS，绑定 `0b41f559741418b99eb24ca5df42596f564f6269`/冻结 revision | 集成态全量三门/diff GREEN；server 56/56、web 6/6；批准放行同一包装稿，撤回与重启后 TTS/图片硬阻断 | 冻结 `94703a1`；集成 `7e46d88` | Node SQLite 实验性警告；进入 P3-04 |
| P3-04 真实分集验收 | `complete` | P3-03 | Coordinator / 已释放 | `git-index-tree-v1:9563e190bcde028ff55bfdc2bd89b3206dc90e94:0f281fa651c85e8f1a5d084c5497e8dc799c26d8` | `8414457` | PASS，绑定 `84144575adb0e6e24862d47dc0c220c48e3c45cb`/冻结 revision，同一次 Phase 3 综合 Review | PASS，绑定同一次综合 Review | 集成态全量三门/diff GREEN；server 56/56、web 6/6；真实批准稿 1,139 字/284.75 秒估算、8 段证据、最终 approved revision 3、重启精确放行 | 冻结 `516cce9`；集成 `bbd7953` | 估算非真实音频时长；Phase 3 complete，进入 P4-01 |
| P4-01 TTS provider 边界 | `complete` | P3-04 | Coordinator / 已释放 | `git-index-tree-v1:08fa14e6dbc60d42f0d415b686c6368a71a5865c:00b8486e9d17fc04df622e954464100fcb0ef850` | `bb6b72c` | PASS，绑定 `bb6b72c065e52367ce722e6f60c7139bb65efb01`/第二版 revision | PASS，绑定同一 Ledger/revision | 集成态全量三门/diff GREEN；server 57/57、web 6/6；UTF-8 code units、已持有临时 WAV 后取消零泄漏、真实中文 WAV 221,542 bytes/5.022585 秒 | 冻结 `240e133`；集成 `284cfbb` | Windows System.Speech 单 provider；进入 P4-02 |
| P4-02 真实音频时间轴 | `complete` | P4-01 | Coordinator / 已释放 | `git-index-tree-v1:09825013d318b163347fa5b133e6238da587d34a:145f46172035ea78e9462e52d445f9ee3da17d99` | `1b912c0` | PASS，绑定 `1b912c051fc46245b6ab2a6eeb5e84ae8b49c72e`/第三版 revision | PASS，绑定同一次综合 Review | 集成态全量三门/diff GREEN；server 60/60、web 6/6；真实 20,506ms、2 段/2 cue、SRT/ASS、重启复用；checkpoint 失败与批准撤回均零登记 | 冻结 `b47fb73`；集成 `4fa622b` | Windows 单 provider；3～5 分钟视频验收进入 P4-03 |
| P4-03 占位视频 | `complete` | P4-02 | Coordinator / 已释放 | `git-index-tree-v1:dd453136a131948fdb6660377c4da3dee4835137:89716b2527c3bdc04d30e289fa9d69be46ee6635` | `105fee0cbfc8366e50c44455dfa322f5237227e3` | PASS，绑定冻结 Ledger/revision；同一次综合 Review 覆盖 Phase 4 | PASS，绑定同一次综合 Review；无 findings | 集成态 `typecheck/test/build`、diff GREEN；server 61/61、web 6/6；三个 Phase 4 gate GREEN；真实 MP4 220,960ms、3,102,618 bytes、1080×1920@25、H.264+AAC、SHA-256 `4ee48037bd54a827ff33f40d07eb8066e5267107f989c3f5561f5105b8e17f4d`、重启复用 | 冻结 `0fb7faf`；集成 `eaa6c32` | Node SQLite 实验性警告与 Windows 单 provider 非阻断；Phase 4 complete，进入 P5-01 |
| P5-01 资产合同 | `frozen_for_review` | P4-03 | Coordinator / 写租约见上 | 第二版 `git-index-tree-v1:eb4ac1020bbff394859a0df12d7284537747f682:19fda63cc325d0295ff926c34c7efce0a9ac87ef` | 本冻结控制提交；首版 `2153b9b` 已失效 | 首轮 FAIL：状态套状态数据库缺口；待第二版复审 | 首轮 FAIL，同一 finding；待第二版复审 | 第二版全量 `typecheck/test/build`、cached diff GREEN；server 64/64、web 6/6；migration trigger 直接拒绝 state→state，master→state、真实资产 gate、重启与级联均 GREEN | - | 首轮 finding 已最小修复；等待第二版综合复审 |
| P5-02 候选图与来源 | `queued` | P5-01 | - | - | - | - | - | - | - | - |
| P5-03 视觉段显式绑定 | `queued` | P5-02 | - | - | - | - | - | - | - | - |
| P5-04 联系表与真实审核 | `queued` | P5-03 | - | - | - | - | - | - | - | 真实候选若需用户审美选择时阻塞 |
| P6-01 唯一 9:16 模板 | `queued` | P5-04 | - | - | - | - | - | - | - | - |
| P6-02 分片与身份 | `queued` | P6-01 | - | - | - | - | - | - | - | - |
| P6-03 concat 与导出清单 | `queued` | P6-02 | - | - | - | - | - | - | - | - |
| P6-04 真实渲染恢复门禁 | `queued` | P6-03 | - | - | - | - | - | - | - | - |
| P7-01 真实样片 E2E | `queued` | P6-04 | - | - | - | - | - | - | - | - |
| P7-02 可恢复项目包 | `queued` | P7-01 | - | - | - | - | - | - | - | - |
| P7-03 空目录恢复演练 | `queued` | P7-02 | - | - | - | - | - | - | - | - |
| P7-04 最终验收 | `queued` | P7-03 | - | - | - | - | - | - | - | - |

## Requirement 唯一状态

| Requirement | 状态 | 验收摘要 | 对应 Task |
| --- | --- | --- | --- |
| REQ-CTRL-01 | `verified` | `dev`、文档权威层级、唯一 Ledger、冻结/双 Review/恢复规则已建立；待本控制提交一并推送 | CTRL-01 |
| REQ-P1-01 | `verified` | 稳定书籍 ID；真实 TXT 流式原子导入、限制与幂等 | P1-02 |
| REQ-P1-02 | `verified` | UTF-8、GBK/CP936、GB18030 编码识别 | P1-03 |
| REQ-P1-03 | `verified` | 稳定章节 ID、原始字节偏移、字符数、SHA-256 和重复编号 | P1-03 |
| REQ-P1-04 | `verified` | SQLite 重启后书库/章节分页/原始字节切片查询与中文 UI；系统/浅色/深色主题与异步四态 | P1-01、P1-04 |
| REQ-P1-05 | `verified` | 公版真实《红楼梦》124 章：RSS 有界、幂等、重启、全量分页、首中尾偏移与真实重复编号门禁 | P1-05 |
| REQ-P2-01 | `verified` | 持久化 Worker、租约、重试、取消与精确定向恢复；真实 3 章硬退出恢复通过 | P2-01、P2-02、P2-04 |
| REQ-P2-02 | `verified` | 六类结构化章节事件及精确原文证据；真实任务重启查询与哈希复算通过 | P2-03、P2-04 |
| REQ-P3-01 | `verified` | 真实 240 秒分集；3 章 6 事件/证据快照；1,139 字最终批准包装稿的 8 段来源、哈希、父链与重启查询均通过 | P3-01、P3-04 |
| REQ-P3-02 | `verified` | 忠实/包装稿不可变追加；批准/撤回事件不可覆盖，乐观 revision；未批准及撤回后 TTS/图片硬阻断 | P3-02、P3-03 |
| REQ-P4-01 | `verified` | 真实 System.Speech TTS/ffprobe 时间轴、SRT/ASS、220,960ms 的 1080×1920 H.264+AAC 占位视频、内容寻址复用与重启验证 | P4-01～P4-03 |
| REQ-P5-01 | `pending` | 主/状态资产、别名、候选、来源、显式视觉段关系和联系表 | P5-01～P5-04 |
| REQ-P6-01 | `pending` | 唯一 9:16 模板、微动淡化、ASS、分片恢复、concat 与探测验证 | P6-01～P6-04 |
| REQ-P7-01 | `pending` | 真实 3～5 分钟样片 | P7-01 |
| REQ-P7-02 | `pending` | 带 manifest/hash 的项目包可在空数据目录恢复并重新导出 | P7-02、P7-03 |
| REQ-P7-03 | `pending` | 成本/耗时/失败率/人工耗时、全量验证和独立双 Review | P7-04 |

## 验证与 Review 证据索引

| 日期 / Task | 证据 |
| --- | --- |
| 2026-07-24 Phase 0 基线 | `main/dev@e75b1c3`；`npm run typecheck`、`npm test`、`npm run build` 均通过；Node `v22.22.3`；FFmpeg/FFprobe `8.1.1` |
| 2026-07-24 CTRL-01 | 业务提交 `428af35`；candidate `git-commit-tree-v1:428af35a9e015a2f39431f12ab7709074fc5f5cb:1f9ac40cd2c35557cbeedb46fe13d3a436695000`；独立 Spec Review PASS；独立 Code Quality Review PASS；两者均复算 commit tree 且工作区 clean |
| 2026-07-24 P1-01 candidate | `git-index-tree-v1:e6452d35788543cadd5908da60061e851a3a7dc7:bff87773d05e84a8456b299f8cb5b99bdffbb5c4`；新增 `config.ts`、`database.ts`、`database.test.ts`；缺模块测试 RED 后，全量 `npm run typecheck`、`npm test`、`npm run build` GREEN；Node 内置 SQLite 实验性警告保留 |
| 2026-07-24 P1-01 首轮 Review | Spec PASS；Code Quality FAIL：损坏迁移表使初始化查询抛错时连接未关闭，Windows 文件保持 `EBUSY`；关键章节约束与失败清理缺测试。旧 revision 失效，进入修复。 |
| 2026-07-24 P1-01 第二版 candidate | `git-index-tree-v1:e6452d35788543cadd5908da60061e851a3a7dc7:15b1cb4f3667a1afaf8b9c3d3712c06f35d42447`；统一外层失败关闭，rollback 失败不覆盖原异常；章节唯一/范围/级联约束与损坏迁移表后 Windows 文件可删除测试通过；全量三门 GREEN。 |
| 2026-07-24 P1-01 完成 | 第二轮 Spec Review PASS、Code Quality Review PASS，均绑定 Ledger `72438d0` 与第二版 revision；业务提交/集成提交 `154a391`；`dev` 集成态全量三门 GREEN。 |
| 2026-07-24 P1-02 candidate | `git-index-tree-v1:154a391eb1795aeebff2260f5e6a1eae2b0ea3de:ba8c665e5403110304bb119f794bfcd8bee9f41c`；原始 HTTP 流、分块文件流、SHA-256、默认 512 MiB 上限、空/超限清理、内容寻址原子目录认领和重复哈希幂等；6 项 server tests 与全量三门 GREEN。 |
| 2026-07-24 P1-02 首轮 Review | Spec/Quality 均 FAIL：Windows 并发 rename 返回 `EPERM` 未识别；写入完成后的查库/建目录等失败可残留 staging；`FileHandle.write` 未处理短写。旧 revision 失效。 |
| 2026-07-24 P1-02 第二版 candidate | `git-index-tree-v1:154a391eb1795aeebff2260f5e6a1eae2b0ea3de:bf1bdb2368cd420a4ddc7ff73dab57b1ef1fafc2`；原生 `pipeline/createWriteStream` 处理背压/短写；按目标目录实存识别 Windows 并发认领；统一所有权 `finally` 清理；8 路并发与写后 FS 失败测试通过；全量三门 GREEN。 |
| 2026-07-24 P1-02 第二轮 Review | Spec PASS；Quality FAIL：`createWriteStream` 未要求关闭前 fsync，突然断电可能出现 DB 已登记但原文未持久化。第二版 revision 失效。 |
| 2026-07-24 P1-02 第三版 candidate | `git-index-tree-v1:154a391eb1795aeebff2260f5e6a1eae2b0ea3de:2a74235c0e3c98d26ad3c65a46068564123730d5`；Node 22 原生 `createWriteStream({flush:true})` 在关闭前 fsync；8 项 server tests 与全量三门 GREEN。 |
| 2026-07-24 P1-02 完成 | 第三轮 Spec/Quality Review PASS，均绑定 Ledger `eeced89` 与第三版 revision；业务提交/集成提交 `8884491`；集成态 8 项 server tests 与全量三门 GREEN。 |
| 2026-07-24 P1-03 candidate | `git-index-tree-v1:8884491a865b9ed334c2ca493621c7e93e4f51da:2bd99aa5b3ada9f6ef57e2374e962de12e361950`；64 KiB 严格编码探测，UTF-8/GB18030 行流解析，原始字节偏移/哈希/稳定章节 ID，重复编号不覆盖，原子重建章节；10 项 server tests 与全量三门 GREEN。 |
| 2026-07-24 P1-03 首轮 Review | Spec/Quality 均 FAIL：64 KiB 样本可能截断 UTF-8 或把 ASCII 前缀 GBK 误判为 UTF-8；无 LF 时 pending 无界且 O(n²)；GB18030 非 BMP 字符按 UTF-16 单元多计；HTTP book 状态仍为索引前值。旧 revision 失效。 |
| 2026-07-24 P1-03 第二版 candidate | `git-index-tree-v1:8884491a865b9ed334c2ca493621c7e93e4f51da:325e71d7da8923bf65b3c8bedd96457c8325d063`；完整文件流式严格 UTF-8/GB18030 验证；1 MiB 单行中文门限制内存；Unicode code point 计数；HTTP book 状态 ready；12 项 server tests 与全量三门 GREEN。 |
| 2026-07-24 P1-03 完成 | 第二轮 Spec/Quality Review PASS，均绑定 Ledger `8110fe7` 与第二版 revision；非法尾部/事务失败/64 KiB 编码边界/单行门真实探针通过；业务提交/集成提交 `9df94e2`；集成态全量三门 GREEN。 |
| 2026-07-24 P1-04 candidate | `git-index-tree-v1:9df94e21f03ef41f33271b45317cde142cba6fa9:7a144d758f0cc6b41e35a84f07924fc6463e4ae1`；书库/章节分页/原始字节切片 API，中文上传与中断状态，系统/浅色/深色主题，OpenDesign 暖中性产品规范；全量三门、server 12 项、web 5 项与 cached diff GREEN；浏览器真实上传 2 章并读取原文，浅色/深色刷新持久化及恢复系统通过；OpenDesign 首轮核验发现编码字符和命中区问题，修复后第二版独立核验 PASS；manifest 7 项与全树扫描一致。 |
| 2026-07-24 P1-04 首轮综合 Review | FAIL，绑定 Ledger `9ddb640` 与首版 revision；P1：章节 UI 固定 `limit=100` 使后续章节不可达；导入 POST 成功后列表刷新失败会误报导入失败且覆盖成功状态。P2：原文读取缺 GB18030 非零切片、短读/严格解码/句柄关闭/路径边界测试；省略书名与章节名缺完整 `title`。旧 revision 失效。 |
| 2026-07-24 P1-04 第二版 candidate | `git-index-tree-v1:9df94e21f03ef41f33271b45317cde142cba6fa9:b0aaa519364e4dd3f92ed1a48050db7dc2a063e4`；新增 100 章一页的“加载更多”和 `X/N` 状态；导入成功与列表刷新错误分离且 POST 后立即清空中断引用；GB18030 非零切片、短读后 Windows 改名、fatal 解码、路径越界测试；省略标题补完整 `title`；全量三门、server 13 项、web 6 项 GREEN；真实 105 章从 100/105 加载至 105/105。 |
| 2026-07-24 P1-04 完成 | 第二轮独立综合 Review PASS，绑定 Ledger `c92c1aa` 与第二版 revision；业务提交/集成提交 `0837567`；集成态全量三门 GREEN；OpenDesign 深浅/系统主题规范、UI Kit、mockup 和实际 React 工作台落地。 |
| 2026-07-24 P1-05 candidate | `git-index-tree-v1:083756749e3487fad3529eb28493bafcfd8d66ca:d40a52726430d4d6ca76922b449f8aa0bf001fe6`；自包含下载 Project Gutenberg eBook #24264《红楼梦》，冻结 2,663,455 bytes 与 SHA-256 `ff1526996bf4b81807651921a85e5c1c0f1d1d123c9fa4553057ba6a3ec72011`；真实 HTTP 流式导入 124 章，重复导入 200/稳定 ID，关闭重启后全量分页可读，首/中/尾切片文本与内容哈希吻合；真实重复章节编号 `二`、`四`、`四十五` 未覆盖；RSS 峰值增量 18,972,672 bytes，低于 96 MiB 门限；全量三门 GREEN。 |
| 2026-07-24 Phase 1 首轮阶段门禁 Review | FAIL，绑定 Ledger `e6ae4a0` 与 P1-05 首版 revision；P1：真实重复章节编号只统计未断言，解析覆盖回归仍可 `ok: true`；上传失败未清 RSS interval 且响应异常路径不完备。P2：自下载在外层 finally 前失败会残留，固定临时文件名使并发运行互相截断/删除。Phase 1 产品实现复核无其他阻断，旧 revision 失效。 |
| 2026-07-24 P1-05 第二版 candidate | `git-index-tree-v1:083756749e3487fad3529eb28493bafcfd8d66ca:3eb226b3dcc244b2c08318b5d4be9eee4c3f59e6`；冻结来源稳定断言 124 个章节范围；强断言重复编号 `二/四/四十五` 均为 2 个不同 ID 与索引；HTTP 响应 aborted/error 与源流 error 确定失败；唯一下载临时目录；sampler、运行时、数据根、下载根统一 finally 清理；正常真实门禁 RSS 增量 17,907,712 bytes；sampler 后故障注入退出码 1、4.33 秒退出、临时目录泄漏 0；全量三门 GREEN。 |
| 2026-07-24 Phase 1 完成 | 第二轮独立阶段门禁综合 Review PASS，绑定 Ledger `a7de1e2` 与 P1-05 第二版 revision；正常门禁、sampler 后故障注入、下载后早期失败清理均独立复验；业务提交/集成提交 `7d23438`；集成态全量三门及真实门禁 GREEN，RSS 增量 9,027,584 bytes。 |
| 2026-07-24 P2-01 candidate | `git-index-tree-v1:7d234384deee8e7ebe5f24accfc13144e44f8d7c:0c7ba6e3d055f3f8ca12d62348a1b0114952d026`；migration v2 jobs STRICT 表；单 Worker 租约/续租/回收、进度、错误、重试、取消与陈旧所有者拒绝；仅领取已注册类型；HTTP 创建/查询/取消；Fastify 启停与监听失败资源清理；全量 `typecheck/test/build`、cached diff GREEN，server 27 项、web 6 项。 |
| 2026-07-24 P2-01 双 Review | Spec PASS、Code Quality PASS，均绑定 Ledger `e575591` 与 candidate revision；两者独立复算 tree 并复跑全量三门，Quality 额外重复 Worker/HTTP/租约时序测试 5/5；无 findings，剩余风险进入 P2-02 checkpoint 与实际 handler 协作取消。 |
| 2026-07-24 P2-01 完成 | 中文业务提交/集成提交 `d8dff8f`；`dev` 集成态全量 `typecheck/test/build` 与 diff check GREEN，server 27 项、web 6 项；写租约释放，进入 P2-02。 |
| 2026-07-24 P2-02 candidate | `git-index-tree-v1:d8dff8fcc2831c10c55654d958225fad7c2e8c6d:57cc215f2c121d46e3608faa2ec781cddd165a69`；migration v3 完成态 checkpoint；SHA-256 输入身份；有效租约/未取消校验；同输入幂等跳过、输入变化原子替换、失败回滚；同步 writer 类型与运行时保护；Worker context 接点；双子进程硬退出后仅恢复缺失范围；全量三门 GREEN，server 35 项、web 6 项，gate GREEN。 |
| 2026-07-24 P2-02 首轮 Review | Spec PASS；Code Quality FAIL，均绑定 Ledger `617b1f7` 与首版 revision；普通函数返回 Promise 可持有原始 `DatabaseSync`，在 rollback 后 continuation 写入领域结果而无 checkpoint。首版 revision 失效。 |
| 2026-07-24 P2-02 第二版 candidate | `git-index-tree-v1:d8dff8fcc2831c10c55654d958225fad7c2e8c6d:a75afc99b08eb7f3048c51316d5f7ad1dc22f1ed`；writer 改为只收集 SQL 操作的受限 `CheckpointTransaction`，回调返回后立即失活，再由 checkpoint 层在事务内执行；Promise continuation 不能持有原始数据库句柄，异步泄漏回归结果 0；全量三门与双子进程恢复 gate GREEN。 |
| 2026-07-24 P2-02 第二轮 Review | Spec/Code Quality 均 FAIL，绑定 Ledger `b56cb3e` 与第二版 revision；受限 transaction 仍接受任意 SQL，writer 可排队 `COMMIT` 提前结束外层事务并造成领域结果逃逸。第二版 revision 失效。 |
| 2026-07-24 P2-02 第三版 candidate | `git-index-tree-v1:d8dff8fcc2831c10c55654d958225fad7c2e8c6d:e162f18ddfbf033c85a6e4b6cbae5790eb285973`；受限 transaction 仅接受单条 `INSERT/UPDATE/DELETE` 领域 DML，执行任何排队 SQL 前拒绝事务控制、DDL、PRAGMA、ATTACH 与多语句；逃逸回归领域行/checkpoint 均为 0 且连接可继续使用；全量三门、server 36 项、web 6 项与恢复 gate GREEN。 |
| 2026-07-24 P2-02 第三轮 Review | Spec PASS、Code Quality PASS，均绑定 Ledger `cee11c6` 与第三版 revision；全量三门与恢复 gate 独立复验；Quality 额外验证 10/10 事务逃逸变体拒绝、领域/checkpoint 泄漏 0、连接继续可用；无 findings。 |
| 2026-07-24 P2-02 完成 | 冻结业务提交 `f4998a7`，集成 `dev` 为 `fbc1d65`；集成态 `typecheck/test/build`、diff check GREEN，server 36/36、web 6/6；恢复 gate 硬退出码 91、首次完成 2 个范围、恢复 1 个范围、最终 `succeeded`、`attempts=2`、重复结果 0；释放写租约并进入 P2-03。 |
| 2026-07-24 P2-03 只读合同审计 | 发现 `indexBookChapters` 对重复导入无条件删除/重建章节；新增 `chapter_events ON DELETE CASCADE` 后会静默清空事件。P2-03 写租约扩展至章节索引及测试，要求相同稳定章节结果跳过重建并以回归测试保护。 |
| 2026-07-24 P2-03 candidate | `git-index-tree-v1:fbc1d652d3170a6d1c142b6c01ac8c4db955e913:03911512550f2dbe8d414412588aea3b144ea1e6`；migration v4 事件/多段证据两表；六类严格 payload、稳定 ID/occurrence、绝对原始字节范围与服务端 SHA-256；8 MiB 总证据门、唯一边界单流扫描、整章漂移双检；人工与 checkpoint 共用原子替换；重复导入保留事件；中文 PUT/GET 与全局错误边界。全量三门、server 42、web 6、P2 恢复 gate、真实《红楼梦》124 章门禁 GREEN；双冻结前审计 PASS。 |
| 2026-07-24 P2-03 正式双 Review | Spec PASS、Code Quality PASS，均绑定 Ledger `a1d7417` 与冻结 revision；复算 7 个 staged 路径、HEAD/tree 与工作区洁净性一致；全量三门、P2 恢复 gate、真实《红楼梦》124 章门禁独立通过；无阻断 findings。未知 payload 键、证据顺序身份与极端短证据文件打开次数记为非阻断首版风险。 |
| 2026-07-24 P2-03 完成 | 冻结业务提交 `6c0903c`，集成 `dev` 为 `9d75144`；集成态全量三门/diff、P2 恢复 gate 与真实《红楼梦》124 章门禁 GREEN；释放写租约并按用户“首版先做出来”口径进入最小 P2-04。 |
| 2026-07-24 P2-04 candidate | `git-index-tree-v1:9d75144a73bdb12a8a4d573c20e9f9672fd1cdf4:4b59c6d54aa8889655cfe0fe71d5c5934130482a`；默认 `chapter_events_replace` JobHandler 复用 P2-02 checkpoint 与 P2-03 事件合同；首版限制单任务 1～3 个不重复章节；prepared chapterId 防串写；真实 Gutenberg《红楼梦》3 章 6 事件门禁在第二章 checkpoint 后硬退出 91，租约到期恢复后 `succeeded/attempts=2/processed=1/reused=2`；协作取消零 checkpoint 且旧事件不变；重启后 `limit=1` 分页读完六类事件并重算证据 SHA-256。全量三门、server 44、web 6、既有 P2 恢复 gate 与新真实门禁 GREEN。 |
| 2026-07-24 Phase 2 完成 | 一次独立综合门禁 Review PASS，绑定 Ledger `14c31c3` 与 P2-04 冻结 revision，同时覆盖 P2-04 Task 与 Phase 2，不重复双 Review；冻结业务提交 `b0f434e`，集成 `dev` 为 `86ce213`；集成态全量三门/diff、server 44、web 6、P2 checkpoint 恢复 gate 与真实章节任务 gate 全部 GREEN；释放 P2-04 写租约并以宽切片进入 P3-01。 |
| 2026-07-24 P3-01 candidate | `git-index-tree-v1:86ce213515c4b2d598651a5feb88200cd22f4672:ba09275959aca1349712f0dce86670355ba38144`；migration v5 新增 series/episode/source 快照三表；单集序号从 1 开始、目标时长 180～300 秒；客户端只提交 `sourceEventIds`，服务端从已验证章节事件复制精确范围与哈希；跨书引用在事务前拒绝，episode 与证据快照原子替换；4 个最小 API；真实 Gutenberg《红楼梦》3 章 6 类事件建立 240 秒单集，重启后读回 6 份证据并逐段复算 SHA-256，重复 PUT 不复制。全量三门、server 49、web 6、真实 gate GREEN。 |
| 2026-07-24 P3-01 完成 | 独立 Spec Review 与 Code Quality Review 均 PASS，绑定 Ledger `6341496` 与冻结 revision；两者独立复算 8 个 staged 路径并复跑全量三门和真实单集 gate；冻结业务提交 `af2ee12`，集成 `dev` 为 `b83f774`；集成态全量三门/diff、server 49、web 6、真实单集 gate GREEN；释放写租约并进入 P3-02。 |
| 2026-07-24 P3-02 candidate | `git-index-tree-v1:b83f77410b93aa6f1d0fe44c6ef13e767b40685d:c1c6c7cc34db9ab7ccd11d8c54fc20fcb2af7355`；migration v6 新增稿件版本与来源快照两表；忠实稿/包装稿仅追加不可变版本，规范 JSON+SHA-256，同内容幂等、变化内容按 kind 递增；包装稿必须引用同分集忠实稿且来源不得超出父稿；每段必须引用 episode 来源并复制快照；POST/GET 最小 API。真实《红楼梦》分集建立 faithful v1、packaged v1、faithful v2，重复 POST 幂等，重启后旧内容/hash/父链不变且逐段来源 SHA-256 通过。全量三门、server 53、web 6、真实 gate GREEN。 |
| 2026-07-24 P3-02 首轮 Review | Spec PASS；Code Quality FAIL，均绑定 Ledger `c4f7dae` 与首版 revision。双连接可在写锁前同时漏过幂等查询，随后分别写入同 hash 的 v1/v2，导致稿件身份分裂；首版 revision 失效，只修复锁内复查并补双连接回归。 |
| 2026-07-24 P3-02 第二版 candidate | `git-index-tree-v1:b83f77410b93aa6f1d0fe44c6ef13e767b40685d:aeaee1d97291f3b716fd8ff5b00a350125d0c7f5`；幂等查找移入 `BEGIN IMMEDIATE` 写锁，SQLite 连接设置 5 秒 busy timeout；新增两个独立子进程同时提交相同忠实稿的回归，二者返回同 ID、同 v1，数据库仅 1 行。其余稿件合同与真实门禁保持不变；全量三门、server 54、web 6、真实 gate GREEN。 |
| 2026-07-24 P3-02 第二轮 Review | 独立 Spec Review PASS、独立 Code Quality Review PASS，均绑定 Ledger `8670066396f55211a939245877595bc8bb33d2ca` 与第二版 revision；独立复验锁内幂等、双连接同 ID/v1/单行、全量三门及真实稿件 gate，无阻断 findings。 |
| 2026-07-24 P3-02 完成 | 冻结业务提交 `b0259dd`，集成 `dev` 为 `eecdde239e3521f5f5cdfcb162a4f6eb4ca36303`；集成态 typecheck/test/build/diff GREEN，server 54/54、web 6/6；真实《红楼梦》2,663,455 bytes、3 章、6 事件、3 稿件版本、幂等 POST 与重启查询 gate GREEN；释放 P3-02 租约并进入 P3-03。 |
| 2026-07-24 P3-03 candidate | `git-index-tree-v1:01b34531a84cf7150e407be20736f6784f143baa:7b078e0190daf74f63ee03b096e285be8cf20a48`；migration v7 只新增追加式批准事件表；同分集包装稿可批准/撤回，`expectedRevision` 在 `BEGIN IMMEDIATE` 写锁内比较；统一生产 guard 返回批准稿 ID/hash/revision，未批准或撤回时以 409 阻断语音与图片生产。全量三门、server 56、web 6、真实批准/撤回/重启硬门 gate GREEN。 |
| 2026-07-24 P3-03 完成 | 独立 Spec Review 与 Code Quality Review 均 PASS，绑定 Ledger `0b41f559741418b99eb24ca5df42596f564f6269` 和冻结 revision，无阻断 findings；冻结业务提交 `94703a1`，集成 `dev` 为 `7e46d8836a01901a547f1f55d1c8adfc5007a1dc`；集成态全量三门、server 56/56、web 6/6、真实批准/撤回/重启硬门 gate GREEN；释放 P3-03 并进入 P3-04。 |
| 2026-07-24 P3-04 candidate | `git-index-tree-v1:9563e190bcde028ff55bfdc2bd89b3206dc90e94:0f281fa651c85e8f1a5d084c5497e8dc799c26d8`；只修改真实 P3 gate，将 faithful/packaged 稿扩展为 8 段完整叙事，最终批准包装稿 1,139 字，按每秒 4 字保守估算 284.75 秒；每段引用 6 份真实事件证据之一，批准/撤回/重新批准后重启仍只放行最终包装稿。全量三门、server 56、web 6、真实 gate GREEN；估算只用于 Phase 3 文本量级，Phase 4 仍以真实 TTS/ffprobe 为准。 |
| 2026-07-24 P3-04 / Phase 3 完成 | 单次独立综合 Review PASS，绑定 Ledger `84144575adb0e6e24862d47dc0c220c48e3c45cb` 与冻结 revision，同时覆盖 Spec、Code Quality、P3-04 和 Phase 3 阶段门禁，无阻断 findings；冻结业务提交 `516cce9`，集成 `dev` 为 `bbd7953a17a289ba7327591354a23f8932c697d1`；集成态全量三门、server 56/56、web 6/6、真实 P3 gate GREEN；Phase 3 complete，进入 P4-01。 |
| 2026-07-24 P4-01 candidate | `git-index-tree-v1:08fa14e6dbc60d42f0d415b686c6368a71a5865c:9a2cc8e5a171501490d5b4910fde54ff445bba52`；只实现一个 Windows PowerShell `System.Speech` 调用函数，无接口/工厂/注册表和新增依赖；正文经 UTF-8 stdin，voice/rate/批准稿身份进入 SHA-256，输出同目录唯一临时 WAV，成功后 rename，失败/取消清理。全量三门、server 57、web 6、真实 WAV/ffprobe gate GREEN。 |
| 2026-07-24 P4-01 首轮 Review | Code Quality FAIL，绑定 Ledger `b06d62a0f7b02f7f62eb6d0dc88c32984832962f` 与首版 revision：AbortSignal 的 child `error` 可能早于 `close`，当前 Promise 提前拒绝并清理仍被 PowerShell 占用的临时 WAV，Windows 下可由 EPERM/EBUSY 覆盖取消错误并泄漏文件。首版 revision 失效，只修等待 close 后清理并补固定时序回归。 |
| 2026-07-24 P4-01 首轮 Spec Review | FAIL，绑定同一 Ledger/revision：PowerShell 5.1 的 `[Console]::In` 未设置 UTF-8，Node 写入的中文 UTF-8 可按系统控制台代码页误解码；有效 WAV 不等于朗读正文正确。只在读取前设置 `[Console]::InputEncoding` 并补 code-unit 回归。 |
| 2026-07-24 P4-01 第二版 candidate | `git-index-tree-v1:08fa14e6dbc60d42f0d415b686c6368a71a5865c:00b8486e9d17fc04df622e954464100fcb0ef850`；PowerShell 读取前显式设置 UTF-8，真实 code-unit 回归覆盖中文正文；成功 spawn 后 `error` 只记录，统一等待 `close` 再清理，取消测试先确认临时 WAV 已被创建/持有再 abort。全量三门、server 57、web 6、真实正确中文 WAV gate GREEN。 |
| 2026-07-24 P4-01 完成 | 第二轮 Spec/Code Quality Review 均 PASS，绑定 Ledger `bb6b72c065e52367ce722e6f60c7139bb65efb01` 与第二版 revision；首轮 UTF-8 与取消清理 findings 均关闭。冻结业务提交 `240e133`，集成 `dev` 为 `284cfbb1fcc25b4948a531f23c6857222a77f9bf`；集成态全量三门、server 57/57、web 6/6、真实中文 WAV gate GREEN；进入 P4-02。 |
| 2026-07-24 P4-02 candidate | 按用户“复用代码、边界不细拆、减少 Review”口径冻结一个宽切片：migration v8 仅两表；默认批准门禁 + JobWorker；每段复用 P4-01 System.Speech；ffprobe 实测时长；累计 cue 与 SRT/ASS；取消零登记；内容寻址复用。revision `git-index-tree-v1:09825013d318b163347fa5b133e6238da587d34a:a7dc01327e9ab5c6dcdefd8ec7b42146b0dd320f`；全量三门/diff、server 60/60、web 6/6、真实 20,506ms 门禁 GREEN；只做一次独立综合 Review。 |
| 2026-07-24 P4-02 首轮综合 Review | FAIL，绑定 Ledger `6fe6e41b54e01cbf904f1c84f1b45bb54a2c1a94` 与旧 revision。P1：handler 先独立提交 audio/cue，后空 writer 提交 checkpoint；Reviewer 故障注入确认 checkpoint 抛错后残留 segments=1/cues=1/checkpoints=0。旧 candidate 失效，只开放最小原子性修复。 |
| 2026-07-24 P4-02 第二版 candidate | 仅修首轮 P1：audio_segments/subtitle_cues DML 改由既有 `commitCheckpoint` writer 排队，与租约/取消校验及 checkpoint 在同一事务提交；新增 `lease expired` 故障注入，领域表零新增。revision `git-index-tree-v1:09825013d318b163347fa5b133e6238da587d34a:1aa3301577e67100cbf002047f3381aa03ba746b`；全量三门/diff、server 60/60、web 6/6、真实 20,506ms 门禁 GREEN。 |
| 2026-07-24 P4-02 第二轮综合复审 | FAIL，绑定 Ledger `a0c750595cda0176f5550502358c40697df6609b` 与第二版 revision。首轮 P1 已关闭；新 P1：最终批准复核在 `commitCheckpoint` 取写锁前，外部撤回可在间隙提交后仍登记旧稿产物。只开放把复核移入 writer 同一事务和一条撤回竞态回归。 |
| 2026-07-24 P4-02 第三版 candidate | 把最终批准 identity/revision 复核移入 `commitCheckpoint` writer 开头，使租约/取消、批准状态、audio/cue DML 与 checkpoint 共享同一写事务；新增 commit 边界前撤回回归，audio/cue/checkpoint 均零新增。revision `git-index-tree-v1:09825013d318b163347fa5b133e6238da587d34a:145f46172035ea78e9462e52d445f9ee3da17d99`；全量三门/diff、server 60/60、web 6/6、真实门禁 GREEN。 |
| 2026-07-25 P4-02 完成 | 第三版一次独立综合复审 PASS，绑定 Ledger `1b912c051fc46245b6ab2a6eeb5e84ae8b49c72e` 与冻结 revision，两项原子性 findings 均关闭且无新 findings。冻结业务提交 `b47fb73`，集成 `dev` 为 `4fa622b`；集成态全量三门/diff、server 60/60、web 6/6、真实 20,506ms 音频时间轴门禁 GREEN；释放 P4-02 并进入 P4-03。 |
| 2026-07-25 P4-03 / Phase 4 完成 | 一次独立综合 Review PASS，绑定 Ledger `105fee0cbfc8366e50c44455dfa322f5237227e3` 与 revision `git-index-tree-v1:dd453136a131948fdb6660377c4da3dee4835137:89716b2527c3bdc04d30e289fa9d69be46ee6635`，同时覆盖 Task 与 Phase 4，无 findings。冻结业务提交 `0fb7faf`，集成 `dev` 为 `eaa6c32`；集成态全量三门/diff、server 61/61、web 6/6 和三个 Phase 4 gate GREEN；最终 MP4 位于 `D:\code3\Narralume\data\gates\p4-placeholder\episodes\p4_episode\video\4b9cba5e248fa8d6b51b5f0830817c1e3ddd9350f20c427c83cc59b349e27ef9.mp4`，220,960ms、3,102,618 bytes、1080×1920@25、H.264+AAC、SHA-256 `4ee48037bd54a827ff33f40d07eb8066e5267107f989c3f5561f5105b8e17f4d`、重启复用。 |

## 决策与剩余风险

- 2026-07-24：只移植 MuseDock Delivery Loop 方法，未复制业务代码或增加运行时依赖。
- 2026-07-25：用户授权后续生图、多模态和配音模型真实测试只读 `D:\code3\MuseDock` 中已有的本机配置与调用合同并直接执行，不因此普通配置问题暂停提问；MuseDock 仍不得成为 Narralume 运行时依赖，密钥/账号不得进入代码、提交、Ledger 或输出。
- Node 22 内置 `node:sqlite` 在当前运行时可用性与警告状态由 P1-01 的可执行测试确认；若不满足再评估已安装能力，不预先新增 ORM。
- 仓库当前没有真实输入、TTS provider 凭据或候选图片。前者优先从用户已放入工作区且合法可用的素材发现；确需用户提供或作主观选择时，按停止条件记录真实 blocker。
