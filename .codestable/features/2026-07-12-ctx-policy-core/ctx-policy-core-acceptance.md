# ctx-policy-core 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-12
> 关联方案 doc：`.codestable/features/2026-07-12-ctx-policy-core/ctx-policy-core-design.md`

## 1. 接口契约核对

**接口示例逐项核对**：
- [x] `resolveContextPolicy("chapter")`（`apps/service/src/context/resolve-context-policy.ts`）：默认输入 → chapter 硬约束快照 → 与 design 示例一致（单测 N1）
- [x] env 覆盖 TOTAL / ratio → 与示例一致（N2/N3）；非法 / 颠倒 → 回落（B1/B2）

**名词层"现状 → 变化"逐项核对**：
- [x] 新增 `ContextPolicy` 等类型 → `context/types.ts`
- [x] 新增 `resolveContextPolicy` → `context/resolve-context-policy.ts`
- [x] 无运行时接线 → grep 确认仅 context + 测试引用

**流程图核对**：
- [x] `mode+env → resolveContextPolicy → ContextPolicy` → 代码纯函数路径一致

## 2. 行为与决策核对

**需求摘要**：
- [x] 政策库可解析 chapter 硬约束；对话行为未变（未改 llm-service / compaction）

**明确不做**：
- [x] 未改 `runChapterAssistant` / `runToolEnabledConversation` / `compaction.ts`
- [x] 未实现 LoopCompressor / WriteIntegrity
- [x] 未改 `provider.ts`、无第三方依赖
- [x] `INKOS_COMPACTION_*` 仍在 `compaction.ts`

**关键决策**：
- [x] 落在 `apps/service/src/context/`
- [x] `chapter_body` / `story_longform` 不预塞；`path_map` 预塞；`story_state` maxChars 1500

**编排层**：
- [x] 无 chat 主流程插入；纯库调用

**流程级约束**：
- [x] ratio 颠倒回落默认对；非法 TOTAL 不抛未捕获异常

**挂载点**：
- [x] `INKOS_CTX_*` + `INKOS_DISABLE_LOOP_COMPRESS` → `resolve-context-policy.ts`
- [x] `context/index.ts` barrel
- [x] `__tests__/context-policy.test.ts`
- [x] 反向 grep：无清单外生产引用
- [x] 拔除沙盘：删除 `context/` + 测试即卸载；无路由/UI/compose 残留

## 3. 验收场景核对

- [x] **N1** chapter 硬约束 — 单测通过
- [x] **N2** TOTAL_TOKENS 覆盖 — 单测通过
- [x] **N3** ratio 覆盖 — 单测通过
- [x] **B1** ratio 颠倒回落 — 单测通过
- [x] **B2** 非法 TOTAL 回落 — 单测通过
- [x] **E1** typecheck 通过；旧路径未改
- [x] **E2** 生产路径未 import — grep 确认

（无前端改动，跳过浏览器验证）

## 4. 术语一致性

- ContextPolicy / ChatContextMode / resolveContextPolicy / PrestuffRule：代码命名与 design 第 0 节一致 ✓
- 未引入与 CLI `resolveContext` 同名函数 ✓

## 5. 架构归并

- [x] `architecture/ARCHITECTURE.md`：写入 ContextPolicy 术语、`src/context/` 模块索引、政策与协议层分离决定、chapter 硬约束

## 6. requirement 回写

- [x] `requirement` 空 + 本 feature 为内部政策库（用户不可感，待 prestuff 接线）→ **无 requirement 回写**

## 7. roadmap 回写

- [x] `context-management-v2` / `ctx-policy-core` → items.yaml `status: done`，主文档清单同步

## 8. attention.md 候选盘点

- [x] 候选 1：本机 shell 无全局 `pnpm` 时，可在 `apps/service` 用 `./node_modules/.bin/vitest` / `tsc` 跑测（实现期踩过）——是否 `cs-note` 由用户定

## 9. 遗留

- 后续：`ctx-chapter-prestuff`（最小闭环接线）
- 已知限制：policy 尚未影响任何运行时对话
- 顺手发现：无
