---
doc_type: feature-ff-note
feature: profile-test-max-tools
date: 2026-07-13
requirement:
tags: [llm-profile, tools, curl, shell]
---

## 做了什么
模型配置里的对话测试改为更开放的工具能力：除了删除能力不开放，其它读写移动、搜索、模型配置、curl 和 shell 测试能力尽量给足。

## 改了哪些
- `apps/service/src/llm-service.ts` — profile chat 工具列表移除 `delete_path`，执行层也拒绝旧删除调用。
- `apps/service/src/llm-service.ts` — curl 放开本地/内网/公网 URL、鉴权请求头、请求体和常见非删除 HTTP 方法，并扩大响应/超时上限。
- `apps/service/src/llm-service.ts` — 新增 `run_shell_command`，按真实 shell 执行命令并拦截删除/清理类命令。

## 怎么验证的
跑了 `apps/service` 的 `tsc --noEmit` 和 `git diff --check`；未跑业务测试。
