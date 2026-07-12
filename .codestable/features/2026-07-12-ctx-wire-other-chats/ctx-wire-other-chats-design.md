---
doc_type: feature-design
feature: 2026-07-12-ctx-wire-other-chats
requirement:
roadmap: context-management-v2
roadmap_item: ctx-wire-other-chats
status: approved
summary: profile/init 共用 runToolEnabledConversation 的 compress + WriteIntegrity；差异仅 ContextPolicy.mode
tags: [context, bridge, profile, init, roadmap]
---

# ctx-wire-other-chats design

## 1

profile/init 传入对应 `contextMode`；共享 loop 压缩与 claim 装订。不做：不改章节 prestuff。

## 2–3

挂载：`runProfileChatWithTools` / init assistant → `contextMode` profile|init。验收：两处均传 mode；不再依赖进模前 compact。

## 4

ARCHITECTURE：三 mode 共用 Bridge。
