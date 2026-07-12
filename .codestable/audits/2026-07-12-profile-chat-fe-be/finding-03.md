---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-fe-be
finding_id: "bug-03"
nature: bug
severity: P1
confidence: high
suggested_action: cs-issue
status: fixed
---

# Finding 03：persist 漏写 useStream / includeReasoning

## 速答

改题材、改平台、清空对话时 `persistProfileChat` **不带** `useStream` / `includeReasoning`，会把 localStorage 里用户关掉的「展示 reasoning」等开关冲掉。

## 关键证据

- `apps/web/app/ui/setup-workspace.tsx:946-950` — 改 genre 只写 `messages/genre/platform`
- `apps/web/app/ui/setup-workspace.tsx:963-966` — 改 platform 同上
- `apps/web/app/ui/setup-workspace.tsx:1030-1034` — 清空对话同上
- 对照正确写法：`979-985` / `997-1003` Checkbox 变更会带齐两个开关
- 读取侧：`210` / `371` — `includeReasoning !== false`：键缺失时当作 **true**，因此「关掉 reasoning → 换题材 → 重开」会变回勾选

## 影响

用户明确取消「展示 reasoning」后，只要改一下题材/平台或点清空，下次打开又默认开启；与服务器测试「到底有没有带 includeReasoning」时会造成假阴性/假阳性。

## 修复方向

所有 `persistProfileChat` 调用统一带上当前 `useStream` / `includeReasoning`（或 persist 内部 merge 旧 meta）。

## 建议动作

`cs-issue`，小改但会直接干扰本次 reasoning 联调。
