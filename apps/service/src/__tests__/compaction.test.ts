import { describe, it, expect } from "vitest";
import { compactConversationMessages, truncateContextPrompt, extractStructuredSummary, estimateTokens } from "../compaction.js";

type Msg = { role: "system" | "user" | "assistant"; content: string };

describe("estimateTokens", () => {
  it("estimates Chinese text at ~2.5 chars per token", () => {
    expect(estimateTokens("你好世界测试")).toBe(3); // 6 chars / 2.5 = 2.4 → ceil 3
  });
});

describe("compactConversationMessages", () => {
  it("returns messages unchanged when within budget", () => {
    const messages: Msg[] = [
      { role: "system", content: "你是助手。" },
      { role: "user", content: "上下文信息。" },
      { role: "user", content: "帮我写一段。" },
      { role: "assistant", content: "好的。" },
    ];
    const result = compactConversationMessages(messages);
    expect(result.stats.compressionTriggered).toBe(false);
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]!.content).toBe("你是助手。");
  });

  it("compresses middle messages when over budget", () => {
    const messages: Msg[] = [
      { role: "system", content: "系统提示。" + "X".repeat(2000) },
      { role: "user", content: "上下文。" + "Y".repeat(2000) },
    ];
    // Add 20 turn pairs with substantial content
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `第${i + 1}轮：我确认主角叫李明。${"内容".repeat(200)}` });
      messages.push({ role: "assistant", content: `第${i + 1}轮：确定采用这个方案。已修改了文件。${"回复".repeat(200)}` });
    }

    const result = compactConversationMessages(messages, { totalBudget: 3000, tailTurns: 3 });

    expect(result.stats.compressionTriggered).toBe(true);
    expect(result.stats.compactedTokenEstimate).toBeLessThan(result.stats.originalTokenEstimate);

    // Head preserved
    expect(result.messages[0]!.content).toContain("系统提示");
    expect(result.messages[1]!.content).toContain("上下文");

    // Summary exists with 4 sections
    const summary = result.messages.find((m) => m.content.includes("[历史摘要，仅供回忆"));
    expect(summary).toBeDefined();
    expect(summary!.role).toBe("assistant");
    expect(summary!.content).toContain("## 已确认设定");
    expect(summary!.content).toContain("## 关键改动");
    expect(summary!.content).toContain("## 未决问题");
    expect(summary!.content).toContain("## 硬约束");

    // Tail preserved (last 3 turns = 6 messages)
    const lastOriginal = messages[messages.length - 1]!;
    expect(result.messages[result.messages.length - 1]!.content).toBe(lastOriginal.content);
  });

  it("respects INKOS_DISABLE_COMPACTION feature flag", () => {
    const original = process.env.INKOS_DISABLE_COMPACTION;
    process.env.INKOS_DISABLE_COMPACTION = "true";
    try {
      const messages: Msg[] = [
        { role: "system", content: "X".repeat(100000) },
        { role: "user", content: "Y".repeat(100000) },
      ];
      const result = compactConversationMessages(messages, { totalBudget: 100 });
      expect(result.stats.compressionTriggered).toBe(false);
      expect(result.messages).toHaveLength(2);
    } finally {
      if (original === undefined) {
        delete process.env.INKOS_DISABLE_COMPACTION;
      } else {
        process.env.INKOS_DISABLE_COMPACTION = original;
      }
    }
  });

  it("uses profile mode without assuming a dedicated context message", () => {
    const messages: Msg[] = [{ role: "system", content: "Profile system." + "S".repeat(2000) }];
    for (let i = 0; i < 12; i += 1) {
      messages.push({ role: "user", content: `用户第${i + 1}轮消息 ${"U".repeat(250)}` });
      messages.push({ role: "assistant", content: `助手第${i + 1}轮回复，确认采用当前方案。${"A".repeat(250)}` });
    }

    const result = compactConversationMessages(messages, { totalBudget: 2500, tailTurns: 2, mode: "profile" });

    expect(result.stats.compressionTriggered).toBe(true);
    expect(result.messages[0]!.role).toBe("system");
    expect(result.messages[0]!.content).toContain("Profile system");
    const summary = result.messages.find((m) => m.content.includes("[历史摘要，仅供回忆"));
    expect(summary).toBeDefined();
    expect(summary!.role).toBe("assistant");
  });

  it("guarantees the final result stays within the requested total budget", () => {
    const messages: Msg[] = [
      { role: "system", content: "系统提示。" + "S".repeat(6000) },
      { role: "user", content: "上下文信息。\n\n当前章节正文：\n" + "正".repeat(12000) },
    ];
    for (let i = 0; i < 20; i += 1) {
      messages.push({ role: "user", content: `用户第${i + 1}轮：${"U".repeat(800)}` });
      messages.push({ role: "assistant", content: `助手第${i + 1}轮：确定采用当前方向。${"A".repeat(800)}` });
    }

    const result = compactConversationMessages(messages, { totalBudget: 2200, tailTurns: 4, mode: "chapter" });
    expect(result.stats.compactedTokenEstimate).toBeLessThanOrEqual(2200);
  });
});

