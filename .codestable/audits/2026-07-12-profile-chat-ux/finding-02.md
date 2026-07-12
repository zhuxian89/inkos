---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-ux
finding_id: "bug-02"
nature: bug
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 02：关窗/切配置无 Abort，流式仍 setState

## 速答

`sendProfileChat` 的 `fetch` / SSE reader **没有 AbortController**；关闭 Modal 或换 profile 后异步仍会 `setProfileLiveItems` / `setProfileChatMessages`。

## 关键证据

- `setup-workspace.tsx:480-558` — `void (async () => { fetch... consumeProfileChatStream...})` 无 abort、无 mounted/chatProfile 校验
- 全文件 grep `AbortController`：无命中

## 影响

长流式时关窗 → React 对已卸载/错会话 setState 警告；更糟时把回复写进**下一个打开的配置**会话（若 `activeProfileId` 闭包仍是旧 id 则写旧存储，若 state 已切则可能错乱）。

## 修复方向

为每次发送建 `AbortController`，关窗/`finally` 时 abort；回调里比对 `activeProfileId` / generation token。

## 建议动作

`cs-issue`。
