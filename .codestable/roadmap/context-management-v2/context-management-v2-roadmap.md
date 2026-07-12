---
doc_type: roadmap
slug: context-management-v2
status: active
created: 2026-07-12
last_reviewed: 2026-07-12
tags: [context, agent, compaction, chapter-chat, hermes]
related_requirements: []
related_architecture: []
---

# Agent 上下文管理 v2

## 1. 背景

章节 / profile / init 的 tool 对话里，上下文靠「进模型前 `compaction.ts` 砍消息」+「每轮预塞大量正文/story」撑着。结果是：工具再读文件后上下文二次膨胀、上游 504、以及写入失败仍被当成改成功。

已定方向：保留现有 LLM 协议层；重做上下文策略，算法对齐 Hermes（loop 内剪枝 → 保头尾 → 结构化摘要 → 双阈值），不嵌入整颗第三方运行时。

## 2. 范围与明确不做

### 本 roadmap 覆盖

- ContextPolicy（分 mode 的预算与预塞规则）
- tool-loop 内压缩（剪旧 tool 输出 + 可选 LLM 摘要）
- 写入成功判定与「声称已改」防护
- 先章节对话垂直打通，再推广到 profile / init
- 可观测（压缩前后 token、是否触发压缩）

### 明确不做

- 不替换 `packages/core` 的 `createLLMClient` / `chatWithTools` 协议适配
- 不嵌入 Hermes / Claude Code / Mem0 等整包运行时或记忆 SaaS（本期）
- 不改小说生产主 pipeline（write/audit/revise）的上下文策略
- 不解决 Cloudflare / 代理侧超时配额本身（只降低触发概率并改善失败语义）

## 3. 模块拆分（概设）

```
context-management-v2
├── ContextPolicy：分 mode 预算、预塞清单、阈值配置
├── LoopCompressor：tool loop 内剪枝 / 摘要 / 双阈值
├── WriteIntegrity：tool 成功态 + 声称校验 + fallback 文案
└── ChatRuntimeBridge：接到 runToolEnabledConversation 与各 assistant
```

### ContextPolicy

- **职责**：定义 chapter / profile / init 的 token 预算、允许预塞的块、默认不预塞的块（正文全量等）
- **承载的子 feature**：`ctx-policy-core`, `ctx-chapter-prestuff`
- **触碰的现有代码 / 模块**：`llm-service.ts` 组 prompt 处；新建 `apps/service/src/context/`（建议）

### LoopCompressor

- **职责**：在每轮 tool 回灌后按阈值压缩 conversation；先廉价剪 tool 输出，再 LLM 摘要中间轮
- **承载的子 feature**：`ctx-tool-output-prune`, `ctx-loop-summarizer`
- **触碰的现有代码 / 模块**：`runToolEnabledConversation`；可演进替换 `compaction.ts` 的进模前路径

### WriteIntegrity

- **职责**：记录每次写工具的 `ok`；仅成功写入可进入「已修改」叙述；失败不得出「工具执行记录=成功」或假 fallback
- **承载的子 feature**：`ctx-write-claim-guard`
- **触碰的现有代码 / 模块**：`executeChapterChatTool` 结果解析、`buildChapterChatFallbackReply`、claimMarkers 逻辑

### ChatRuntimeBridge

- **职责**：把上述模块接到章节对话，再推广到 profile/init；退役旧 compaction 主路径
- **承载的子 feature**：`ctx-wire-chapter`, `ctx-wire-other-chats`, `ctx-retire-legacy-compaction`
- **触碰的现有代码 / 模块**：`runChapterAssistant` / init / profile chat

## 4. 模块间接口契约 / 共享协议（架构层详设）

### 4.1 ContextPolicy 配置

**方向**：配置 / 环境 → ContextPolicy → ChatRuntimeBridge  
**形式**：TS 类型 + 工厂函数

