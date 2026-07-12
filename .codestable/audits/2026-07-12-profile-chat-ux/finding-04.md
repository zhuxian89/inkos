---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-ux
finding_id: "performance-04"
nature: performance
severity: P2
confidence: medium
suggested_action: cs-refactor
status: open
---

# Finding 04：每个 token chunk 全量 setState

## 速答

每个 `message_chunk` / `thought_chunk` 都 `setProfileLiveItems([...history, ...items])`，长回复时重渲染频繁。

## 关键证据

- `setup-workspace.tsx:405-438` — `renderFrame` 每个事件调用

## 影响

低端机或超长 reasoning 时可能掉帧；profile 测试场景通常可接受。

## 修复方向

`requestAnimationFrame` / 节流合并 chunk 后再 setState。

## 建议动作

`cs-refactor`。
