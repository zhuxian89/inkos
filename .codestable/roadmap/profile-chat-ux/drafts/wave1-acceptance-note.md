# profile-chat-ux 首波验收摘要

> 日期：2026-07-12

## 已交付

- `apps/web/app/ui/chat-kit/`：ThinkingBlock（mindfs 1:1）、ToolCallCard、StreamStatusBar、ChatKitPanel、SSE→时间线 reducer
- `llm-routes` profile `chat-stream`：`message_chunk` / `thought_chunk` / `tool_call` / `tool_call_update` / `final` / `done`
- `runToolEnabledConversation`：`onToolStart` / `onToolEnd`
- `setup-workspace`：添加模型对话改用 ChatKitPanel；章节/书本未改

## 自测建议

1. 打开 LLM 配置 → 对话测试
2. 勾选流式 + 展示 reasoning，发一条消息
3. 确认：思考默认折叠、正文流式、有工具时出现工具卡、生成中脉冲

## 未做（按 roadmap）

- 章节 / 书本对话
- WebSocket / mindfs 整包
