---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-mindfs-parity
finding_id: "arch-drift-01"
nature: arch-drift
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
fixed-by: 2026-07-12-profile-chat-mindfs-parity
---

# Finding 01：final 后工具时间线丢失

## 速答

当轮流式过程中工具卡会出现，但 `final` 后 `setup-workspace` 清空 `profileLiveItems`，随后历史只从 `role/content/reasoning` 重建，读文件、搜索、写文件等工具卡不会留在回答里；这不满足 mindfs 1:1。

## 关键证据

- `apps/web/app/ui/setup-workspace.tsx:529` — `updated` 只追加 `{ role: "assistant", content, reasoning }`，没有工具时间线字段。
- `apps/web/app/ui/setup-workspace.tsx:539` — `setProfileChatMessages(updated)` 后紧接 `setProfileLiveItems(null)`，UI 从 live timeline 退回 history timeline。
- `apps/web/app/ui/setup-workspace.tsx:541` — `persistProfileChat(... { messages: updated })` 也只持久化 messages，不持久化 tool calls。
- `apps/web/app/ui/chat-kit/messages-to-items.ts:3` — 历史重建入参只有 `role/content/reasoning`，没有 tool call 数据结构。
- `/Users/hongweizhang/java_project/mindfs/web/src/components/SessionViewer.tsx:1548` — mindfs 在会话时间线里直接渲染 `ToolCallCard`，工具调用是会话展示的一等时间线项。

## 影响

用户在工具运行时可能短暂看到卡片，但回答结束后前端回到历史模型，工具命令和结果证据会消失。用户反馈的“回答完之后看不到直接读的命令、修改的命令、搜索的命令”仍可由这条路径解释。

## 修复方向

把 profile chat history 从纯 `ProfileChatMessage[]` 扩展为可保存 `ChatKitItem[]` 或 assistant message 内嵌 `toolCalls`，`final` 后不要丢弃当轮工具时间线；`messagesToChatKitItems` 必须能回放 tool items。

## 建议动作

`cs-issue`，因为这是用户可见的 1:1 阻断问题，且修复需要改状态模型和持久化接线。

## 修复状态

已在 issue `2026-07-12-profile-chat-mindfs-parity` 中修复：assistant 历史消息保存本轮 `ChatKitItem[]`，历史回放优先恢复工具时间线。
