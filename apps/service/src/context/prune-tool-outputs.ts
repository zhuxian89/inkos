import type { AgentMessage } from "@actalk/inkos-core";
import { estimateTokens } from "../compaction.js";
import { truncateTextTail } from "./build-chapter-context.js";
import type { ContextPolicy } from "./types.js";

const TRUNCATE_PREFIX_RE = /^\[tool output truncated, originalChars=(\d+)\]\n/;
const TAIL_OMIT_RE = /^（前文已省略）\n/;
const HEAD_OMIT_RE = /\n（后文已省略）$/;

const TRUNCATE_PREFIX = (originalChars: number): string =>
  `[tool output truncated, originalChars=${originalChars}]\n`;

export interface PruneInput {
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly policy: ContextPolicy;
}

export interface PruneResult {
  readonly messages: AgentMessage[];
  readonly stats: {
    readonly triggered: "none" | "prune" | "safety";
    readonly beforeTokens: number;
    readonly afterTokens: number;
    readonly prunedToolResults: number;
  };
}

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

/** Peel truncation wrappers so re-cap never nests prefixes. */
export function unwrapToolContent(content: string): { readonly originalChars: number; readonly body: string } {
  let body = content;
  let originalChars = content.length;
  for (;;) {
    const match = TRUNCATE_PREFIX_RE.exec(body);
    if (!match) break;
    originalChars = Math.max(originalChars, Number(match[1]));
    body = body.slice(match[0].length);
    if (TAIL_OMIT_RE.test(body)) {
      body = body.replace(TAIL_OMIT_RE, "");
    }
    if (HEAD_OMIT_RE.test(body)) {
      body = body.replace(HEAD_OMIT_RE, "");
    }
  }
  return { originalChars, body };
}

/**
 * Cap a tool result to maxChars with a single truncation prefix.
 * Safe to call repeatedly — will not stack prefixes.
 */
export function capToolResultContent(content: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (content.length <= maxChars) return content;

  const { originalChars, body } = unwrapToolContent(content);
  const prefix = TRUNCATE_PREFIX(originalChars);
  const budget = Math.max(maxChars - prefix.length, 0);
  return `${prefix}${truncateTextTail(body, budget)}`;
}

function protectedHeadIndexes(messages: ReadonlyArray<AgentMessage>): Set<number> {
  const protectedIdx = new Set<number>();
  if (messages.length === 0) return protectedIdx;
  if (messages[0]?.role === "system") {
    protectedIdx.add(0);
    if (messages[1]?.role === "user") {
      protectedIdx.add(1);
    }
  } else {
    protectedIdx.add(0);
  }
  return protectedIdx;
}

function protectedTailIndexes(
  messages: ReadonlyArray<AgentMessage>,
  headProtected: ReadonlySet<number>,
  tailTokens: number,
): Set<number> {
  const protectedIdx = new Set<number>();
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (headProtected.has(i)) continue;
    const tokens = messageTokens(messages[i]!);
    if (protectedIdx.size > 0 && used + tokens > tailTokens) break;
    protectedIdx.add(i);
    used += tokens;
    if (used >= tailTokens) break;
  }
  return protectedIdx;
}

/**
 * Hermes-style Phase 1: cap tool outputs and prune stale tool contents in the middle.
 * Never deletes tool messages (keeps toolCallId pairing).
 */
export function pruneToolOutputs(input: PruneInput): PruneResult {
  const { policy } = input;
  const beforeTokens = totalMessageTokens(input.messages);

  if (policy.loopCompressDisabled) {
    return {
      messages: input.messages.map(cloneMessage),
      stats: {
        triggered: "none",
        beforeTokens,
        afterTokens: beforeTokens,
        prunedToolResults: 0,
      },
    };
  }

  const maxTool = policy.budget.maxToolResultChars;
  const primaryThreshold = policy.budget.totalTokens * policy.budget.compressPrimaryRatio;
  const safetyThreshold = policy.budget.totalTokens * policy.budget.compressSafetyRatio;

  let working = input.messages.map(cloneMessage);
  let prunedToolResults = 0;

  working = working.map((message) => {
    if (message.role !== "tool") return message;
    const next = capToolResultContent(message.content, maxTool);
    if (next !== message.content) prunedToolResults += 1;
    return { ...message, content: next };
  });

  const afterCapTokens = totalMessageTokens(working);
  let triggered: "none" | "prune" | "safety" = prunedToolResults > 0 ? "prune" : "none";

  if (afterCapTokens < primaryThreshold) {
    return {
      messages: working,
      stats: {
        triggered,
        beforeTokens,
        afterTokens: afterCapTokens,
        prunedToolResults,
      },
    };
  }

  const isSafety = afterCapTokens >= safetyThreshold;
  triggered = isSafety ? "safety" : "prune";
  const staleTarget = isSafety
    ? Math.min(policy.budget.staleToolResultChars, 120)
    : policy.budget.staleToolResultChars;

  const headProtected = protectedHeadIndexes(working);
  const tailProtected = protectedTailIndexes(working, headProtected, policy.budget.tailTokens);

  working = working.map((message, index) => {
    if (message.role !== "tool") return message;
    if (headProtected.has(index) || tailProtected.has(index)) return message;
    const next = capToolResultContent(message.content, staleTarget);
    if (next !== message.content) prunedToolResults += 1;
    return { ...message, content: next };
  });

  const afterTokens = totalMessageTokens(working);
  return {
    messages: working,
    stats: {
      triggered,
      beforeTokens,
      afterTokens,
      prunedToolResults,
    },
  };
}
