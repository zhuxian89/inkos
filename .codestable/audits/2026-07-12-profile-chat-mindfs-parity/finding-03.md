---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-mindfs-parity
finding_id: "arch-drift-03"
nature: arch-drift
severity: P2
confidence: medium
suggested_action: cs-issue
status: open
---

# Finding 03：写文件工具缺少真实 diff 证据

## 速答

`write_text_file` 工具卡目前用模型传入的新 `content` 构造“add”文本块，没有读取旧文件内容并生成 old/new diff；这和 mindfs 的 diff 证据展示不等价。

## 关键证据

- `apps/service/src/llm-service.ts:602` — `write_text_file` 分支只从 `input.args.content` 取新内容。
- `apps/service/src/llm-service.ts:605` — 新内容被标记为 `changeKind: "add"`，没有 `oldText`。
- `apps/service/src/llm-service.ts:782` — 实际写文件前直接 `writeFile(filePath, content, "utf-8")`，没有保留旧内容给 ToolCall。
- `/Users/hongweizhang/java_project/mindfs/web/src/components/stream/ToolCallCard.tsx:840` — mindfs 对 `type: "diff"` 的 content 使用 `oldText/newText` 构造 diff。

## 影响

用户能看到写入了哪个文件和新内容，但看不到“修改了什么”。如果文件很长，这会退化成全量内容块，难以审查，也不符合 mindfs 对修改证据的展示方式。

## 修复方向

`write_text_file` 执行前读取旧文件（不存在时视为空），成功后构造 `{ type: "diff", oldText, newText, path }`；必要时对大文件做可展开详情或本地缓存，避免 UI 一次性塞超长 diff。

## 建议动作

`cs-issue`，因为这是用户可见的工具证据不完整问题，属于 1:1 parity 缺口。
