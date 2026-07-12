---
doc_type: issue-report
issue: 2026-07-12-profile-chat-stream-bugs
status: fixed
severity: P1
summary: profile ChatKit 多轮 tool 时间线残留 + 无 Abort 关窗仍写 state；结束瞬间 UI 闪烁
tags: [profile-chat, stream, chat-kit]
related_audit: 2026-07-12-profile-chat-ux
---

# profile-chat-stream-bugs

## 现象

1. 多轮 tool 后直播时间线可能留下过时中间 assistant 气泡，与 final/落盘不一致  
2. 关闭对话窗后 SSE 仍可能 setState  
3. 流结束瞬间助手气泡闪一下消失再出现  

## 复现（期望）

添加模型对话 → 流式 + 工具多轮 / 关窗 / 看流结束瞬间。

## 路径

快速通道（审计已定位 file:line）。
