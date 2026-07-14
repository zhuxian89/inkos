---
doc_type: issue-fix
issue: 2026-07-14-chat-stream-partial-output
status: fixed
severity: P2
path: fast-track
fix_date: 2026-07-14
tags: [chapter-chat, stream, sse, partial-output]
---

# 聊天流式内容丢失修复记录

## 1. 问题描述

章节对话的 SSE 流在已经输出文本、思考或工具卡后发生错误时，界面会清空临时时间线，已显示内容随之消失。

## 2. 根因

`consumeChatKitStream` 在出错时只抛出错误文本，没有暴露已累积的流状态。章节对话的错误分支只能清空 `chatLiveItems`，无法将部分输出写入会话历史。

## 3. 修复方案

流消费者在失败时抛出携带部分结果的 `ChatKitStreamError`。章节对话收到该错误后，将已有时间线写入助手消息并持久化，再显示失败提示。

## 4. 改动文件清单

- `apps/web/app/ui/chat-kit/consume-chat-kit-stream.ts`
- `apps/web/app/ui/chat-kit/index.ts`
- `apps/web/app/ui/book-chapters.tsx`
- `apps/web/scripts/check-profile-stream-reducer.ts`

## 5. 验证结果

- 轻量回归检查覆盖：SSE 在输出部分文本后发送 `error` 事件时，错误对象保留文本和时间线。
- `apps/web` TypeScript 校验通过。
- 未启动开发服务，遵从本次要求；未执行浏览器实测。

## 6. 遗留事项

本次不增加重试交互。后续若加入重试，需区分已发生工具调用的请求，避免重复文件操作。
