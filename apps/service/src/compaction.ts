// ---------------------------------------------------------------------------
// Conversation message compaction — unified token budget control
// ---------------------------------------------------------------------------

export interface CompactionConfig {
  /** Total token budget for the entire message array. Default 50000. */
  readonly totalBudget: number;
  /** Number of recent turn-pairs to keep verbatim. Default 6 (= 12 messages). */
  readonly tailTurns: number;
  /** Token budget for system + first context message combined. Default 16000. */
  readonly contextBudget: number;
  /** Message layout mode. profile has no dedicated context/meta message. */
  readonly mode: "profile" | "init" | "chapter";
}

export interface CompactionStats {
  readonly originalTokenEstimate: number;
  readonly compactedTokenEstimate: number;
  readonly compressionTriggered: boolean;
  readonly summaryLength: number;
}

export interface CompactionResult {
  readonly messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  readonly stats: CompactionStats;
}

type ChatMessage = { readonly role: "system" | "user" | "assistant"; readonly content: string };

const DEFAULT_CONFIG: CompactionConfig = {
  totalBudget: 50000,
  tailTurns: 6,
  contextBudget: 16000,
  mode: "chapter",
};

// ---------------------------------------------------------------------------
// Token estimation (Chinese ~2.5 chars per token)
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function totalTokens(messages: ReadonlyArray<ChatMessage>): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
}

// ---------------------------------------------------------------------------
// Main entry: compactConversationMessages
// ---------------------------------------------------------------------------

