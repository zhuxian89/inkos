---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-ux
finding_id: "bug-01"
nature: bug
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 01：多轮 tool 后中间 assistant 气泡残留

## 速答

`tool_call` 会把 `assistantTextId` 置空并新开气泡，但**不会清掉**上一轮已渲染的 `assistant_text`；`final` 只更新当前段或再追加一段，导致时间线留下过时中间回复。

## 关键证据

- `apply-profile-stream-event.ts:83-96` — `tool_call` 仅 `assistantTextId: null`，旧 `assistant_text` 仍留在 `items`
- `apply-profile-stream-event.ts:114-140` — `final` 只改匹配 `assistantTextId` 的项，或在没有时 append；不删除中间段
- `llm-service.ts:669-693` — 多 turn `chatWithTools`，每轮都可 `onTextDelta`，会多次推 `message_chunk`

## 影响

模型调用工具 ≥1 次时，用户可能看到「工具前半截回复 + 工具卡 + 终态回复」叠在一起；落盘 `content` 用的是 `final`/`turnState` 终态，刷新后中间段消失——**直播态与落盘态不一致**。

## 修复方向

每轮 tool 开始时归档/折叠上一轮 assistant 段，或 `final` 时用单一 assistant 段重建本 turn 的 text/thought/tool 顺序。

## 建议动作

`cs-issue`，因为是用户可见行为错误。
