---
doc_type: feature-design
feature: 2026-07-12-ctx-wire-chapter
requirement:
roadmap: context-management-v2
roadmap_item: ctx-wire-chapter
status: approved
summary: 确认章节对话同时启用 prestuff、maybeCompress、WriteIntegrity；补齐可观测日志
tags: [context, bridge, chapter-chat, roadmap]
---

# ctx-wire-chapter design

## 0–1

章节路径汇合点：prestuff + loop compress + claim-guard。明确不做：不改 profile/init（下一条）；不删 compaction 文件（retire 做）。

## 2

**现状→变化**：各能力已分别接线；本条核对 chapter 出口完整且日志为 `chapter.chat.compress` / `chapter.chat.prestuff`。

挂载点：`runChapterAssistant` + `runToolEnabledConversation(contextMode=chapter)`。

## 3

| # | 期望 |
|---|---|
| E1 | chapter 调用带 contextMode chapter |
| E2 | 使用 finalize + honest fallback |
| E3 | 使用 maybeCompressConversation |

## 4

ARCHITECTURE ChatRuntimeBridge：chapter 垂直打通。
