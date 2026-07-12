---
doc_type: audit-index
audit: 2026-07-12-profile-chat-mindfs-parity
scope: profile chat mindfs 1:1 parity（工具流、ChatKit 时间线、ToolCallCard 展示）
created: 2026-07-12
status: active
total_findings: 3
supersedes: 2026-07-12-profile-chat-fe-be
---

# profile-chat-mindfs-parity 审计报告

## 范围

本次只审计 profile chat 的 mindfs 1:1 还原度：

- `apps/service/src/llm-service.ts`：profile 工具执行、ToolCall 信息模型构造
- `apps/service/src/llm-routes.ts`：profile `chat-stream` SSE 事件
- `apps/web/app/ui/setup-workspace.tsx`：SSE 消费、live items 与持久化接线
- `apps/web/app/ui/chat-kit/**`：时间线、ThinkingBlock、ToolCallCard
- 对照源：`/Users/hongweizhang/java_project/mindfs/web/src/components/stream/ToolCallCard.tsx`、`SessionViewer.tsx`、`services/session.ts`

未扫：章节/书本对话入口、mindfs 服务端本身、Anthropic/Responses 路径。

## 总评

不能确认现在已经 1:1。当前实现已经比上一轮明显接近 mindfs：后端发 `ProfileToolCall`，前端类型也承载 `kind/title/content/locations/meta/result`，roadmap 也删除了“降级/摘要优先”的口径。但仍有 1 条 P1 和 2 条 P2：最严重的是 stream 结束后把 live 工具时间线丢掉，只持久化 assistant 的正文和 reasoning，因此用户回答结束后仍可能看不到读/改/搜工具命令。其余差距是 ToolCallCard 还没有 mindfs 的远程详情加载、ANSI/Markdown diff/progress 等行为，以及写文件工具缺少真实 old/new diff 证据。

Ant Design 不是阻塞原因。AntD 可以承载折叠、标签、图标、布局、代码块外壳；当前差距来自状态模型、持久化模型和 ToolCallCard 移植不完整，而不是 Ant Design 组件能力差。

## 发现清单

| # | 性质 | 严重度 | 置信度 | 标题 | 文件 |
|---|---|---|---|---|---|
| 1 | arch-drift | P1 | high | final 后清空 live items，工具时间线不能按 mindfs 留在回答中 | [finding-01.md](finding-01.md) |
| 2 | arch-drift | P2 | high | ToolCallCard 仍缺 mindfs 的远程详情、ANSI、Markdown diff 与 progress 行为 | [finding-02.md](finding-02.md) |
| 3 | arch-drift | P2 | medium | 写文件工具只展示新内容，缺少真实 old/new diff 证据 | [finding-03.md](finding-03.md) |

## 按维度分布

| 性质 | P0 | P1 | P2 | 合计 |
|---|---|---|---|---|
| bug | 0 | 0 | 0 | 0 |
| security | 0 | 0 | 0 | 0 |
| performance | 0 | 0 | 0 | 0 |
| maintainability | 0 | 0 | 0 | 0 |
| arch-drift | 0 | 1 | 2 | 3 |
| **合计** | **0** | **1** | **2** | **3** |

## 修复状态

- finding-01 已通过 issue `2026-07-12-profile-chat-mindfs-parity` 修复。
- finding-02 已通过 issue `2026-07-12-profile-chat-mindfs-parity` 修复 profile chat 当前路径。
- finding-03 保持 open：写文件工具真实 old/new diff 本次按用户要求暂不处理。

## 下一步建议

- **剩余 open 项**：finding-03。后续若继续追 1:1，需要让 `write_text_file` 生成真实 old/new diff 证据。
