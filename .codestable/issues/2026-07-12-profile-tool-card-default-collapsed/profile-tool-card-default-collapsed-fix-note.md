---
doc_type: issue-fix
issue: 2026-07-12-profile-tool-card-default-collapsed
status: fixed
created: 2026-07-12
severity: P2
tags: [profile-chat, tool-card, chat-kit, ui]
path: fast-track
---

# profile-tool-card-default-collapsed 修复记录

## 现象

profile chat 的工具卡完成后默认展开，直接露出参数、结果和详情。用户期望默认只显示类似：

```text
list_books
call_f3982b1e1bce46b0a369a64e
```

点击后才展开详情。

## 根因

- `ChatKitPanel` 对非 running 工具传入 `defaultExpanded=true`。
- `ToolCallCard` 在工具状态进入终态后也会自动 `setExpanded(true)`。

## 修复

- `ChatKitPanel` 不再给完成态工具卡传 `defaultExpanded`。
- `ToolCallCard` 不再因为完成态自动展开；只在显式 `defaultExpanded` 或错误详情存在时展开。

## 验收点

- 成功完成的 `list_books` / `read_text_file` / `search_text_files` 工具卡默认折叠。
- 点击工具卡 header 后展开参数、位置、结果等详情。
- 失败工具仍可自动展开错误信息，便于排错。

## 验证

按用户要求，本轮不跑测试命令；仅做代码 diff 检查。
