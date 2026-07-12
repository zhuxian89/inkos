---
doc_type: feature-design
feature: 2026-07-12-ctx-retire-legacy-compaction
requirement:
roadmap: context-management-v2
roadmap_item: ctx-retire-legacy-compaction
status: approved
summary: 退役 chapter/profile/init 进模前 compactConversationMessages 主路径；保留 estimateTokens 等辅助导出
tags: [context, compaction, retire, roadmap]
---

# ctx-retire-legacy-compaction design

## 1

三处 chat 入口不再调用 `compactConversationMessages`。保留 `compaction.ts` 中 `estimateTokens` / `extractStructuredSummary`。旁路以 `INKOS_DISABLE_LOOP_COMPRESS` 为准。明确不做：不删除整个 compaction.ts（测试仍覆盖旧函数）。

## 2–3

挂载：llm-service 三入口去掉 compact；文件头标注 legacy。验收：grep llm-service 无 compactConversationMessages。

## 4

ARCHITECTURE：旧进模前压缩已退役。
