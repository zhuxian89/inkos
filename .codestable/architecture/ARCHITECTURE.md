# InkOS 架构总入口

> 状态：context-management-v2 已闭环
> 创建日期：2026-07-12
> 最近回写：2026-07-12（claim-guard / summarizer / wire / retire）

## 1. 项目简介

InkOS 是多 Agent 管线的自动化小说生产系统（TypeScript pnpm monorepo），提供 Web UI、Service API 与 CLI 三种入口，负责草稿、审计、修订与长期记忆维护。

## 2. 核心概念 / 术语表

| 术语 | 含义 |
|---|---|
| ContextPolicy | service 侧某一 chat mode 的预算 + 预塞规则；`resolveContextPolicy` 从 `INKOS_CTX_*` 解析。 |
| Prestuff | 章节首包按 policy 组装；默认不预塞正文/长 story。 |
| maybeCompressConversation | tool loop 内：ingest cap → 可选 middle 摘要 → safety 强剪。 |
| WriteIntegrity | toolTrace 带 `ok`；声称警告 / 执行记录 / fallback 仅认成功写。 |
| INKOS_DISABLE_LOOP_COMPRESS | loop 压缩旁路；进模前 `compactConversationMessages` 已退役。 |

## 3. 子系统 / 模块索引

- **apps/service**
  - **`src/context/`**：ContextPolicy、章节 prestuff、prune、`maybeCompressConversation`、WriteIntegrity
  - **`src/compaction.ts`**：保留 `estimateTokens` / `extractStructuredSummary`；旧进模前 compact 仅兼容/测试
  - **`src/llm-service.ts`**：`runToolEnabledConversation` 统一 compress + claim 装订；chapter/profile/init 共用
- **packages/core**：LLM provider（不含 ContextPolicy）
- **apps/web** / **packages/cli**

## 4. 关键架构决定

- 对话上下文政策与 LLM 协议层分离。
- 压缩发生在 tool loop 内，不在进 `chatWithTools` 前砍一轮完事。
- 写入诚实性以 tool JSON `ok` 为准。

## 5. 已知约束 / 硬边界

- chapter 默认不预塞 `chapter_body` / `story_longform`；`path_map` 必预塞。
- 剪枝不删除 `role:tool` 消息（配对）；摘要可折叠 middle 整段轮次。
- 旁路：`INKOS_DISABLE_LOOP_COMPRESS`。