```ts
type ChatContextMode = "chapter" | "profile" | "init";

interface ContextBudget {
  totalTokens: number;          // 整段 conversation 上限（估算或 API 回报）
  contextTokens: number;        // system+首包 context 上限
  tailTokens: number;           // 保真尾部 token 预算（对标 Hermes ~20k 可配）
  compressPrimaryRatio: number; // 主压缩阈值，默认 0.50
  compressSafetyRatio: number;  // 安全网阈值，默认 0.85
  maxToolResultChars: number;   // 单条 tool 结果写入 conversation 前上限
  staleToolResultChars: number; // 非尾部旧 tool 结果保留上限（剪枝目标）
}

interface PrestuffRule {
  blockId: string;              // 如 chapter_body | story_state | path_map
  defaultInclude: boolean;
  maxChars: number;             // 0 = 禁止预塞，只能工具读
}

interface ContextPolicy {
  mode: ChatContextMode;
  budget: ContextBudget;
  prestuff: ReadonlyArray<PrestuffRule>;
}

function resolveContextPolicy(mode: ChatContextMode, env?: NodeJS.ProcessEnv): ContextPolicy;
```

**章节 mode 硬约束（本期写死进契约，feature 不得擅自改松）：**

- `chapter_body.defaultInclude = false` 或 `maxChars ≤ 2000`（二选一在 design 定，默认倾向 false）
- 必须预塞：`path_map`（当前 chapterFile / bookDir / storyDir）
- story 长文（volume_outline、character_matrix 等）默认不预塞全文，靠 `read_text_file`

### 4.2 LoopCompressor

**方向**：ChatRuntimeBridge → LoopCompressor → 更新后的 messages  
**形式**：函数调用

```ts
interface CompressInput {
  messages: AgentMessage[];     // 含 tool 角色
  policy: ContextPolicy;
  usage?: { promptTokens?: number }; // 有则优先于估算
  previousSummary?: string;
}

interface CompressResult {
  messages: AgentMessage[];
  stats: {
    triggered: "none" | "prune" | "summarize" | "safety";
    beforeTokens: number;
    afterTokens: number;
    prunedToolResults: number;
    summaryUpdated: boolean;
  };
  summary?: string;
}

function maybeCompressConversation(input: CompressInput): Promise<CompressResult>;
```

**约束：**

- 触发：`beforeTokens >= totalTokens * compressPrimaryRatio` 时至少跑 prune；仍超则 summarize；`>= safetyRatio` 必须再压一轮或硬截断并打日志
- 顺序固定：prune tool outputs → protect head+tail → summarize middle → assemble
- head：至少保留 system；chapter 另保留路径提醒类消息
- summarize 失败（摘要模型报错）→ 不得静默丢中间轮不留痕迹；必须 `stats` + 日志标明，并回退为「强剪枝 / 丢弃最旧 middle tool」策略之一（feature-design 选具体回退，但必须显式）
- **禁止**只在进 `chatWithTools` 前压一次、loop 内永不压（旧 compaction 主行为退役）

### 4.3 Tool 执行结果协议

**方向**：executeTool → WriteIntegrity / LoopCompressor  
**形式**：JSON 字符串协议（tool message content）

```ts
// 成功写
{ "ok": true, "path": string, "size": number, "op": "write_text_file" | "move_path" | "delete_path" | ... }

// 失败（含路径 recoverable）
{ "ok": false, "recoverable"?: boolean, "tool": string, "error": string, ... }
```

**约束：**

- `toolTrace` 条目必须带解析后的 `ok: boolean`（不只 name/args）
- `hasSuccessfulWrite = toolTrace.some(t => writeOps.has(t.name) && t.ok === true)`
- 「工具执行记录」只列 `ok === true` 的写操作
- `buildChapterChatFallbackReply`：无成功写时不得出现「已完成修改 / 写回相关文件」

### 4.4 WriteIntegrity / 回复装订

```ts
interface ToolTraceItem {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

function finalizeAssistantReply(input: {
  reply: string;
  toolTrace: ReadonlyArray<ToolTraceItem>;
  reachedMaxTurns: boolean;
}): string;
```

**约束：**

- 声称修改且 `!hasSuccessfulWrite` → 必须追加警告（词表可扩展，但逻辑不得删）
- 有成功写 → 可附成功路径摘要
- claim 检测与成功写判定必须共用 `ToolTraceItem.ok`

### 4.5 ChatRuntimeBridge 挂载点

**方向**：`runToolEnabledConversation` 每轮 tool 执行后调用 `maybeCompressConversation`  
**约束：**

- `provider.ts` 不引入 ContextPolicy
- 压缩发生在 conversation 数组上，再进入下一轮 `chatWithTools`
- chapter / profile / init 共用同一 Bridge；差异只来自 `ContextPolicy.mode`

