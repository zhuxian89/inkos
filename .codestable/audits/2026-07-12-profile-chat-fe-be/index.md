---
doc_type: audit-index
audit: 2026-07-12-profile-chat-fe-be
scope: profile chat 前端 ChatKit + 后端 SSE/provider（chat completions）复审
created: 2026-07-12
status: active
total_findings: 7
supersedes: 2026-07-12-profile-chat-ux
---

# profile-chat-fe-be 审计报告

## 范围

前后端一起扫，聚焦最近 profile 对话 / reasoning 流改动：

- **前端** `apps/web/app/ui/chat-kit/**`、`apps/web/app/ui/setup-workspace.tsx`
- **后端** `apps/service/src/llm-routes.ts`（`/chat-stream`）、`apps/service/src/llm-service.ts`（`runProfileChatWithTools`）
- **core** `packages/core/src/llm/provider.ts`（`chatWithTools` + OpenAI Chat Completions tool 流）

未扫：章节/书本对话主路径、Anthropic/Responses reasoning（产品已明确不在本次范围）。

对照：`.codestable/architecture/ARCHITECTURE.md`；旧审计 `2026-07-12-profile-chat-ux`（已标 `superseded`）。

## 总评

上一轮的硬伤（delta 回调丢弃、`final` 不收中间气泡、前端无 Abort）已基本落地；`6046c022` 后 chat completions 的 `onTextDelta`/`onReasoningDelta` 通路正确。本轮复审仍抓到 **3 条高置信 P1**：tool 轮次累加器未复位、SSE 服务端不跟客户端断开、persist 漏写开关。其余为性能/安全/可维护性 P2。整体可以上服务器试，但建议先把 3 条 P1 开 issue 修掉，避免「有思考过程了又踩新坑」。

## 已确认修好（相对旧审计 / 6046c022）

| 项 | 证据 |
|---|---|
| `chatWithTools` 丢弃 delta 回调 | `provider.ts` `resolved` 现含 `onTextDelta` / `onReasoningDelta` |
| chat 路径读 `reasoning_content` | `streamChatWithToolsOpenAIChat` 统一 `reasoning_content ?? reasoning` |
| 关窗 Abort + 不写错 state | `setup-workspace.tsx` `AbortController` + Modal `onCancel` |
| `final` 收敛中间 assistant_text | `apply-profile-stream-event.ts` `final` 分支重建时间线 |

## 发现清单

| # | 性质 | 严重度 | 置信度 | 标题 | 文件 |
|---|---|---|---|---|---|
| 1 | bug | P1 | high | tool 轮次未复位 content/reasoning，直播态串文 | [finding-01.md](finding-01.md) |
| 2 | bug | P1 | high | chat-stream 客户端断开后服务端仍跑 LLM | [finding-02.md](finding-02.md) |
| 3 | bug | P1 | high | 改题材/平台/清空对话 persist 漏写流式与 reasoning 开关 | [finding-03.md](finding-03.md) |
| 4 | bug | P2 | high | final 只保留末轮正文，tool 前口播会闪掉 | [finding-04.md](finding-04.md) |
| 5 | performance | P2 | medium | 每个 token chunk 全量 setState | [finding-05.md](finding-05.md) |
| 6 | security | P2 | medium | Markdown 链接未约束 javascript:/data: | [finding-06.md](finding-06.md) |
| 7 | maintainability | P2 | high | 流式 reducer 无自动化回归 | [finding-07.md](finding-07.md) |

## 按维度分布

| 性质 | P0 | P1 | P2 | 合计 |
|---|---|---|---|---|
| bug | 0 | 3 | 1 | 4 |
| security | 0 | 0 | 1 | 1 |
| performance | 0 | 0 | 1 | 1 |
| maintainability | 0 | 0 | 1 | 1 |
| arch-drift | 0 | 0 | 0 | 0 |
| **合计** | **0** | **3** | **4** | **7** |

## 下一步建议

- **P1 已修**（issue `2026-07-12-profile-chat-audit-p1`）：finding-01 / 02 / 03
- **P2 本迭代/有空**：finding-04（是否保留 tool 前口播）、finding-05（rAF 节流）、finding-06（href 过滤）、finding-07（单测进 CI）

本审计只发现不定修。P1 修复见对应 issue fix-note。