describe("truncateContextPrompt", () => {
  it("removes P1 file path lists first", () => {
    const content = [
      "书籍：测试书（test-book）",
      "当前状态卡：\n状态内容",
      "已确认真实章节文件：\n- /a/b/c.md\n- /a/b/d.md",
      "已确认真实 story 文件：\n- /a/b/story.md",
      "当前章节正文：\n" + "正文".repeat(3000),
    ].join("\n\n");

    // Set budget small enough that truncation is needed
    const result = truncateContextPrompt(content, 1500);

    expect(result).not.toContain("已确认真实章节文件");
    expect(result).not.toContain("已确认真实 story 文件");
    expect(result).toContain("书籍：测试书");
    expect(result).toContain("当前状态卡");
  });

  it("truncates chapter summaries and content when still over budget", () => {
    const content = [
      "书籍：测试",
      "章节摘要：\n" + "摘要行\n".repeat(500),
      "当前章节正文：\n" + "正".repeat(20000),
    ].join("\n\n");

    const result = truncateContextPrompt(content, 3000);

    expect(result).toContain("书籍：测试");
    expect(result.length).toBeLessThan(content.length);
  });

  it("keeps multi-paragraph chapter content inside the same block when truncating", () => {
    const content = [
      "书籍：测试",
      "当前章节正文：\n第一段内容" + "甲".repeat(2000) + "\n\n第二段内容" + "乙".repeat(2000) + "\n\n第三段内容" + "丙".repeat(2000),
    ].join("\n\n");

    const result = truncateContextPrompt(content, 1200);

    expect(result).toContain("当前章节正文");
    expect(result).toContain("（后文已省略）");
    expect(result.length).toBeLessThan(content.length);
  });

  it("returns content unchanged when within budget", () => {
    const content = "短内容";
    expect(truncateContextPrompt(content, 10000)).toBe(content);
  });
});

describe("extractStructuredSummary", () => {
  it("extracts confirmed settings from assistant messages", () => {
    const messages: Msg[] = [
      { role: "assistant", content: "确定主角名字叫李明，采用玄幻题材。" },
      { role: "user", content: "好的。" },
    ];
    const result = extractStructuredSummary(messages);
    expect(result).toContain("## 已确认设定");
    expect(result).toContain("李明");
  });

  it("extracts changes from assistant messages", () => {
    const messages: Msg[] = [
      { role: "assistant", content: "已修改了第三章的开头部分。更新了角色矩阵。" },
    ];
    const result = extractStructuredSummary(messages);
    expect(result).toContain("## 关键改动");
    expect(result).toContain("修改了第三章");
  });

  it("extracts constraints from user messages", () => {
    const messages: Msg[] = [
      { role: "user", content: "禁止出现穿越元素。必须保持主角的冷静人设。" },
      { role: "assistant", content: "好的，遵守。" },
    ];
    const result = extractStructuredSummary(messages);
    expect(result).toContain("## 硬约束");
    expect(result).toContain("禁止出现穿越元素");
  });

  it("returns placeholder when no matches found", () => {
    const messages: Msg[] = [
      { role: "user", content: "你好。" },
      { role: "assistant", content: "你好。" },
    ];
    const result = extractStructuredSummary(messages);
    expect(result).toContain("（暂无）");
  });
});
