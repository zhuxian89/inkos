---
doc_type: audit-index
audit: 2026-07-12-profile-chat-ux
scope: profile ChatKit + SSE（chat-kit/、setup-workspace、llm-routes chat-stream、llm-service tool 回调）
created: 2026-07-12
status: active
total_findings: 6
---

# profile-chat-ux 代码审计

## 范围

- `apps/web/app/ui/chat-kit/**`
- `apps/web/app/ui/setup-workspace.tsx`（流式消费 / ChatKit 接线）
- `apps/service/src/llm-routes.ts`（profile chat-stream 事件）
- `apps/service/src/llm-service.ts`（`onToolStart` / `onToolEnd`）

未扫：章节/书本对话、mindfs 仓库本身。

## 总评

方向正确：SSE 事件对齐、ThinkingBlock 抄写、输入区留 antd、业务面未扩散。主要风险在**多轮 tool 时时间线状态机**和**无取消/关窗仍写 state**；另有流式结束瞬间 UI 闪一下、缺 reducer 单测等次要项。整体可上线试玩，建议先修 P1 再推广到其它对话。

## 发现清单

| # | 性质 | 严重度 | 置信度 | 标题 | 文件 |
|---|---|---|---|---|---|
| 1 | bug | P1 | high | 多轮 tool 后中间 assistant 气泡残留 | [finding-01.md](finding-01.md) |
| 2 | bug | P1 | high | 关窗/切配置无 Abort，流式仍 setState | [finding-02.md](finding-02.md) |
| 3 | bug | P2 | high | live→persist 切换时短暂少一条助手消息 | [finding-03.md](finding-03.md) |
| 4 | performance | P2 | medium | 每个 token chunk 全量 setState | [finding-04.md](finding-04.md) |
| 5 | maintainability | P2 | high | applyProfileStreamEvent 无单测 | [finding-05.md](finding-05.md) |
| 6 | arch-drift | P2 | medium | roadmap「antd 底座」与自绘块需文档一致（已口头澄清） | [finding-06.md](finding-06.md) |

## 按维度分布

| 性质 | P0 | P1 | P2 | 合计 |
|---|---|---|---|---|
| bug | 0 | 2 | 1 | 3 |
| security | 0 | 0 | 0 | 0 |
| performance | 0 | 0 | 1 | 1 |
| maintainability | 0 | 0 | 1 | 1 |
| arch-drift | 0 | 0 | 1 | 1 |
| **合计** | **0** | **2** | **4** | **6** |

## 下一步建议

- **P1**：开 `cs-issue` 修多轮时间线 + AbortController
- **P2**：有空再做闪烁、rAF 节流、单测
- 文档口径已在 roadmap §2 UI 原则写清，finding-06 可只确认不另改代码