export function compactConversationMessages(
  messages: ReadonlyArray<ChatMessage>,
  config?: Partial<CompactionConfig>,
): CompactionResult {
  const cfg: CompactionConfig = { ...DEFAULT_CONFIG, ...config };

  // Feature flag — bypass
  if (process.env.INKOS_DISABLE_COMPACTION === "true") {
    const est = totalTokens(messages);
    return {
      messages: messages.map((m) => ({ ...m })),
      stats: { originalTokenEstimate: est, compactedTokenEstimate: est, compressionTriggered: false, summaryLength: 0 },
    };
  }

  const originalEstimate = totalTokens(messages);

  // Not over budget — return as-is
  if (originalEstimate <= cfg.totalBudget) {
    return {
      messages: messages.map((m) => ({ ...m })),
      stats: { originalTokenEstimate: originalEstimate, compactedTokenEstimate: originalEstimate, compressionTriggered: false, summaryLength: 0 },
    };
  }

  // Need at least one message to work with
  if (messages.length < 1) {
    return {
      messages: messages.map((m) => ({ ...m })),
      stats: { originalTokenEstimate: originalEstimate, compactedTokenEstimate: originalEstimate, compressionTriggered: false, summaryLength: 0 },
    };
  }

  // --- Step 1: Identify regions ---
  const headCount = cfg.mode === "profile" ? 1 : Math.min(2, messages.length);
  const head: ChatMessage[] = messages.slice(0, headCount).map((message) => ({ ...message }));
  const conversation = messages.slice(headCount);

  // Tail: last tailTurns * 2 messages (or all if conversation is short)
  const tailCount = Math.min(cfg.tailTurns * 2, conversation.length);
  const tail = conversation.slice(-tailCount).map((m) => ({ ...m }));
  const middle = conversation.slice(0, conversation.length - tailCount);

  // --- Step 2: Context-level truncation (Phase 1) ---
  if (head.length > 0) {
    let headTokens = totalTokens(head);

    if (head.length >= 2 && headTokens > cfg.contextBudget) {
      const primaryHead = head[0]!;
      const systemTokens = estimateTokens(primaryHead.content);
      const remainingForContext = Math.max(cfg.contextBudget - systemTokens, 2000);
      head[1] = { ...head[1]!, content: truncateContextPrompt(head[1]!.content, remainingForContext) };
      headTokens = totalTokens(head);
    }

    // Some init/chapter prompts also pack bulky path/context sections into system prompt.
    if (headTokens > cfg.contextBudget) {
      const otherHeadTokens = head.slice(1).reduce((sum, message) => sum + estimateTokens(message.content), 0);
      const remainingForSystem = Math.max(cfg.contextBudget - otherHeadTokens, 2000);
      head[0] = { ...head[0]!, content: truncateContextPrompt(head[0]!.content, remainingForSystem) };
      headTokens = totalTokens(head);
    }

    const afterHeadTruncation = [...head, ...middle, ...tail];
    const afterHeadEstimate = totalTokens(afterHeadTruncation);
    if (afterHeadEstimate <= cfg.totalBudget) {
      return {
        messages: afterHeadTruncation,
        stats: {
          originalTokenEstimate: originalEstimate,
          compactedTokenEstimate: afterHeadEstimate,
          compressionTriggered: afterHeadEstimate < originalEstimate,
          summaryLength: 0,
        },
      };
    }
  }

  // --- Step 3: Middle compression (Phase 2) ---
  if (middle.length === 0) {
    const result = [...head, ...tail];
    const est = totalTokens(result);
    return {
      messages: result,
      stats: { originalTokenEstimate: originalEstimate, compactedTokenEstimate: est, compressionTriggered: est < originalEstimate, summaryLength: 0 },
    };
  }

  const summary = extractStructuredSummary(middle);
  const summaryMessage: ChatMessage = {
    role: "assistant",
    content: `[历史摘要，仅供回忆，不代表本轮新增指令]\n\n${summary}`,
  };

  const result = [...head, summaryMessage, ...tail];
  const compactedEstimate = totalTokens(result);

  return {
    messages: result,
    stats: {
      originalTokenEstimate: originalEstimate,
      compactedTokenEstimate: compactedEstimate,
      compressionTriggered: true,
      summaryLength: summary.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Context prompt truncation by priority
// ---------------------------------------------------------------------------

interface ContextBlock {
  content: string;
  priority: number; // 1=lowest (cut first), 5=highest (keep)
}

const PRIORITY_PATTERNS: Array<{ pattern: RegExp; priority: number }> = [
  // P1 — removable (already in system prompt)
  { pattern: /^已确认真实章节文件/, priority: 1 },
  { pattern: /^已确认真实 story 文件/, priority: 1 },
  { pattern: /^本书目录概览/, priority: 1 },
  { pattern: /^## 本书目录概览/, priority: 1 },
  { pattern: /^## 当前工作路径/, priority: 1 },
  { pattern: /^## 当前书籍项目路径/, priority: 1 },
  // P2 — chapter summaries
  { pattern: /^章节摘要/, priority: 2 },
  { pattern: /^## 章节摘要/, priority: 2 },
  // P3 — hooks
  { pattern: /^伏笔池/, priority: 3 },
  { pattern: /^当前伏笔池/, priority: 3 },
  { pattern: /^## 当前伏笔池/, priority: 3 },
  // P4 — chapter content
  { pattern: /^当前章节正文/, priority: 4 },
  // P5 — keep (everything else)
];

function classifyBlock(block: string): number {
  const firstLine = block.split("\n")[0] ?? "";
  for (const { pattern, priority } of PRIORITY_PATTERNS) {
    if (pattern.test(firstLine)) return priority;
  }
  return 5; // default: keep
}

export function truncateContextPrompt(content: string, budgetTokens: number): string {
  if (estimateTokens(content) <= budgetTokens) return content;

  const blocks: ContextBlock[] = content.split("\n\n").map((block) => ({
    content: block,
    priority: classifyBlock(block),
  }));

  // Phase 1: Remove P1 blocks entirely
  let working = blocks.map((b) => (b.priority === 1 ? { ...b, content: "" } : { ...b }));
  if (estimateTokens(reconstruct(working)) <= budgetTokens) return reconstruct(working);

  // Phase 2: Truncate P2 blocks (chapter summaries)
  let cap = 3000;
  while (cap >= 500 && estimateTokens(reconstruct(working)) > budgetTokens) {
    working = working.map((b) => (b.priority === 2 ? { ...b, content: truncateBlockContent(b.content, cap) } : b));
    cap = Math.floor(cap / 2);
  }
  if (estimateTokens(reconstruct(working)) <= budgetTokens) return reconstruct(working);

  // Phase 3: Truncate P3 blocks (hooks)
  cap = 2500;
  while (cap >= 500 && estimateTokens(reconstruct(working)) > budgetTokens) {
    working = working.map((b) => (b.priority === 3 ? { ...b, content: truncateBlockContent(b.content, cap) } : b));
    cap = Math.floor(cap / 2);
  }
  if (estimateTokens(reconstruct(working)) <= budgetTokens) return reconstruct(working);

  // Phase 4: Truncate P4 blocks (chapter content) — shrink from 12000 down to 2000
  let contentCap = 10000;
  while (contentCap >= 2000 && estimateTokens(reconstruct(working)) > budgetTokens) {
    working = working.map((b) => (b.priority === 4 ? { ...b, content: truncateBlockContentFromStart(b.content, contentCap) } : b));
    contentCap -= 2000;
  }

  return reconstruct(working);
}

function reconstruct(blocks: ReadonlyArray<ContextBlock>): string {
  return blocks
    .map((b) => b.content)
    .filter((c) => c.length > 0)
    .join("\n\n");
}

function truncateBlockContent(block: string, maxChars: number): string {
  if (block.length <= maxChars) return block;
  // Keep the first line (label) and truncate the rest
  const newlineIdx = block.indexOf("\n");
  if (newlineIdx === -1) return block.slice(0, maxChars);
  const label = block.slice(0, newlineIdx);
  const body = block.slice(newlineIdx + 1);
  const truncatedBody = body.slice(-Math.max(maxChars - label.length - 50, 200));
  return `${label}\n（前文已省略）\n${truncatedBody}`;
}

function truncateBlockContentFromStart(block: string, maxChars: number): string {
  if (block.length <= maxChars) return block;
  const newlineIdx = block.indexOf("\n");
  if (newlineIdx === -1) return block.slice(0, maxChars);
  const label = block.slice(0, newlineIdx);
  const body = block.slice(newlineIdx + 1);
  const available = Math.max(maxChars - label.length - 50, 200);
  return `${label}\n${body.slice(0, available)}\n（后文已省略）`;
}

// ---------------------------------------------------------------------------
// Structured summary extraction (heuristic, no LLM)
// ---------------------------------------------------------------------------

const CONFIRMED_MARKERS = ["确定", "确认", "采用", "决定", "选定", "就这样", "最终", "定了"];
const CHANGE_MARKERS = ["修改了", "已改", "写入了", "更新了", "删除了", "添加了", "创建了", "移动了", "重命名", "改为", "替换"];
const QUESTION_MARKERS = ["？", "?", "是否", "要不要", "怎么", "如何", "能否", "还需要", "接下来"];
const CONSTRAINT_MARKERS = ["不要", "禁止", "必须", "不能", "不许", "一定要", "绝对不", "务必", "严禁", "保持"];

export function extractStructuredSummary(
  middleMessages: ReadonlyArray<ChatMessage>,
): string {
  const confirmed: string[] = [];
  const changes: string[] = [];
  const questions: string[] = [];
  const constraints: string[] = [];

  for (const msg of middleMessages) {
    const content = msg.content ?? "";
    const sentences = splitSentences(content);

    if (msg.role === "assistant") {
      // Try to extract brief from init-assistant JSON responses
      const briefLines = extractBriefHeadlines(content);
      if (briefLines.length > 0) {
        confirmed.push(...briefLines);
      }

      for (const s of sentences) {
        if (CONFIRMED_MARKERS.some((m) => s.includes(m)) && s.length > 4) {
          confirmed.push(s);
        }
        if (CHANGE_MARKERS.some((m) => s.includes(m)) && s.length > 4) {
          changes.push(s);
        }
      }
    }

    if (msg.role === "user") {
      for (const s of sentences) {
        if (CONSTRAINT_MARKERS.some((m) => s.includes(m)) && s.length > 4) {
          constraints.push(s);
        }
      }
    }

    // Questions from both roles (last few messages of middle)
    for (const s of sentences) {
      if (QUESTION_MARKERS.some((m) => s.includes(m)) && s.length > 4) {
        questions.push(s);
      }
    }
  }

  const format = (items: string[], cap: number): string => {
    if (items.length === 0) return "（暂无）";
    const deduped = [...new Set(items)];
    let result = "";
    for (const item of deduped) {
      const line = `- ${item.trim()}\n`;
      if (result.length + line.length > cap) break;
      result += line;
    }
    return result.trim() || "（暂无）";
  };

  return [
    `## 已确认设定\n${format(confirmed, 500)}`,
    `## 关键改动\n${format(changes, 500)}`,
    `## 未决问题\n${format(questions, 400)}`,
    `## 硬约束\n${format(constraints, 400)}`,
  ].join("\n\n");
}

function splitSentences(text: string): string[] {
  // Split on Chinese/English sentence endings and newlines
  return text
    .split(/[。！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function extractBriefHeadlines(content: string): string[] {
  const taggedBrief = extractTagContent(content, "brief_md");
  if (taggedBrief) {
    return taggedBrief
      .split("\n")
      .filter((line: string) => line.startsWith("## "))
      .map((line: string) => line.replace(/^##\s*/, "").trim())
      .filter((line: string) => line.length > 0)
      .slice(0, 8);
  }

  try {
    // Try to find JSON in the content (init-assistant format)
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd <= jsonStart) return [];
    const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
    if (typeof parsed === "object" && parsed !== null && "brief" in parsed && typeof parsed.brief === "string") {
      // Extract markdown headings from brief
      return parsed.brief
        .split("\n")
        .filter((line: string) => line.startsWith("## "))
        .map((line: string) => line.replace(/^##\s*/, "").trim())
        .filter((line: string) => line.length > 0)
        .slice(0, 8);
    }
  } catch {
    // Not JSON — ignore
  }
  return [];
}

function extractTagContent(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i"));
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}
