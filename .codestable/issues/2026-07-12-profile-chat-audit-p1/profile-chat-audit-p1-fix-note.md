---
doc_type: issue-fix
issue: 2026-07-12-profile-chat-audit-p1
status: fixed
fixed_date: 2026-07-12
severity: P1
related_audit: 2026-07-12-profile-chat-fe-be
path: fast-track
summary: 修复审计 3 条 P1——tool 缓冲复位、SSE 断开 abort、persist 开关泄漏（随 stream-only 一并关闭）
---

# profile-chat-audit-p1 修复记录

## 来源

`.codestable/audits/2026-07-12-profile-chat-fe-be` finding-01 / 02 / 03。用户要求快速通道立刻修。

## 根因（已确认）

1. **finding-01**：`tool_call` 只清 `assistantTextId`，`content`/`reasoning`/`thoughtId` 继续累加 → 下一轮 chunk 串文。
2. **finding-02**：`chat-stream` 未把客户端断开接到 `abortSignal`，关窗后服务端继续跑 LLM/tool。
3. **finding-03**：改题材/平台/清空 persist 漏写 `useStream`/`includeReasoning`。产品随后定为「只流式 + 必思考」，开关已删除，根因面消失。

## 修复

| 文件 | 改动 |
|---|---|
| `apps/web/app/ui/chat-kit/apply-profile-stream-event.ts` | `tool_call` 复位 `content/reasoning/assistantTextId/thoughtId`；`final` 保留各轮 thought，不再用末轮 reasoning 覆盖全部 |
| `apps/service/src/llm-routes.ts` | `AbortController` + `req.on("close")` → `runProfileChatWithTools({ abortSignal })`；取消不报 error SSE |
| `apps/web/app/ui/setup-workspace.tsx` | （已有未推改动）去掉流式/reasoning 开关，只走 chat-stream |
| `apps/web/scripts/check-profile-stream-reducer.ts` | 覆盖 tool 边界复位回归 |

## 验证

- [x] `npx tsx apps/web/scripts/check-profile-stream-reducer.ts` → ok
- [x] `apps/service` / `apps/web` `tsc --noEmit`
- [ ] 手工（服务器）：多 tool 轮次直播不串文；关窗后服务端日志出现 `chat_stream.cancelled` 且不再继续打模型

## 审计回写

- finding-01 / 02 / 03 → `status: fixed`
