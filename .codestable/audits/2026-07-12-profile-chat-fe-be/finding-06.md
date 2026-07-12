---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-fe-be
finding_id: "security-06"
nature: security
severity: P2
confidence: medium
suggested_action: cs-issue
status: open
---

# Finding 06：Markdown 链接未约束 javascript:/data:

## 速答

助手正文经 `react-markdown` 渲染，自定义 `a` 直接使用模型给的 `href`，未拦截 `javascript:` / 危险 `data:`。

## 关键证据

- `apps/web/app/ui/chat-kit/ChatKitMarkdown.tsx:32-36` — `<a href={href} target="_blank" rel="noreferrer">`
- 未使用 `rehype-sanitize` / URL 协议白名单
- 内容来源为 LLM（及未来可能的工具拼进正文），信任边界在模型输出

## 影响

恶意或被投毒的模型输出可诱导点击执行脚本（取决于浏览器对 `javascript:` 在 `target=_blank` 下的行为）；风险低于 `dangerouslySetInnerHTML`，但 profile 聊天是运维常用面，仍值得收紧。

## 修复方向

只允许 `http:`/`https:`/`mailto:`；其余渲染为纯文本或去掉 `href`。

## 建议动作

`cs-issue`，小补丁安全加固。
