# Narralume Phase 1-7 静态实施计划

> 本文件只描述范围、依赖、验收方法和建议提交边界，不记录实时状态。唯一动态状态见 [`phase-1-7-delivery-ledger.md`](phase-1-7-delivery-ledger.md)。

## 通用 Task Loop

每个 Task 都执行：确认分支/工作区 → 读取真实调用链 → 写最小失败测试 → 最小实现 → 相关测试 → `typecheck/test/build` → 真实工作流验收 → 冻结 candidate revision/tree → Coordinator 冻结控制提交 → 独立 Spec Review 与 Code Quality Review → 修复后重新冻结复审 → 中文业务提交 → Coordinator 中文完成控制提交 → 推送 `origin/dev`。

业务 Task 在独立、初始 clean 的 Worker worktree 冻结，且写租约始终排除 Delivery Ledger。冻结采用 `git-index-tree-v1:<base_commit>:<tree_hash>`：将允许路径完整加入 index，要求无租约外改动、无未暂存或未跟踪文件，并记录 `git diff --cached --name-status` 与 `git write-tree`。Coordinator 在 `dev` 只修改 Ledger，先把 revision、changed paths、owner 和状态写成冻结控制提交。两名 Reviewer 从该控制提交读取权威 revision，在 Worker worktree 复算 HEAD、changed paths 和 `git write-tree`，Verdict 必须带 `reviewed_ledger_commit` 与 `reviewed_revision`。任何代码、index 或 Ledger 冻结记录变化都会使旧 Review 失效。业务提交完成后，Coordinator 再以独立完成控制提交登记业务 SHA、验证与 Review 结论；控制提交自己的 SHA 由 Git 历史定位，不写入自身。

`CTRL-01` 是唯一 bootstrap 例外：Ledger 尚不存在，先以用户指定提交信息提交完整控制面，把该提交及其 tree 作为 `git-commit-tree-v1:<commit>:<tree>` 的不可变 candidate；独立 Reviewer 直接复算该 commit tree。通过后由下一条 Ledger 控制提交登记 candidate、Verdict 和完成状态。此例外只用于首次创建 Ledger，后续 Task 一律使用上述非自引用协议。

## Phase 1：书库与章节

- **P1-01 数据根与 SQLite 基线**：配置本地数据根、直接 SQL 迁移、连接生命周期、书籍/章节表与重启查询。优先使用 Node 22 内置 `node:sqlite`，不引入 ORM。
- **P1-02 TXT 流式导入**：原始请求流写临时文件并计算 SHA-256；限制大小、文件名净化、原子认领、重复导入幂等和中文错误边界。
- **P1-03 编码与章节索引**：UTF-8 BOM/严格 UTF-8、GB18030（覆盖 GBK/CP936）检测；流式解码并记录原始字节偏移、章节标题、顺序、重复编号、字符数与内容哈希。
- **P1-04 书库 API 与最小 UI**：书库列表、导入状态、章节分页、原文切片；前端提供中文 loading/成功/失败/中断状态并防重复提交。
- **P1-05 真实大文本门禁**：使用真实长篇 TXT 验证内存边界、重启读取、偏移切片、重复导入和重复章节编号。

## Phase 2：任务与章节事件

- **P2-01 持久化任务状态机**：jobs 表、单 Worker、租约/续租/回收、进度、错误、重试和取消请求。
- **P2-02 checkpoint 与恢复**：输入哈希、阶段 checkpoint、原子结果写入；进程重启只恢复未完成范围。
- **P2-03 章节事件合同**：人物、地点、道具、因果、揭示、悬念及精确原文范围；先支持人工/确定性录入，再接模型适配器。
- **P2-04 真实章节任务门禁**：真实章节执行、取消、故障注入、重启恢复、幂等与事件查询。

## Phase 3：分集与改编

- **P3-01 故事弧与分集证据**：series/episode/source 表和 API，引用稳定章节及精确范围。
- **P3-02 稿件版本**：忠实稿、包装稿、批准稿不可变版本；差异和来源证据可查询。
- **P3-03 人工批准闸门**：批准/撤回状态、并发保护；未批准时 TTS 和图片任务硬阻断。
- **P3-04 真实分集验收**：从真实章节形成 3～5 分钟分集及完整可追溯稿件。

## Phase 4：TTS 与字幕

- **P4-01 TTS provider 边界**：本地/外部命令适配、输入哈希、中文错误和可取消执行；密钥能力只在实际 provider 需要时请求。
- **P4-02 真实音频时间轴**：`ffprobe` 时长、音频段、字幕 cue、SRT/ASS 导出和下游失效规则。
- **P4-03 占位视频**：黑底或占位图 9:16 视频，真实音频、ASS 字幕和 3～5 分钟验收。

## Phase 5：资产与图片

- **P5-01 资产合同**：主资产、状态资产、别名及稳定关系。
- **P5-02 候选图与来源**：上传/生成结果登记、哈希、来源、审核状态和原子文件管理。
- **P5-03 视觉段显式绑定**：旁白范围、时间、运动参数、候选选择和唯一显式关系。
- **P5-04 联系表与真实审核**：生成样片资产联系表并完成候选人工选择；不扩展为无限画布。

## Phase 6：FFmpeg 成片

- **P6-01 唯一 9:16 模板**：静图 cover、可校准微动、淡化和 ASS 字幕，使用系统 `ffmpeg`。
- **P6-02 分片与身份**：1～3 分钟 render chunk、输入哈希、原子输出、`ffprobe` 验证和精确定向失效。
- **P6-03 concat 与导出清单**：安全 concat、音视频流/分辨率/时长验证、最终清单和校验哈希。
- **P6-04 真实渲染恢复门禁**：故障注入后只重做失效分片，非目标产物字节保持不变。

## Phase 7：真实样片与项目包

- **P7-01 真实样片 E2E**：真实原文 → 证据 → 批准稿 → TTS/字幕 → 资产/视觉段 → 分片 → 最终 9:16 视频。
- **P7-02 可恢复项目包**：备份数据库和全部相对路径资产，生成版本化 manifest 与 SHA-256；拒绝路径逃逸和缺失文件。
- **P7-03 空目录恢复演练**：恢复到新的数据根，查询原文证据并重新导出，记录恢复命令和产物。
- **P7-04 最终验收**：全量 `typecheck/test/build`、真实工作流、独立双 Review、指标与剩余风险归档。

## 明确不扩张

Phase 1-7 不包含整书一键生产、20 分钟首片、角色动画、口型同步、AI 视频、无限画布、多层 Agent、向量/图数据库、Electron、多用户云队列、多模板或自动爆款评分。只有现有方案被真实数据证明不足时，才按 `project-design.md` 的升级条件另立任务。
