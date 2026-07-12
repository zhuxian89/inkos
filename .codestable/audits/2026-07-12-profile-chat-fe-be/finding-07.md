---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-fe-be
finding_id: "maintainability-07"
nature: maintainability
severity: P2
confidence: high
suggested_action: cs-refactor
status: open
---

# Finding 07：流式 reducer 无自动化回归

## 速答

`applyProfileStreamEvent` 是时间线正确性核心，却没有进 CI 的自动化用例；上轮靠手工 + 可选脚本，本轮仍能长出「tool 边界未复位」类回归。

## 关键证据

- `apps/web/app/ui/chat-kit/apply-profile-stream-event.ts` — 纯函数，天然可单测
- 旧 fix-note 写明 web 无 vitest，仅有 `apps/web/scripts/check-profile-stream-reducer.ts`（未进本审计强制依赖）
- 本审计 finding-01 即该类无测试易漏场景

## 影响

后续再改 SSE 事件或 final 策略时，高概率再次引入「直播态/落盘态不一致」。

## 修复方向

给 reducer 加最小用例矩阵（单轮 reasoning、tool 前后 chunk、final 收敛、abort 无关）；或把 check 脚本挂进 CI。

## 建议动作

`cs-refactor` / 测试债；与功能 issue 可并行。
