---
doc_type: issue-fix
issue: 2026-07-12-profile-chat-stream-bugs
status: fixed
fixed_date: 2026-07-12
related_audit: 2026-07-12-profile-chat-ux
---

# profile-chat-stream-bugs 修复记录

## 根因

1. `applyProfileStreamEvent` 的 `final` 只更新当前 `assistantTextId`，多轮 tool 留下的中间 `assistant_text` 不清理  
2. `sendProfileChat` 无 `AbortController`，关窗后仍写 React state  
3. stream 结束先清 `profileLiveItems` 再写 messages，造成闪烁  

## 修复

| 文件 | 改动 |
|---|---|
| `chat-kit/apply-profile-stream-event.ts` | `final` 丢弃中间 assistant_text，保留 tool，只留一条 thought + 一条终态正文 |
| `setup-workspace.tsx` | AbortController；关窗 abort；先写 messages 再清 live；abort 后不写成功态 |
| `apps/web/scripts/check-profile-stream-reducer.ts` | 轻量校验脚本（web 无 vitest） |

## 验证

- [x] `apps/web` tsc --noEmit  
- [ ] 手工：多轮 tool 流结束后只剩工具卡 + 一条终态回复；关窗可取消且不再写错会话  

（web 包无 vitest，未加自动化用例）

## 对应审计

- finding-01 / 02 / 03 已处理  
- finding-05（单测）未自动化，仍可后续补  
- finding-04（chunk 节流）未改，仍为 P2
