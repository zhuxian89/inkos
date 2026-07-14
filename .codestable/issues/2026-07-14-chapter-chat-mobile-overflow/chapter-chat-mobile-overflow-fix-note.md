---
doc_type: issue-fix
issue: 2026-07-14-chapter-chat-mobile-overflow
status: fixed
severity: P2
path: fast-track
fix_date: 2026-07-14
tags: [chapter-chat, mobile, layout, overflow]
---

# 章节对话移动端横向溢出修复记录

## 1. 问题描述

在手机端打开章节对话框时，内容区域被撑出对话框宽度。横向溢出被裁掉后，消息和操作按钮只能显示一部分。

## 2. 根因

`apps/web/app/ui/book-chapters.tsx` 的移动端单列网格使用 `1fr`。该写法的默认最小尺寸会受子内容的固有宽度影响，不能在窄屏中可靠收缩；外层的 `overflow: hidden` 随后裁掉超出的部分。

## 3. 修复方案

将单列网格轨道改为 `minmax(0, 1fr)`，允许聊天面板在对话框可用宽度内收缩。

## 4. 改动文件清单

- `apps/web/app/ui/book-chapters.tsx`
- `.codestable/issues/2026-07-14-chapter-chat-mobile-overflow/chapter-chat-mobile-overflow-fix-note.md`

## 5. 验证结果

- 静态检查：移动端网格轨道现在允许收缩，横向内容不再能将网格的最小宽度撑出模态框。
- 未启动开发服务，遵从本次要求；未执行浏览器实测。

## 6. 遗留事项

建议在实际手机视口打开章节对话框，确认消息区和“停止 / 更多 / 发送”按钮完整可见。
