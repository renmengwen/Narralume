# Narralume 文档索引

## 权威层级

发生冲突时按以下顺序解释：

1. 用户当前明确指令与根目录 [`AGENTS.md`](../AGENTS.md)；
2. [`project-design.md`](project-design.md)：产品边界、技术决策、Phase 目标和最终验收标准；
3. [`loop/phase-1-7-delivery-ledger.md`](loop/phase-1-7-delivery-ledger.md)：Phase 1-7 唯一动态状态源；
4. [`loop/phase-1-7-implementation.md`](loop/phase-1-7-implementation.md)：静态任务拆分、依赖和验证方法，不记录实时状态；
5. [`source-provenance.md`](source-provenance.md)：外部参考、复制与移植来源；
6. `research/`：历史研究材料，仅在核对原始结论时读取，不作为当前实施状态。

## 开始或恢复工作的阅读顺序

1. 读取 `AGENTS.md` 和本文件；
2. 读取 `project-design.md` 的固定产品边界与 Phase 验收标准；
3. 读取 Delivery Ledger 的“当前恢复入口”、写租约、Task 和 Requirement 行；
4. 只读取当前 Task 对应的 implementation 小节与相关代码；
5. 需要核对外部来源时再读取 `source-provenance.md` 和指定研究文档。

聊天记录、Review 对话、终端日志和派生摘要都不能替代 Delivery Ledger。详细证据保存在 Git 提交、测试文件和产物路径中，Ledger 只保存可重新定位的索引。
