---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-fe-be
finding_id: "performance-05"
nature: performance
severity: P2
confidence: medium
suggested_action: cs-refactor
status: open
---

# Finding 05：每个 token chunk 全量 setState

## 速答

每个 `message_chunk` / `thought_chunk` 都 `onFrame` → `setProfileLiveItems`，长 reasoning 时主线程与 React 协调压力大。

## 关键证据

- `apps/web/app/ui/setup-workspace.tsx:450-451` — 每事件 `applyProfileStreamEvent` 后立即 `renderFrame()`
- `apps/web/app/ui/setup-workspace.tsx:537-540` — `onFrame` 直接 `setProfileLiveItems(items)`
- `apps/web/app/ui/chat-kit/ChatKitPanel.tsx:32-35` — `items` 变化即滚到底，放大重排

## 影响

长思考模型下输入卡顿、滚动抖动；短回复不明显。

## 修复方向

`requestAnimationFrame` / 16–32ms 节流合并 frame；或拆「正文缓冲 + 低频 flush」。

## 建议动作

`cs-refactor`，无功能错误时优先性能债处理。
