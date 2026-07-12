---
doc_type: issue-fix
issue: 2026-07-12-profile-chat-mindfs-parity
status: fixed
created: 2026-07-12
severity: P1
tags: [profile-chat, mindfs, chat-kit, tool-call]
source_audit: 2026-07-12-profile-chat-mindfs-parity
---

# profile-chat-mindfs-parity 修复记录

## 触发问题

用户确认审计发现后要求修复：

- P1：`final` 后工具时间线丢失，读/搜/改命令不能像 mindfs 一样留在回答中。
- P2：`ToolCallCard` 行为还没完整 mindfs parity，可以一并修。
- P2：写文件缺真实 old/new diff 证据，本次先不处理。

## 根因

1. `setup-workspace` 在流结束后只把 assistant 的 `content/reasoning` 写入 `profileChatMessages`，随后 `setProfileLiveItems(null)`，历史回放只能通过 `messagesToChatKitItems` 重建正文和思考块，工具卡被丢弃。
2. `ToolCallCard` 展开详情仍主要依赖通用 `<pre>`，没有按 mindfs 的结构化详情路径处理 diff-like 文本、Markdown result、ANSI 输出和 progress 文案。

## 修复范围

- `apps/web/app/ui/setup-workspace.tsx`
- `apps/web/app/ui/chat-kit/messages-to-items.ts`
- `apps/web/app/ui/chat-kit/ToolCallCard.tsx`
- `apps/web/scripts/check-profile-stream-reducer.ts`

## 修复内容

1. `ProfileChatMessage` 增加 `items?: ChatKitItem[]`，流式 `final` 后把本轮 `turnState.items` 写入 assistant 历史消息。
2. `messagesToChatKitItems` 优先回放 assistant 消息保存的 timeline items，并把历史里的 `assistant_text.streaming` 归一为 `false`。
3. 发给后端的 profile chat messages 通过 `profileModelMessages()` 裁剪为 `role/content/reasoning`，避免把前端 UI timeline 字段塞进模型上下文。
4. `ToolCallCard` 增加 mindfs 风格的结构化详情渲染：
   - diff / diff-like text 包装成 fenced diff 后交给 `ChatKitMarkdown`。
   - 普通 text/result 通过 Markdown 渲染。
   - user shell 输出做 ANSI 控制码清理后用终端块展示。
   - `meta.progress` / `meta.lastToolName` 显示为卡片下方进度文案。
5. 回归脚本增加断言：`final` 后 live turn 保留 tool blocks；持久化 assistant items 回放后仍保留 tool blocks，且不回放 streaming 状态。

## 验证

- `npm exec tsx -- apps/web/scripts/check-profile-stream-reducer.ts`
  - 通过：`check-profile-stream-reducer: ok`
- `npm exec --package typescript@5.8.2 -- tsc -p apps/web/tsconfig.json --noEmit`
  - 通过
- `git diff --check`
  - 通过

## 未处理项

- 写文件工具的真实 old/new diff 证据未在本次处理，仍对应审计 `finding-03`。
- profile chat 没有 mindfs 的 `rootId/sessionKey/getToolCall` 远程详情 API；本次通过保存完整 turn items 解决 profile 当前路径的回放问题，没有引入新的详情接口。
