---
doc_type: feature-ff-note
feature: model-profile-picker-tests
date: 2026-07-13
requirement:
tags: [llm-profile, model-picker, capability-test]
---

## 做了什么

优化添加/编辑模型配置体验：可以用 URL + Key 拉取模型列表，并在保存前测试当前配置的文本、工具调用、思考能力。

## 改了哪些

- `apps/service/src/llm-service.ts` — 新增模型列表读取和 profile 能力测试逻辑。
- `apps/service/src/llm-routes.ts` — 新增 `/api/llm-profiles/models` 与 `/api/llm-profiles/test-config`。
- `apps/web/app/ui/setup-workspace.tsx` — 模型字段改为可选列表，补高级配置和“测试当前配置”。
- `apps/web/app/api/inkos/llm-profiles/*` — 新增 Next 代理路由。

## 怎么验证的

已跑 service/web TypeScript typecheck 和 `git diff --check`。没有跑业务测试、没有启动服务。
