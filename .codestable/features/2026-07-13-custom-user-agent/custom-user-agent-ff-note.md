---
doc_type: feature-ff-note
feature: custom-user-agent
date: 2026-07-13
requirement:
tags: [llm, profile, headers]
---

## 做了什么
模型配置新增可自定义 User-Agent 字段，默认仍是 `curl/8.0`。获取模型列表、测试模型、保存后的 profile 对话和全局 LLM 配置都会使用该值。

## 改了哪些
- `packages/core/src/models/project.ts` / `packages/core/src/llm/provider.ts` — LLM 配置新增 `userAgent`，OpenAI/Anthropic SDK 默认请求头按配置生成。
- `apps/service/src/llm-service.ts` / `apps/service/src/llm-routes.ts` — profile DB/API/env/init/chat/model-list 全链路支持 `user_agent`，profile curl 工具默认也使用同一 User-Agent。
- `apps/web/app/ui/setup-workspace.tsx` — 添加/编辑模型弹窗增加 User-Agent 输入框，获取模型、测试和保存都会提交。
- `packages/cli/src/commands/config.ts` / `apps/service/src/command-registry.ts` — CLI 与命令面板支持 `--user-agent`。

## 怎么验证的
先用 `packages/core` 的 `tsc` 构建本地声明，再跑 `packages/core`、`apps/service`、`apps/web`、`packages/cli` 的 `tsc --noEmit`；`git diff --check` 通过。没有跑业务测试。
