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

每个 Task 必填：依赖、Owner/写租约、candidate revision/tree、冻结控制提交、Spec Review、Code Quality Review、验证证据、业务提交 SHA、剩余风险和恢复动作。未产生的字段使用 `-`，不得用推测填充。控制提交自己的 SHA 由 Git 历史定位，不写入自身，避免自引用。

普通业务 Task 的写租约必须排除本 Ledger；Coordinator 在 `dev` 串行完成 Ledger 冻结控制提交，Reviewer Verdict 必须绑定 `reviewed_ledger_commit` 和 `reviewed_revision`。`CTRL-01` 首次创建 Ledger 时使用一次性 bootstrap：先提交完整控制面，将不可变 commit/tree 作为 candidate；双 Review 后由下一条控制提交登记结果。之后不得再次使用该例外。

## 当前恢复入口

- 当前分支：`dev`
- 当前 HEAD：`9df94e2`（P1-03 已集成；本控制提交后以 Git 历史定位最新 HEAD）
- 工作区：clean。
- 最近验证：2026-07-24，Node `v22.22.3`、FFmpeg/FFprobe `8.1.1`；`npm run typecheck`、`npm test`、`npm run build` 通过。
- 当前 Task：`P1-04`
- 唯一下一动作：读取当前 API/UI，先写书库列表、章节分页、原文切片和中文上传状态的失败测试，再实现最小查询与界面闭环。

## 当前写租约

| Task | Owner | Worktree / branch / base | 允许路径 | 状态所有权 | 排他资源 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| P1-04 | Coordinator | `D:\code3\Narralume-worktrees\P1-04` / `codex/p1-04` / `9df94e2` | 待读取调用链后收窄为查询 route/test 与最小 App UI | 书库/章节/原文切片查询、前端异步状态 | 测试临时目录、Worker Git index、前端构建 | `implementing` |

## Phase 依赖

`Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7`。Phase 状态从 Task/Requirement 派生，不单独维护手写进度。

## Task DAG 与唯一状态

| Task | 状态 | 依赖 | Owner / 写租约 | Candidate revision / tree | 冻结控制提交 | Spec Review | Code Quality Review | 验证证据 | 业务提交 SHA | 剩余风险 / 恢复动作 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CTRL-01 控制面初始化 | `complete` | Phase 0 | Coordinator / 已释放 | `git-commit-tree-v1:428af35a9e015a2f39431f12ab7709074fc5f5cb:1f9ac40cd2c35557cbeedb46fe13d3a436695000` | bootstrap candidate 即 `428af35` | PASS，绑定同一 revision | PASS，绑定同一 revision | Phase 0 三门通过；commit/tree 复算；`git diff --check` 通过 | `428af35a9e015a2f39431f12ab7709074fc5f5cb` | 无；进入 P1-01 |
| P1-01 数据根与 SQLite 基线 | `complete` | CTRL-01 | Coordinator / 已释放 | `git-index-tree-v1:e6452d35788543cadd5908da60061e851a3a7dc7:15b1cb4f3667a1afaf8b9c3d3712c06f35d42447` | `72438d0` | PASS，绑定 `72438d0`/第二版 revision | PASS，绑定 `72438d0`/第二版 revision | 集成态全量 `typecheck/test/build` GREEN；3 项 server tests；Windows 失败后文件删除 GREEN | `154a391` | Node 22 SQLite 实验性警告；进入 P1-02 |
| P1-02 TXT 流式导入 | `complete` | P1-01 | Coordinator / 已释放 | `git-index-tree-v1:154a391eb1795aeebff2260f5e6a1eae2b0ea3de:2a74235c0e3c98d26ad3c65a46068564123730d5` | `eeced89` | PASS，绑定第三版 revision | PASS，绑定第三版 revision | 集成态 8 项 server tests；全量三门 GREEN；并发/失败清理/fsync | `8884491` | Node SQLite 实验性警告；进入 P1-03 |
| P1-03 编码与章节索引 | `complete` | P1-02 | Coordinator / 已释放 | `git-index-tree-v1:8884491a865b9ed334c2ca493621c7e93e4f51da:325e71d7da8923bf65b3c8bedd96457c8325d063` | `8110fe7` | PASS，绑定第二版 revision | PASS，绑定第二版 revision | 集成态 12 项 server tests；全量三门 GREEN；编码/内存/事务真实探针 | `9df94e2` | 1 MiB 单行门；进入 P1-04 |
| P1-04 书库 API 与最小 UI | `implementing` | P1-03 | Coordinator / `codex/p1-04` 当前租约 | - | - | - | - | - | - | 先写失败测试 |
| P1-05 真实大文本门禁 | `queued` | P1-04 | - | - | - | - | - | - | - | - |
| P2-01 持久化任务状态机 | `queued` | P1-05 | - | - | - | - | - | - | - | - |
| P2-02 checkpoint 与恢复 | `queued` | P2-01 | - | - | - | - | - | - | - | - |
| P2-03 章节事件合同 | `queued` | P2-02 | - | - | - | - | - | - | - | - |
| P2-04 真实章节任务门禁 | `queued` | P2-03 | - | - | - | - | - | - | - | - |
| P3-01 故事弧与分集证据 | `queued` | P2-04 | - | - | - | - | - | - | - | - |
| P3-02 稿件版本 | `queued` | P3-01 | - | - | - | - | - | - | - | - |
| P3-03 人工批准闸门 | `queued` | P3-02 | - | - | - | - | - | - | - | - |
| P3-04 真实分集验收 | `queued` | P3-03 | - | - | - | - | - | - | - | - |
| P4-01 TTS provider 边界 | `queued` | P3-04 | - | - | - | - | - | - | - | 真实 provider 若需密钥时再触发用户阻塞 |
| P4-02 真实音频时间轴 | `queued` | P4-01 | - | - | - | - | - | - | - | - |
| P4-03 占位视频 | `queued` | P4-02 | - | - | - | - | - | - | - | - |
| P5-01 资产合同 | `queued` | P4-03 | - | - | - | - | - | - | - | - |
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
| REQ-P1-04 | `implementing` | SQLite 重启后书库/章节/切片查询与最小中文 UI | P1-01、P1-04 |
| REQ-P1-05 | `pending` | 真实大文本内存、幂等、偏移和重启门禁 | P1-05 |
| REQ-P2-01 | `pending` | 持久化 Worker、租约、重试、取消与精确定向恢复 | P2-01、P2-02、P2-04 |
| REQ-P2-02 | `pending` | 结构化章节事件及精确原文证据 | P2-03、P2-04 |
| REQ-P3-01 | `pending` | 故事弧、分集和精确来源证据 | P3-01、P3-04 |
| REQ-P3-02 | `pending` | 忠实/包装/批准稿不可变版本和人工硬闸门 | P3-02、P3-03 |
| REQ-P4-01 | `pending` | 真实 TTS/ffprobe 时间轴、SRT/ASS 和占位视频 | P4-01～P4-03 |
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

## 决策与剩余风险

- 2026-07-24：只移植 MuseDock Delivery Loop 方法，未复制业务代码或增加运行时依赖。
- Node 22 内置 `node:sqlite` 在当前运行时可用性与警告状态由 P1-01 的可执行测试确认；若不满足再评估已安装能力，不预先新增 ORM。
- 仓库当前没有真实输入、TTS provider 凭据或候选图片。前者优先从用户已放入工作区且合法可用的素材发现；确需用户提供或作主观选择时，按停止条件记录真实 blocker。
