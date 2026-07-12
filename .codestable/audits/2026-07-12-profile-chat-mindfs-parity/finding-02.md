---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-mindfs-parity
finding_id: "arch-drift-02"
nature: arch-drift
severity: P2
confidence: high
suggested_action: cs-issue
status: fixed
fixed-by: 2026-07-12-profile-chat-mindfs-parity
---

# Finding 02：ToolCallCard 行为仍未达到 mindfs parity

## 速答

当前 ToolCallCard 已经能显示 `toolCall` 的参数、content、locations、result，但仍是简化渲染：没有 mindfs 的远程详情加载、ANSI 输出、Markdown diff/result 渲染、progress 文案。

## 关键证据

- `apps/web/app/ui/chat-kit/ToolCallCard.tsx:118` — 当前所有详情通过通用 `CodeBlock` / `<pre>` 渲染。
- `apps/web/app/ui/chat-kit/ToolCallCard.tsx:287` — 展开态只列出“错误 / 参数 / content / 位置 / 原始结果”。
- `/Users/hongweizhang/java_project/mindfs/web/src/components/stream/ToolCallCard.tsx:427` — mindfs 根据 `rootId/sessionKey/callId` 判断是否能远程加载完整 tool details。
- `/Users/hongweizhang/java_project/mindfs/web/src/components/stream/ToolCallCard.tsx:492` — mindfs 展开后会调用 `sessionService.getToolCall(...)` 补齐缺失详情。
- `/Users/hongweizhang/java_project/mindfs/web/src/components/stream/ToolCallCard.tsx:653` — mindfs 对 user shell 输出用 `AnsiOutput` 并保持底部滚动。
- `/Users/hongweizhang/java_project/mindfs/web/src/components/stream/ToolCallCard.tsx:661` — mindfs 对结构化详情使用 `MarkdownViewer` 渲染。
- `/Users/hongweizhang/java_project/mindfs/web/src/components/stream/ToolCallCard.tsx:721` — mindfs 会显示工具进度文案。

## 影响

当前版本能看到工具证据，但还不是 mindfs 的完整阅读体验。长输出、命令输出、diff、渐进式详情加载的表现都会和 mindfs 不一致。

## 修复方向

按 mindfs ToolCallCard 的行为清单补齐：详情加载入口、ANSI 输出、Markdown/diff 渲染、progress 文案。可以用 Ant Design 的 Collapse/Tag/Icon/Spin 承载外壳，但行为和字段不能缩水。

## 建议动作

`cs-issue`，因为这是明确的 1:1 parity 缺口，不是普通重构。

## 修复状态

已在 issue `2026-07-12-profile-chat-mindfs-parity` 中补齐 profile chat 当前路径需要的 ToolCallCard 行为：结构化 diff / text Markdown 渲染、ANSI 输出清理、progress 文案。profile chat 没有 mindfs 的远程详情 API，本次通过保存完整 turn items 解决当前路径回放。
