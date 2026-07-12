import type { AgentMessage } from "@actalk/inkos-core";
import { estimateTokens, extractStructuredSummary } from "../compaction.js";
import { pruneToolOutputs } from "./prune-tool-outputs.js";
import type { ContextPolicy } from "./types.js";

export interface CompressInput {
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly policy: ContextPolicy;
  readonly previousSummary?: string;
  /** Injected summarizer (production: chatCompletion). */
  readonly summarizeMiddle?: (middlePlaintext: string) => Promise<string>;
}

export interface CompressResult {
  readonly messages: AgentMessage[];
  readonly stats: {
    readonly triggered: "none" | "prune" | "summarize" | "safety";
    readonly beforeTokens: number;
    readonly afterTokens: number;
    readonly prunedToolResults: number;
    readonly summaryUpdated: boolean;
    readonly summarizeFailed: boolean;
  };
  readonly summary?: string;
}

const SUMMARY_MARKER = "[conversation summary]";

function messageTokens(message: AgentMessage): number {
  if (message.role === "tool") {
    return estimateTokens(message.content);
  }
  if (message.role === "assistant") {
    let total = estimateTokens(message.content ?? "");
    if (message.toolCalls?.length) {
      total += estimateTokens(JSON.stringify(message.toolCalls));
    }
    return total;
  }
  return estimateTokens(message.content);
}

function totalMessageTokens(messages: ReadonlyArray<AgentMessage>): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function cloneMessage(message: AgentMessage): AgentMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", toolCallId: message.toolCallId, content: message.content };
  }
  return { role: message.role, content: message.content };
}

function headEndIndex(messages: ReadonlyArray<AgentMessage>): number {
  if (messages.length === 0) return -1;
  if (messages[0]?.role === "system") {
    return messages[1]?.role === "user" ? 1 : 0;
  }
  return 0;
}

function tailStartIndex(messages: ReadonlyArray<AgentMessage>, headEnd: number, tailTokens: number): number {
  if (messages.length === 0) return 0;
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i > headEnd; i -= 1) {
    const tokens = messageTokens(messages[i]!);
    if (start < messages.length && used + tokens > tailTokens) break;
    start = i;
    used += tokens;
    if (used >= tailTokens) break;
  }
  return start;
}

function middleToPlaintext(middle: ReadonlyArray<AgentMessage>): string {
  const lines: string[] = [];
  for (const message of middle) {
    if (message.role === "tool") {
      const snippet = message.content.length > 400
        ? `${message.content.slice(-400)}`
        : message.content;
      lines.push(`[tool ${message.toolCallId}] ${snippet}`);
      continue;
    }
    if (message.role === "assistant") {
      lines.push(`[assistant] ${message.content ?? ""}`);
      if (message.toolCalls?.length) {
        lines.push(`[tool_calls] ${JSON.stringify(message.toolCalls.map((c) => c.name))}`);
      }
      continue;
    }
    lines.push(`[${message.role}] ${message.content}`);
  }
  return lines.join("\n").slice(0, 24000);
}

function middleToSummaryMessages(middle: ReadonlyArray<AgentMessage>): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  return middle
    .filter((m): m is Extract<AgentMessage, { role: "system" | "user" | "assistant" }> =>
      m.role === "system" || m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      content: m.content ?? "",
    }));
}

function buildSummaryMessage(summary: string, previousSummary?: string): AgentMessage {
  const body = [
    SUMMARY_MARKER,
    previousSummary?.trim() ? `## 此前摘要\n${previousSummary.trim()}` : "",
    summary.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { role: "user", content: body };
}

/**
 * Hermes-style loop compression: prune tool outputs, then optionally summarize middle turns.
 */
export async function maybeCompressConversation(input: CompressInput): Promise<CompressResult> {
  const beforeTokens = totalMessageTokens(input.messages);

  if (input.policy.loopCompressDisabled) {
    return {
      messages: input.messages.map(cloneMessage),
      stats: {
        triggered: "none",
        beforeTokens,
        afterTokens: beforeTokens,
        prunedToolResults: 0,
        summaryUpdated: false,
        summarizeFailed: false,
      },
    };
  }

  // First pass: ingest cap only so summarize can still see oversized middle turns.
  const pruned = pruneToolOutputs({
    messages: input.messages,
    policy: input.policy,
    phase: "ingest",
  });
  let working = pruned.messages;
  let triggered: CompressResult["stats"]["triggered"] =
    pruned.stats.triggered === "none" ? "none" : pruned.stats.triggered;
  let prunedToolResults = pruned.stats.prunedToolResults;
  let summaryUpdated = false;
  let summarizeFailed = false;
  let summary: string | undefined = input.previousSummary;

  const primaryThreshold = input.policy.budget.totalTokens * input.policy.budget.compressPrimaryRatio;
  const safetyThreshold = input.policy.budget.totalTokens * input.policy.budget.compressSafetyRatio;

  if (totalMessageTokens(working) >= primaryThreshold) {
    const headEnd = headEndIndex(working);
    const tailStart = tailStartIndex(working, headEnd, input.policy.budget.tailTokens);
    if (tailStart > headEnd + 1) {
      const head = working.slice(0, headEnd + 1).map(cloneMessage);
      const middle = working.slice(headEnd + 1, tailStart);
      const tail = working.slice(tailStart).map(cloneMessage);
      const plaintext = middleToPlaintext(middle);

      let summaryText = "";
      try {
        if (input.summarizeMiddle) {
          summaryText = (await input.summarizeMiddle(plaintext)).trim();
        }
      } catch {
        summarizeFailed = true;
      }

      if (!summaryText) {
        summarizeFailed = summarizeFailed || Boolean(input.summarizeMiddle);
        summaryText = extractStructuredSummary(middleToSummaryMessages(middle));
      }

      if (summaryText) {
        summary = summaryText;
        summaryUpdated = true;
        working = [...head, buildSummaryMessage(summaryText, input.previousSummary), ...tail];
        triggered = "summarize";
      }
    }
  }

  if (totalMessageTokens(working) >= safetyThreshold) {
    const forced = pruneToolOutputs({
      messages: working,
      policy: {
        ...input.policy,
        budget: {
          ...input.policy.budget,
          compressPrimaryRatio: 0,
          compressSafetyRatio: 0,
          staleToolResultChars: Math.min(input.policy.budget.staleToolResultChars, 120),
        },
      },
      phase: "full",
    });
    working = forced.messages;
    prunedToolResults += forced.stats.prunedToolResults;
    triggered = "safety";
  } else if (totalMessageTokens(working) >= primaryThreshold && !summaryUpdated) {
    const primary = pruneToolOutputs({
      messages: working,
      policy: input.policy,
      phase: "primary",
    });
    working = primary.messages;
    prunedToolResults += primary.stats.prunedToolResults;
    if (primary.stats.triggered !== "none") {
      triggered = primary.stats.triggered;
    }
  }

  return {
    messages: working,
    stats: {
      triggered,
      beforeTokens,
      afterTokens: totalMessageTokens(working),
      prunedToolResults,
      summaryUpdated,
      summarizeFailed,
    },
    summary,
  };
}
