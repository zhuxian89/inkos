---
doc_type: feature-design
feature: 2026-07-12-ctx-policy-core
requirement:
roadmap: context-management-v2
roadmap_item: ctx-policy-core
status: approved
summary: 落地 ContextPolicy 类型与 resolveContextPolicy，固化 chapter 默认规则（单测），不接线对话运行时
tags: [context, policy, chapter-chat, roadmap]
---

# ctx-policy-core design

## 0. 术语约定

| 术语 | 定义 | 防冲突 |
|---|---|---|
| **ContextPolicy** | 某一 `ChatContextMode` 下的预算 + 预塞规则快照 | 新概念；与 CLI `resolveContext`（项目根解析）无关 |
| **ChatContextMode** | `chapter` \| `profile` \| `init` | 对齐现有三类 tool chat，非 pipeline agent |
| **PrestuffRule / blockId** | 允许进首包 context 的内容块标识 | 本 feature 只定义规则与默认值，不实现拼装 |
| **resolveContextPolicy** | 从 mode + env 解析出不可变 ContextPolicy | 勿与 `packages/cli` 的 `resolveContext` 混淆 |
| **INKOS_CTX_*** | v2 预算/阈值环境变量 | 与旧 `INKOS_COMPACTION_*` 并存；本 feature 不读旧变量 |

## 1. 决策与约束

### 需求摘要

- **做什么**：在 service 侧新增独立 `context` 模块，提供 roadmap §4.1 契约的类型与 `resolveContextPolicy`；chapter 默认规则满足硬约束；单测锁死默认与 env 覆盖。
- **为谁**：后续 `ctx-chapter-prestuff` / LoopCompressor / Bridge 的唯一政策入口。
- **成功标准**：调用 `resolveContextPolicy("chapter")` 得到符合硬约束的对象；env 覆盖生效；无对话运行时行为变化。
- **明确不做**：
  - 不改 `runChapterAssistant` / `runToolEnabledConversation` / `compaction.ts` 接线
  - 不实现 LoopCompressor / WriteIntegrity
  - 不改 `provider.ts`、不嵌第三方
  - 不删、不迁移 `INKOS_COMPACTION_*`（归 `ctx-retire-legacy-compaction`）

### 复杂度档位

走默认档位（内部库 + 单测），无偏离。

### 关键决策

1. **落点**：新建 `apps/service/src/context/`，不往 `llm-service.ts`（1565 行）塞类型。  
2. **章节正文**：`chapter_body` → `defaultInclude: false`，`maxChars: 0`（假设，对齐 roadmap 倾向；可在 review 改为 ≤2000）。  
3. **必须预塞**：`path_map` → `defaultInclude: true`，`maxChars` 足够路径清单（建议 ≥ 4000，仅限路径类文本）。  
4. **长 story**：`story_longform`（volume_outline / character_matrix 等）→ `defaultInclude: false`，`maxChars: 0`。  
5. **短状态卡**：`story_state`（current_state 等）→ `defaultInclude: true`，`maxChars: 1500`（假设：保留最小剧情锚点；prestuff feature 可再调）。  
6. **profile / init**：提供可用默认 policy（预算同 chapter 骨架），prestuff 列表可更短；本 feature 不要求其 prestuff 语义完备。  
7. **被拒**：在 `compaction.ts` 旁加 export 冒充 ContextPolicy——拒绝，避免旧压缩与新政策耦死。

### 前置依赖

无（roadmap `depends_on: []`）。

## 2. 名词与编排

### 2.1 名词层

**现状**

- 无 ContextPolicy；预算散落在 `compaction.ts` 的 `INKOS_COMPACTION_*` + `CompactionConfig`。
- 章节预塞硬编码在 `llm-service.ts` `runChapterAssistant` 的 `contextPrompt`（正文 `slice(0, 12000)`、story 摘录等）。
- CLI 另有 `resolveContext`（项目根），与本 feature 无关。

**变化**

| 动作 | 内容 |
|---|---|
| 新增 | `ChatContextMode`, `ContextBudget`, `PrestuffRule`, `ContextPolicy` |
| 新增 | `resolveContextPolicy(mode, env?)` |
| 新增 | chapter / profile / init 默认常量（chapter 满足 roadmap 硬约束） |
| 不变 | 任何运行时调用方（本 feature 无生产接线） |

**接口示例**

```ts
// 输入 → 输出
resolveContextPolicy("chapter")
// →
{
  mode: "chapter",
  budget: {
    totalTokens: 30000,           // 可被 INKOS_CTX_TOTAL_TOKENS 覆盖
    contextTokens: 16000,
    tailTokens: 20000,
    compressPrimaryRatio: 0.5,    // INKOS_CTX_COMPRESS_RATIO
    compressSafetyRatio: 0.85,    // INKOS_CTX_SAFETY_RATIO
    maxToolResultChars: 8000,     // INKOS_CTX_MAX_TOOL_RESULT_CHARS
    staleToolResultChars: 500,    // INKOS_CTX_STALE_TOOL_RESULT_CHARS（新增建议）
  },
  prestuff: [
    { blockId: "path_map", defaultInclude: true, maxChars: 4000 },
    { blockId: "story_state", defaultInclude: true, maxChars: 1500 },
    { blockId: "chapter_body", defaultInclude: false, maxChars: 0 },
    { blockId: "story_longform", defaultInclude: false, maxChars: 0 },
  ],
}

// 错误 / 边界
resolveContextPolicy("nope" as ChatContextMode) // 实现应 throw 或类型不可达
// env 非法数字 → 回落默认并（可选）打日志；不得返回 NaN 预算
```

// 来源契约：`.codestable/roadmap/context-management-v2/...-roadmap.md` §4.1

