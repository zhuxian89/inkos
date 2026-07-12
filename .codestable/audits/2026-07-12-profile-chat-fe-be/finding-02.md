---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-fe-be
finding_id: "bug-02"
nature: bug
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 02：chat-stream 客户端断开后服务端仍跑 LLM

## 速答

前端关窗会 `AbortController.abort()` 停 fetch，但 `/api/llm-profiles/:id/chat-stream` **没有**把 `req` close 接到 `abortSignal`，服务端继续 `runProfileChatWithTools` 烧 token / 调工具。

## 关键证据

- `apps/service/src/llm-routes.ts:481-512` — `runProfileChatWithTools(...)` 传入了 delta/tool 回调，**未传** `abortSignal`
- `apps/service/src/llm-service.ts:595-610` — 能力已具备：`options.abortSignal` 会进 `chatWithTools`
- 对照同文件 job 路径：`llm-routes.ts:57-70` 等使用 `ensureJobAbortController` + `abortSignal`
- `apps/web/app/ui/setup-workspace.tsx:920-924` — Modal `onCancel` 已 abort 客户端；只停读流，不停服务端

## 影响

用户连点开关窗 / 重发：服务端可能并行多路 profile tool loop；计费与 DB/工具副作用风险上升。本地试玩不明显，服务器压测或反复取消时明显。

## 修复方向

`req.on("close")` / `res.on("close")` 触发 `AbortController`，并传入 `runProfileChatWithTools({ abortSignal })`；`sendEvent` 已有 `writableEnded` 守卫可保留。

## 建议动作

`cs-issue`，行为缺陷 + 成本/副作用，不是纯重构。
