---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-ux
finding_id: "maintainability-05"
nature: maintainability
severity: P2
confidence: high
suggested_action: cs-issue
status: open
---

# Finding 05：applyProfileStreamEvent 无单测

## 速答

时间线 reducer 是核心状态机，仅有实现文件，无 vitest/用例覆盖 tool 交错、final 校正等。

## 关键证据

- 存在 `apply-profile-stream-event.ts`，`apps/web` / `apps/service` 测试目录无对应 `*stream*` / `*chat-kit*` 单测

## 影响

finding-01 类回归不易发现；后续改协议易踩坑。

## 修复方向

给 `applyProfileStreamEvent` 加纯函数单测（chunk / tool / final / 多轮）。

## 建议动作

可挂在修 finding-01 的 `cs-issue` 里一起做。
