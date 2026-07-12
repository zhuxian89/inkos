---
doc_type: issue-fix
issue: 2026-07-12-profile-chat-markdown-table
status: fixed
created: 2026-07-12
severity: P2
tags: [profile-chat, markdown, table, chat-kit]
path: fast-track
---

# profile-chat-markdown-table 修复记录

## 现象

profile 模型对话回答书籍列表时输出了类似表格的内容：

```text
# 书名 状态 章节数
1 ...
2 ...
```

但 UI 没有呈现成真正表格。

## 判断

这主要是模型没有输出标准 Markdown 表格。标准 GFM 表格必须包含管道和分隔行，例如：

```markdown
| # | 书名 | 状态 | 章节数 |
|---|---|---|---|
| 1 | ... | ... | ... |
```

同时，ChatKit 的 Markdown renderer 虽然启用了 `remarkGfm`，但没有给 table/th/td 配样式；即使模型输出了标准表格，视觉也不如旧 `ChatPanel` 清晰。

## 修复

- `apps/service/src/llm-service.ts`
  - profile chat system prompt 增加明确约束：展示书籍列表、章节列表、对比数据等表格信息时，必须输出标准 GitHub-Flavored Markdown 管道表格，禁止用空格或制表符伪装表格。
- `apps/web/app/ui/chat-kit/ChatKitMarkdown.tsx`
  - 增加 `table` / `th` / `td` 渲染样式，和旧 ChatPanel 的表格可读性对齐。

## 验证

按用户要求，本轮不跑测试命令，由用户在本地页面验证。

## 验收点

再次询问本地书籍列表时，模型应输出标准 Markdown 表格；前端应把它渲染成有表头、边框、单元格的表格。
