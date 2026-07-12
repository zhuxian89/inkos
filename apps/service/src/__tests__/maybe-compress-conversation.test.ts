import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@actalk/inkos-core";
import { CHAPTER_PRESTUFF, buildDefaultPolicy } from "../context/defaults.js";
import { maybeCompressConversation } from "../context/maybe-compress-conversation.js";
import type { ContextBudget, ContextPolicy } from "../context/types.js";

function basePolicy(
  budgetOverrides?: Partial<ContextBudget>,
  loopCompressDisabled = false,
): ContextPolicy {
  const policy = buildDefaultPolicy("chapter", CHAPTER_PRESTUFF);
  return {
    ...policy,
    loopCompressDisabled,
    budget: {
      ...policy.budget,
      ...budgetOverrides,
    },
  };
}

function longTool(id: string, chars: number): AgentMessage {
  return { role: "tool", toolCallId: id, content: "X".repeat(chars) };
}

describe("maybeCompressConversation", () => {
  it("N2: disabled bypass", async () => {
    const policy = basePolicy(undefined, true);
    const messages: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "ctx" },
      longTool("t1", 5000),
    ];
    const result = await maybeCompressConversation({ messages, policy });
    expect(result.stats.triggered).toBe("none");
    expect(result.messages).toHaveLength(3);
  });

  it("N1: over primary summarizes middle", async () => {
    const policy = basePolicy({
      totalTokens: 2000,
      compressPrimaryRatio: 0.3,
      compressSafetyRatio: 0.95,
      maxToolResultChars: 8000,
      staleToolResultChars: 200,
      tailTokens: 200,
    });
    const messages: AgentMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "context block" },
      { role: "assistant", content: "先读文件", toolCalls: [{ id: "1", name: "read_text_file", arguments: "{}" }] },
      longTool("1", 3000),
      { role: "assistant", content: "再读一次", toolCalls: [{ id: "2", name: "read_text_file", arguments: "{}" }] },
      longTool("2", 3000),
      { role: "user", content: "继续改" },
      { role: "assistant", content: "好的" },
    ];
    const result = await maybeCompressConversation({
      messages,
      policy,
      summarizeMiddle: async () => "## 已确认设定\n- 读过两文件",
    });
    expect(result.stats.summaryUpdated).toBe(true);
    expect(["summarize", "safety", "prune"]).toContain(result.stats.triggered);
    expect(result.messages.some((m) => m.role === "user" && m.content.includes("[conversation summary]"))).toBe(true);
    expect(result.stats.afterTokens).toBeLessThan(result.stats.beforeTokens);
  });

  it("N3: summarize failure falls back locally", async () => {
    const policy = basePolicy({
      totalTokens: 2000,
      compressPrimaryRatio: 0.3,
      compressSafetyRatio: 0.99,
      maxToolResultChars: 8000,
      staleToolResultChars: 200,
      tailTokens: 150,
    });
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "context" },
      { role: "assistant", content: "已确认采用方案A。修改了开头。" },
      longTool("1", 4000),
      { role: "user", content: "最近一句" },
    ];
    const result = await maybeCompressConversation({
      messages,
      policy,
      summarizeMiddle: async () => {
        throw new Error("llm down");
      },
    });
    expect(result.stats.summarizeFailed).toBe(true);
    expect(result.stats.summaryUpdated).toBe(true);
    expect(result.summary).toBeTruthy();
  });

  it("B1: safety path marks safety", async () => {
    const policy = basePolicy({
      totalTokens: 1000,
      compressPrimaryRatio: 0.2,
      compressSafetyRatio: 0.25,
      maxToolResultChars: 5000,
      staleToolResultChars: 80,
      tailTokens: 80,
    });
    const messages: AgentMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      longTool("a", 2000),
      longTool("b", 2000),
      longTool("c", 2000),
      { role: "assistant", content: "tail" },
    ];
    const result = await maybeCompressConversation({
      messages,
      policy,
      summarizeMiddle: async () => "S".repeat(4000),
    });
    expect(result.stats.triggered).toBe("safety");
  });
});
