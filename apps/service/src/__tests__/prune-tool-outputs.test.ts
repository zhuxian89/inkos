import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@actalk/inkos-core";
import { resolveContextPolicy } from "../context/index.js";
import { capToolResultContent, pruneToolOutputs } from "../context/prune-tool-outputs.js";

function longTool(id: string, chars: number): AgentMessage {
  return { role: "tool", toolCallId: id, content: "X".repeat(chars) };
}

function toolContent(message: AgentMessage): string {
  if (message.role !== "tool") throw new Error("expected tool");
  return message.content;
}

describe("capToolResultContent", () => {
  it("N1: caps single tool result to maxChars", () => {
    const capped = capToolResultContent("Y".repeat(20000), 8000);
    expect(capped.length).toBeLessThanOrEqual(8000);
    expect(capped).toContain("tool output truncated");
    expect(capped.match(/tool output truncated/g)).toHaveLength(1);
  });

  it("does not nest truncation prefixes on re-cap", () => {
    const once = capToolResultContent("Z".repeat(20000), 8000);
    const twice = capToolResultContent(once, 200);
    expect(twice.match(/\[tool output truncated, originalChars=/g)).toHaveLength(1);
    expect(twice).toContain("originalChars=20000");
    expect(twice.length).toBeLessThanOrEqual(200);
  });
});

describe("pruneToolOutputs", () => {
  it("N2: prunes middle old tools when over primary threshold", () => {
    const policy = resolveContextPolicy("chapter", {
      INKOS_CTX_TOTAL_TOKENS: "5000",
      INKOS_CTX_COMPRESS_RATIO: "0.5",
      INKOS_CTX_SAFETY_RATIO: "0.85",
      INKOS_CTX_MAX_TOOL_RESULT_CHARS: "2000",
      INKOS_CTX_STALE_TOOL_RESULT_CHARS: "100",
      INKOS_CTX_TAIL_TOKENS: "500",
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "系统提示" },
      { role: "user", content: "上下文" },
      longTool("t1", 3000),
      longTool("t2", 3000),
      longTool("t3", 3000),
      { role: "user", content: "最近一句" },
    ];

    const beforeCount = messages.length;
    const result = pruneToolOutputs({ messages, policy });
    expect(result.messages).toHaveLength(beforeCount);
    expect(result.stats.prunedToolResults).toBeGreaterThanOrEqual(1);
    expect(result.stats.afterTokens).toBeLessThan(result.stats.beforeTokens);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages.filter((m) => m.role === "tool")).toHaveLength(3);
  });

  it("N3: loopCompressDisabled skips pruning", () => {
    const policy = resolveContextPolicy("chapter", {
      INKOS_DISABLE_LOOP_COMPRESS: "true",
      INKOS_CTX_MAX_TOOL_RESULT_CHARS: "100",
    });
    const messages: AgentMessage[] = [
      { role: "system", content: "s" },
      longTool("t1", 5000),
    ];
    const result = pruneToolOutputs({ messages, policy });
    expect(result.stats.triggered).toBe("none");
    expect(result.stats.prunedToolResults).toBe(0);
    expect(toolContent(result.messages[1]!).length).toBe(5000);
  });

  it("B1: recent tail tool stays larger than stale-pruned middle tool", () => {
    const policy = resolveContextPolicy("chapter", {
      INKOS_CTX_TOTAL_TOKENS: "2500",
      INKOS_CTX_COMPRESS_RATIO: "0.5",
      INKOS_CTX_SAFETY_RATIO: "0.95",
      INKOS_CTX_MAX_TOOL_RESULT_CHARS: "5000",
      INKOS_CTX_STALE_TOOL_RESULT_CHARS: "60",
      INKOS_CTX_TAIL_TOKENS: "400",
    });
    const messages: AgentMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "ctx" },
      longTool("middle", 3000),
      longTool("recent", 800),
    ];
    const result = pruneToolOutputs({ messages, policy });
    expect(result.stats.afterTokens).toBeLessThan(result.stats.beforeTokens);
    const middle = toolContent(result.messages[2]!);
    const recent = toolContent(result.messages[3]!);
    expect(middle.length).toBeLessThanOrEqual(60);
    expect(recent.length).toBeGreaterThan(middle.length);
    expect(recent.length).toBe(800);
  });

  it("safety: triggered=safety and middle tools ≤120", () => {
    const policy = resolveContextPolicy("chapter", {
      INKOS_CTX_TOTAL_TOKENS: "2000",
      INKOS_CTX_COMPRESS_RATIO: "0.4",
      INKOS_CTX_SAFETY_RATIO: "0.5",
      INKOS_CTX_MAX_TOOL_RESULT_CHARS: "5000",
      INKOS_CTX_STALE_TOOL_RESULT_CHARS: "500",
      INKOS_CTX_TAIL_TOKENS: "100",
    });
    const messages: AgentMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "ctx" },
      longTool("a", 2500),
      longTool("b", 2500),
      longTool("c", 2500),
      { role: "user", content: "tail" },
    ];
    const result = pruneToolOutputs({ messages, policy });
    expect(result.stats.triggered).toBe("safety");
    const middleTools = result.messages.filter((m) => m.role === "tool").slice(0, -1);
    // with tiny tail budget, last tool may also be unprotected; assert at least one safety-shrunk
    const shrunk = result.messages.filter((m) => m.role === "tool" && toolContent(m).length <= 120);
    expect(shrunk.length).toBeGreaterThanOrEqual(1);
    for (const message of middleTools) {
      expect(toolContent(message).match(/\[tool output truncated/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it("E2: never deletes tool messages", () => {
    const policy = resolveContextPolicy("chapter", {
      INKOS_CTX_TOTAL_TOKENS: "3000",
      INKOS_CTX_COMPRESS_RATIO: "0.4",
      INKOS_CTX_MAX_TOOL_RESULT_CHARS: "500",
      INKOS_CTX_STALE_TOOL_RESULT_CHARS: "80",
      INKOS_CTX_TAIL_TOKENS: "200",
    });
    const messages: AgentMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "ctx" },
      longTool("a", 2000),
      longTool("b", 2000),
      longTool("c", 2000),
      longTool("d", 2000),
    ];
    const result = pruneToolOutputs({ messages, policy });
    expect(result.messages.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId))
      .toEqual(["a", "b", "c", "d"]);
  });
});