**blockId 本 feature 锁定集合（chapter）**

- `path_map` | `story_state` | `chapter_body` | `story_longform`  
- 未列 block 不得出现在 chapter 默认 prestuff；后续 feature 要加 block 先 `cs-roadmap update` 或本 design 修订。

### 2.2 编排层

```mermaid
flowchart LR
  A[mode + env] --> B[resolveContextPolicy]
  B --> C[ContextPolicy 不可变快照]
  C -.-> D[后续 feature 消费]
```

**现状**：预算解析只存在于 `compactConversationMessages` 读 env；无统一政策对象。

**变化**：新增纯函数解析路径；**不插入**任何 chat 主流程。拓扑仍是「库调用 → 返回值」。

**流程级约束**

- 纯函数、无 I/O（除读传入的 `env` 对象）；可单测、可幂等。
- ratio 必须落在 `(0, 1]`；`compressPrimaryRatio < compressSafetyRatio`，否则回落默认对。
- `maxChars < 0` 视为非法，回落该 block 默认。
- 可观测：本 feature 不强制打日志；非法 env 回落时可 `logInfo` 一次（可选，implement 自决）。

### 2.3 挂载点清单

1. **环境变量键**：`INKOS_CTX_TOTAL_TOKENS` / `INKOS_CTX_COMPRESS_RATIO` / `INKOS_CTX_SAFETY_RATIO` / `INKOS_CTX_MAX_TOOL_RESULT_CHARS` / `INKOS_CTX_STALE_TOOL_RESULT_CHARS` / `INKOS_DISABLE_LOOP_COMPRESS`（解析预留，本 feature 只读入 budget 旁路标志若契约需要；若 roadmap 仅 compressor 用，可将 `DISABLE` 留到 compressor feature——**本 design 决定：core 解析并挂在 `ContextBudget` 扩展或 policy 顶层 `loopCompressDisabled?: boolean`**）  
   - 修订：在 `ContextPolicy` 增加 `loopCompressDisabled: boolean`（来自 `INKOS_DISABLE_LOOP_COMPRESS`），便于后续 compressor 直接读 policy。  
2. **模块入口**：`apps/service/src/context/` 导出（供后续 import）— 删掉则后续 feature 无法解析政策。  
3. **单测入口**：`apps/service/src/__tests__/context-policy.test.ts`（或 `context/*.test.ts`）— 删掉则本 feature 验收证据消失。

不挂：路由、UI、docker-compose（compose 改 env 归后续接线/退役 feature；本 feature 可不改 compose）。

### 2.4 推进策略

1. **名词骨架**：落地类型与默认常量表 → 类型检查通过  
2. **计算节点**：实现 `resolveContextPolicy`（env 覆盖 + 校验回落）→ 单测覆盖 chapter 硬约束  
3. **边界节点**：非法 env / ratio 颠倒 / 未知 mode → 单测锁定行为  
4. **导出整理**：barrel 导出公开 API → 其它包可 import（service 内）  
5. **验收对照**：核对第 3 节场景全部有测试证据  

### 2.5 结构健康度与微重构

##### 评估

- 文件级 — 本 feature **不改** `llm-service.ts` / `compaction.ts`（接线与退役留给后续）  
- 目录级 — `apps/service/src/` 约 17 个同层文件；本次新增子目录 `context/`（≥1–3 文件），是减摊平而非加剧  
- compound convention：无命中  

##### 结论：不做微重构

原因：全新目录落地；不往胖文件塞代码；无「只搬不改行为」需求。

##### 超出范围的观察

- `llm-service.ts`（1565 行）编排过重 → 建议后续 `cs-refactor` 或在 Bridge feature 抽文件时处理；**不阻塞本 feature**。

## 3. 验收契约

### 关键场景清单

| # | 输入 / 触发 | 期望可观察结果 |
|---|---|---|
| N1 | `resolveContextPolicy("chapter")` 默认 env | `chapter_body.defaultInclude === false` 且 `maxChars === 0`；存在 `path_map` 且 `defaultInclude === true`；`story_longform.defaultInclude === false` |
| N2 | 设置 `INKOS_CTX_TOTAL_TOKENS=12000` | 返回 `budget.totalTokens === 12000` |
| N3 | 设置 `INKOS_CTX_COMPRESS_RATIO=0.6` 且 `INKOS_CTX_SAFETY_RATIO=0.9` | 返回对应 ratio |
| B1 | `COMPRESS_RATIO=0.9` 且 `SAFETY_RATIO=0.5`（颠倒） | 回落默认 0.5 / 0.85（或文档化的安全对），不得原样返回颠倒值 |
| B2 | `TOTAL_TOKENS=abc` | 回落默认 total，不抛未捕获异常（或抛明确错误——实现二选一，单测锁死） |
| E1 | 运行 service 现有测试套件 | 无因本 feature 导致的回归（未接线） |
| E2 | grep 生产路径 | `runChapterAssistant` / `compactConversationMessages` **不** import `resolveContextPolicy` |

### 明确不做 — 反向核对

- 代码中本 feature 的 diff **不包含**对 `runToolEnabledConversation` 压缩逻辑的修改  
- **不删除** `INKOS_COMPACTION_*` 读取逻辑  
- **不新增**对 Mem0 / Hermes 包的依赖  

## 4. 与项目级架构文档的关系

- 验收后建议在 `ARCHITECTURE.md` 增加：ContextPolicy 作为 service 对话上下文政策入口（名词 + 与 compaction 并存关系）。  
- 本 feature  alone 系统行为不可见；acceptance 可记「内部库已就绪，待 prestuff 接线」。  
- `related_architecture` 仍空；总入口补一段「规划中的 context 模块」即可，不贴 design 链接当内容。
