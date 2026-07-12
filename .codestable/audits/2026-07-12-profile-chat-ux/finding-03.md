---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-ux
finding_id: "bug-03"
nature: bug
severity: P2
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 03：live→persist 切换时短暂少一条助手消息

## 速答

`consumeProfileChatStream` 结束时先 `setProfileLiveItems(null)`，此时 `profileChatMessages` 还是「仅到 user」；随后才 `setProfileChatMessages(updated)`，中间一帧时间线缺助手气泡。

## 关键证据

- `setup-workspace.tsx:447` — stream 结束 `setProfileLiveItems(null)`
- `setup-workspace.tsx:504-515` — 返回后才写带 assistant 的 `updated`
- `setup-workspace.tsx:168-171` — `profileLiveItems ?? messagesToChatKitItems(messages)`

## 影响

流结束瞬间 UI 闪一下「只有用户消息」；体验瑕疵，数据最终正确。

## 修复方向

先 `setProfileChatMessages(updated)` 再清 live；或清 live 时传入终态 items。

## 建议动作

`cs-issue`（可与 finding-01 同修）。
