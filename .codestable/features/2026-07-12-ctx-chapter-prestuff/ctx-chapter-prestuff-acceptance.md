# ctx-chapter-prestuff 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-07-12
> 关联方案 doc：`.codestable/features/2026-07-12-ctx-chapter-prestuff/ctx-chapter-prestuff-design.md`

## 1. 接口契约核对

- [x] `buildChapterContextPrompt` / `ChapterContextMaterials` 落在 `context/build-chapter-context.ts`
- [x] 默认不含正文/longform 正文块；含 path_map；story_state ≤ maxChars
- [x] review 后修复：head/tail 截断、system 短路径、author_brief 日志、include+maxChars=0

## 2. 行为与决策核对

- [x] `runChapterAssistant` 条件读盘 + builder + `chapter.chat.prestuff`
- [x] system 含「须 read_text_file」
- [x] 未改 LoopCompressor / claim / profile·init / compaction 算法
- [x] 挂载点可卸载：去掉 builder 接线即回退

## 3. 验收场景核对

- [x] N1–N4 / B1 / include+maxChars=0 / longform 留尾 — 单测通过（16 测含 policy）
- [x] E1/E2 grep 接线与工具仍在

## 4. 术语一致性

- [x] ContextPolicy / prestuff blockId / buildChapterContextPrompt 与 design 一致

## 5. 架构归并

- [x] 更新 `ARCHITECTURE.md`：章节首包由 ContextPolicy 驱动，正文默认不预塞

## 6. requirement 回写

- [x] 无（内部能力，requirement 空）

## 7. roadmap 回写

- [x] `ctx-chapter-prestuff` → done

## 8. attention.md 候选

- [x] 无新增必记项（pnpm 候选仍可按用户意愿另 note）

## 9. 遗留

- 后续：`ctx-tool-output-prune` / claim-guard / loop-summarizer
