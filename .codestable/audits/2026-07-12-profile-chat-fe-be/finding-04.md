---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-fe-be
finding_id: "bug-04"
nature: bug
severity: P2
confidence: high
suggested_action: cs-issue
status: open
---

# Finding 04：final 只保留末轮正文，tool 前口播会闪掉

## 速答

为修旧审计「中间气泡残留」，`final` 丢弃所有中间 `assistant_text`，后端 `content` 又是 **最后一轮** `lastAssistantMessage`；tool 前的口播在流式中出现、结束后消失。

## 关键证据

- `apps/web/app/ui/chat-kit/apply-profile-stream-event.ts:114-143` — `final` 跳过全部既有 `assistant_text`，只 append 一条终态
- `apps/service/src/llm-service.ts:685-687` — `lastAssistantMessage = result.content` 每轮覆盖
- 与 mindfs「交错时间线保留 tool 前文本」不一致（产品若接受可降为 wontfix）

## 影响

多 tool 对话结束瞬间时间线「抽一截」；落盘也没有 tool 前口播。非正确性崩溃，但是体验回归点。

## 修复方向

要么 final 保留分段 assistant（标明 intermediate），要么后端把多轮正文拼进 `final.content` 并统一协议。

## 建议动作

`cs-issue`（若要对齐 mindfs）；若产品接受「只看终态」可关 issue 并写进约定。
