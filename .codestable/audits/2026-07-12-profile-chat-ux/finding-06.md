---
doc_type: audit-finding
audit: 2026-07-12-profile-chat-ux
finding_id: "arch-drift-06"
nature: arch-drift
severity: P2
confidence: medium
suggested_action: cs-refactor
status: open
---

# Finding 06：UI 策略文档曾摇摆，实现已按「抄不冲突 / 冲突才 antd」

## 速答

实现上 ThinkingBlock 等为自绘抄写、Input/Button 为 antd，符合你澄清的原则；需保证 roadmap 正文与代码注释长期一致（已在 roadmap §2 补原则）。

## 关键证据

- `ThinkingBlock.tsx` — mindfs 自绘抄写
- `ChatKitPanel.tsx` — 注释写明输入区用 antd
- `profile-chat-ux-roadmap.md` §2 UI 落地原则 — 已更新

## 影响

无运行时 bug；防止下次 review/新人又全盘 antd 化或全盘 mindfs 化。

## 修复方向

保持文档；无需改代码（除非要把原则再写进 `.codestable/attention.md`）。

## 建议动作

可选 `cs-note` 记一句到 attention；非必须。
