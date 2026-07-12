---
doc_type: feature-ff-note
feature: safe-curl-profile-tools
date: 2026-07-13
requirement:
tags: [llm-profile, tools, curl]
---

## 做了什么
给模型对话增加安全的 `curl` 工具能力，只允许读取公网 HTTP(S) GET/HEAD。模型配置入口改成 OpenAI-compatible 单一路径，并让高级字段自动使用默认值。

## 改了哪些
- `apps/service/src/llm-service.ts` — 增加安全 curl 工具、工具卡映射、模型列表/能力测试的 OpenAI-compatible 逻辑。
- `apps/service/src/llm-routes.ts` — 模型配置 API 限制为 OpenAI-compatible，并在后端写入默认 temperature/max tokens/thinking/api format。
- `apps/web/app/ui/setup-workspace.tsx` — 添加/编辑模型支持拉取模型、选择模型、测试文本/工具/thinking，移除 Anthropic 选择。
- `apps/web/app/ui/inkos-console.tsx`、`packages/cli/src/commands/*` — 初始化和全局配置入口不再暴露 Anthropic。

## 怎么验证的
跑了 `apps/service`、`apps/web`、`packages/cli` 的 `tsc --noEmit`，以及 `git diff --check`；未跑业务测试。
