---
doc_type: issue-fix
issue: 2026-07-12-profile-chat-immediate-cancel
status: fixed
created: 2026-07-12
severity: P1
tags: [profile-chat, sse, abort, llm-route]
path: fast-track
---

# profile-chat-immediate-cancel 修复记录

## 现象

模型对话无论问什么都显示“模型未返回正文内容”，服务端日志显示：

- `chat_stream.start`
- `chat_stream.cancelled`
- `request.finish durationMs:3`

说明 profile chat SSE 请求刚开始就被后端取消，LLM 没有机会返回正文。

## 根因

`apps/service/src/llm-routes.ts` 在 profile `chat-stream` 中监听 `req.on("close")` 来取消 LLM。对 POST 请求来说，`req.close` 可能在请求体读完后立即触发，不等于 SSE 响应连接断开，于是 `AbortController` 在请求开始后几毫秒内被 abort。

## 修复

- 不再监听 `req.close`。
- 改为监听：
  - `req.aborted`：请求真正被客户端中断。
  - `res.close`：SSE 响应连接关闭。
- 增加 `streamFinished` 标记，正常发送 `final/done` 或错误帧后，`res.close` 不再被误判为取消。
- `finally` 中只在响应未结束且未销毁时 `res.end()`。

## 验证

- `npm exec --package typescript@5.8.2 -- tsc -p apps/service/tsconfig.json --noEmit`
  - 通过
- `npm exec tsx -- apps/web/scripts/check-profile-stream-reducer.ts`
  - 通过：`check-profile-stream-reducer: ok`
- `git diff --check`
  - 通过

## 服务器验收点

重新拉起 service 后，在模型对话发一条普通消息：

- 不应再出现 `chat_stream.start` 后立刻 `chat_stream.cancelled`。
- 正常完成时应出现 `llm_profiles.chat_stream.done`。
- 只有关闭弹窗 / 断开请求时才应出现 `llm_profiles.chat_stream.cancelled`。
