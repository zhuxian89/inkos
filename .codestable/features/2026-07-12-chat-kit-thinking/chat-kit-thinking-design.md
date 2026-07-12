---
doc_type: feature-design
feature: 2026-07-12-chat-kit-thinking
requirement:
roadmap: profile-chat-ux
roadmap_item: chat-kit-thinking
status: approved
summary: 移植 mindfs ThinkingBlock 与 ChatKit 类型/文本区，作为 profile 对话 UI 基线
tags: [chat-kit, thinking, mindfs, ui, roadmap]
---

# chat-kit-thinking design

## 0. 术语

| 术语 | 定义 |
|---|---|
| ThinkingBlock | mindfs 风格思考折叠块，默认收起 |
| ChatKitItem | roadmap §4.2 时间线项 |

## 1. 决策

- 做什么：新建 `apps/web/app/ui/chat-kit/`，导出 `ThinkingBlock`、`ChatKitMarkdown`、类型。
- 明确不做：不接线 setup-workspace；不做工具卡；不改章节 ChatPanel。
- 视觉：对齐 mindfs（紫标题「思考过程」、字符数、maxHeight 200）。

## 2–4

挂载：`chat-kit/ThinkingBlock.tsx`、`types.ts`、`index.ts`。验收：组件可渲染、默认折叠。
