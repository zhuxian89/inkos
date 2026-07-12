---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-fe-be
finding_id: "bug-01"
nature: bug
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 01：tool 轮次未复位 content/reasoning，直播态串文

## 速答

`tool_call` 只把 `assistantTextId` 置空，**不清** `content` / `reasoning`；下一轮 `message_chunk` / `thought_chunk` 会拼到上一轮缓冲上，直播气泡串文，直到 `final` 才勉强收敛。

## 关键证据

- `apps/web/app/ui/chat-kit/apply-profile-stream-event.ts:83-96` — `tool_call` 仅 `assistantTextId: null`，保留 `state.content` / `state.reasoning`
- `apps/web/app/ui/chat-kit/apply-profile-stream-event.ts:60-80` — 新开 `assistant_text` 时用 `state.content + chunk`，若缓冲未清则变成「上一轮正文 + 本轮 delta」
- `apps/web/app/ui/chat-kit/apply-profile-stream-event.ts:37-57` — `thought_chunk` 同样累加 `state.reasoning`；`thoughtId` 也不在 tool 边界复位
- `apps/service/src/llm-service.ts:669-690` — 多 turn `chatWithTools`，每轮都可推 delta；`lastAssistantReasoning` **覆盖**而非拼接，与前端累加语义不一致

## 影响

模型只要走 ≥1 次 tool：流式过程中可能出现重复/粘连正文；多轮都有 reasoning 时，若 `final.reasoning` 带末轮文本，会按 `??` 优先覆盖掉前端已累加的全文思考。服务器试「带工具的 profile 对话」时很容易踩到。

## 修复方向

在 `tool_call`（或每轮 LLM turn 边界）复位 `content` / `reasoning` / `thoughtId`，或按 turn 分段存；后端 `final.reasoning` 与前端累加策略对齐（拼接或只发末轮并文档化）。

## 建议动作

`cs-issue`，因为是用户可见的流式正确性问题。
