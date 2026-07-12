# InkOS 架构总入口

> 状态：部分填充（随 feature 验收回写）
> 创建日期：2026-07-12
> 最近回写：2026-07-12（ctx-tool-output-prune）

## 1. 项目简介

InkOS 是多 Agent 管线的自动化小说生产系统（TypeScript pnpm monorepo），提供 Web UI、Service API 与 CLI 三种入口，负责草稿、审计、修订与长期记忆维护。

## 2. 核心概念 / 术语表

| 术语 | 含义 |
|---|---|
| ContextPolicy | service 侧某一 chat mode（chapter / profile / init）的上下文预算 + 预塞规则快照；由 `resolveContextPolicy` 从 env 解析。与 CLI `resolveContext`（项目根解析）无关。 |
| ChatContextMode | `chapter` \| `profile` \| `init`，对齐三类 tool chat，非 pipeline 写作 agent。 |
| Prestuff / buildChapterContextPrompt | 按 ContextPolicy 组装章节对话首包；默认不预塞正文与长 story。 |
| Tool output prune / pruneToolOutputs | tool loop 内廉价剪枝（入库封顶 + 超阈值压旧 tool）；对齐 Hermes Phase 1；不删 tool 消息。 |
| INKOS_CTX_* | ContextPolicy v2 环境变量前缀；`INKOS_DISABLE_LOOP_COMPRESS` 可旁路 loop 剪枝。 |

## 3. 子系统 / 模块索引

- **apps/service**：HTTP API、job、章节/初始化/配置对话
  - **`src/context/`**：ContextPolicy、章节首包组装、`pruneToolOutputs`（loop 剪枝）
  - **`src/compaction.ts`**：进模型前消息压缩（旧路径，仍在用；LLM 摘要式 loop 压缩待后续）
  - **`src/llm-service.ts`**：tool chat 编排；`runToolEnabledConversation` 内接剪枝
- **packages/core**：LLM provider、pipeline、状态与记忆文件
- **apps/web**：Studio UI
- **packages/cli**：命令行入口

## 4. 关键架构决定

- 对话上下文政策与 LLM 协议层分离：`provider.ts` 不承载 ContextPolicy。
- 章节首包由 ContextPolicy 驱动：路径地图 + 短状态；正文默认工具按需读。
- Tool loop 内先廉价剪枝（Hermes Phase 1）；结构化 LLM 摘要尚未落地。
- 进模前 `compaction.ts` 与 loop 剪枝暂时并存，直至退役条目。

## 5. 已知约束 / 硬边界

- chapter 默认：`chapter_body` / `story_longform` 不预塞；`path_map` 必须可预塞。
- `compressPrimaryRatio` &lt; `compressSafetyRatio`，否则回落 0.5 / 0.85。
- 剪枝不得删除 `role:tool` 消息，只改 content，以保持 toolCallId 配对。
- 旧 `INKOS_COMPACTION_*` 在退役 feature 前不得删除。
