---
doc_type: feature-ff-note
feature: reasoning-effort
date: 2026-07-13
requirement:
tags: [llm, profile, reasoning]
---

## 做了什么
模型配置新增“思考强度”选项，支持默认 / low / medium / high，并在保存、测试和对话请求里透传给 OpenAI-compatible provider。

## 改了哪些
- `packages/core/src/models/project.ts` / `packages/core/src/llm/provider.ts` — LLM 配置新增 `reasoningEffort`，Chat Completions 走 `reasoning_effort`，Responses 走 `reasoning.effort`。
- `apps/service/src/llm-service.ts` / `apps/service/src/llm-routes.ts` — profile DB、create/update/test/init、全局 env 写入和 profile chat client 创建都支持思考强度。
- `apps/web/app/ui/setup-workspace.tsx` — 添加/编辑模型弹窗增加“思考强度”，选择“默认”会清空旧值。
- `packages/cli/src/commands/config.ts` / `apps/service/src/command-registry.ts` — CLI 和命令面板支持 `--reasoning-effort`。

## 怎么验证的
先用 `packages/core` 的 `tsc` 构建本地声明，再跑 `packages/core`、`apps/service`、`apps/web`、`packages/cli` 的 `tsc --noEmit`；`git diff --check` 通过。没有跑业务测试。