### 4.6 共享配置（环境变量，可覆盖 policy 默认）

| 变量 | 含义 | 默认建议 |
|---|---|---|
| `INKOS_CTX_TOTAL_TOKENS` | totalTokens | 与现网模型窗口相关，design 给默认 |
| `INKOS_CTX_COMPRESS_RATIO` | primary ratio | `0.5` |
| `INKOS_CTX_SAFETY_RATIO` | safety ratio | `0.85` |
| `INKOS_CTX_MAX_TOOL_RESULT_CHARS` | 单条 tool 上限 | 如 `8000` |
| `INKOS_DISABLE_LOOP_COMPRESS` | 紧急旁路 | `false` |

旧 `INKOS_COMPACTION_*`：在 `ctx-retire-legacy-compaction` 前可并存；退役后文档标明废弃。

## 5. 子 feature 清单

1. **ctx-policy-core** — ContextPolicy 类型、`resolveContextPolicy`、chapter 默认规则单测
   - 所属模块：ContextPolicy
   - 依赖：无
   - 状态：done
   - 对应 feature：`2026-07-12-ctx-policy-core`

2. **ctx-chapter-prestuff** — 章节对话按 policy 组 context（路径地图为主，正文/长 story 不默认全塞）
   - 所属模块：ContextPolicy + ChatRuntimeBridge
   - 依赖：`ctx-policy-core`
   - 状态：done
   - 对应 feature：`2026-07-12-ctx-chapter-prestuff`
   - 备注：**最小闭环**——同书同章对话，进模前估算 token 明显下降，且仍能靠工具读改文件

3. **ctx-write-claim-guard** — toolTrace 带 ok；fallback/警告/执行记录只认成功写
   - 所属模块：WriteIntegrity
   - 依赖：无（可与 1–2 并行）
   - 状态：planned
   - 对应 feature：未启动

4. **ctx-tool-output-prune** — loop 内按 budget 剪旧 tool 输出
   - 所属模块：LoopCompressor
   - 依赖：`ctx-policy-core`
   - 状态：done
   - 对应 feature：`2026-07-12-ctx-tool-output-prune`

5. **ctx-loop-summarizer** — 主/安全双阈值 + 结构化摘要（Hermes 对齐）
   - 所属模块：LoopCompressor
   - 依赖：`ctx-tool-output-prune`
   - 状态：planned
   - 对应 feature：未启动

6. **ctx-wire-chapter** — 章节 `runToolEnabledConversation` 接上 prune/summarizer + WriteIntegrity
   - 所属模块：ChatRuntimeBridge
   - 依赖：`ctx-chapter-prestuff`, `ctx-write-claim-guard`, `ctx-loop-summarizer`
   - 状态：planned
   - 对应 feature：未启动

7. **ctx-wire-other-chats** — profile / init 复用同一套 policy+compress
   - 所属模块：ChatRuntimeBridge
   - 依赖：`ctx-wire-chapter`
   - 状态：planned
   - 对应 feature：未启动

8. **ctx-retire-legacy-compaction** — 旧 `compaction.ts` 进模前主路径退役或降为兼容层，文档与 env 对齐
   - 所属模块：ChatRuntimeBridge
   - 依赖：`ctx-wire-chapter`（建议 `ctx-wire-other-chats` 后做，也可仅 chapter 退役——design 时确认）
   - 状态：planned
   - 对应 feature：未启动

**最小闭环**：第 2 条 `ctx-chapter-prestuff` 做完即可演示「少预塞仍可工具改章」；完整抗 504 + 假写入要到第 6 条。

## 6. 排期思路

按「先减输入 → 再修诚实写入 → 再上 loop 压缩 → 最后推广/退役」排依赖。产品优先级（1–8 之间非技术依赖的调序）由用户拍板；技术上 `ctx-write-claim-guard` 可与前两条并行。

## 7. 观察项

- `architecture/ARCHITECTURE.md` 仍是骨架，落地后应用 `cs-arch` 回写现状
- 假写入 / 504 相关 issue report 尚未落盘，可与本 roadmap 交叉引用
- 摘要是否共用对话模型还是便宜小模型：涉及成本与窗口，留给 `ctx-loop-summarizer` design
- `chapter_body` 完全不预塞 vs 2000 字摘录：最小闭环 design 必须二选一
