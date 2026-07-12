# ctx-tool-output-prune 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-12
> 关联方案 doc：`.codestable/features/2026-07-12-ctx-tool-output-prune/ctx-tool-output-prune-design.md`

## 1. 接口契约核对

**接口示例逐项核对**：
- [x] `pruneToolOutputs` / `capToolResultContent` / `unwrapToolContent`（`context/prune-tool-outputs.ts`）：与 design 行为一致
- [x] 不删除 tool 消息，只改 `content`（单测 E2）
- [x] 重复 cap 不叠前缀（review 修复后单测）

**名词层现状→变化**：
- [x] 新增剪枝模块；`runToolEnabledConversation` 接线；复用 `estimateTokens` / ContextPolicy

**流程图**：
- [x] executeTool → ingest cap → push → pruneToolOutputs → 下一轮 chatWithTools（`llm-service.ts` grep 确认）

## 2. 行为与决策核对

**需求摘要**：
- [x] loop 内廉价剪枝；超阈值压旧 tool；旁路可用

**明确不做**：
- [x] 无 LLM summarize 调用
- [x] 未改 WriteIntegrity / claim 逻辑（仍旧 hasWriteToolCall）
- [x] 未改 `compaction.ts` 压缩算法正文
- [x] 未改 `provider.ts`

**关键决策**：
- [x] 头保护 system(+首 user)；尾按 `tailTokens`；旧 tool 留尾截断
- [x] safety 时 stale≤120
- [x] chapter/profile/init 均传 `contextMode`

**挂载点**：
- [x] `context/prune-tool-outputs.ts` 导出
- [x] `runToolEnabledConversation` 调用
- [x] `{mode}.chat.tool_prune` 日志
- [x] 反向 grep：无清单外生产引用（仅 context + llm-service + 测试）
- [x] 拔除沙盘：去掉 prune 接线 + 模块即可卸载；无路由/UI

## 3. 验收场景核对

- [x] N1 单条封顶 — 单测
- [x] N2 超阈值剪旧 — 单测
- [x] N3 disabled 旁路 — 单测
- [x] B1 尾部保护 — 单测（middle≤stale，recent 完整）
- [x] safety 路径 — 单测
- [x] E1/E2 接线与条数不变 — grep + 单测

（无前端改动）

## 4. 术语一致性

- [x] pruneToolOutputs / ingest cap / stale / loopCompressDisabled 与 design 第 0 节一致
- [x] 未与 CLI `resolveContext` 冲突

## 5. 架构归并

- [x] 更新 `ARCHITECTURE.md`：Loop 内 tool 剪枝（Hermes Phase 1）已落地；摘要未上

## 6. requirement 回写

- [x] `requirement` 空 + 内部能力 → 无 requirement 回写

## 7. roadmap 回写

- [x] `ctx-tool-output-prune` → `done`，主文档同步

## 8. attention.md 候选

- [x] 无新增必记项

## 9. 遗留

- 后续：`ctx-loop-summarizer`（Hermes 摘要）、`ctx-write-claim-guard`
- 已知：仅 ingest 封顶时 `triggered` 也标 `prune`（低优先级可分计数）
- 顺手发现：无未处理项
