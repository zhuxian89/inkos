import type { ContextPolicy, PrestuffBlockId, PrestuffRule } from "./types.js";

export interface ChapterContextMaterials {
  readonly bookId: string;
  readonly bookTitle: string;
  readonly genre: string;
  readonly platform: string;
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly status?: string;
  readonly auditText: string;
  readonly bookDir: string;
  readonly chaptersDir: string;
  readonly storyDir: string;
  readonly chapterFile: string;
  readonly authorBriefPath: string;
  readonly authorBrief: string;
  readonly currentStatePath: string;
  readonly currentState: string;
  readonly chapterFiles: ReadonlyArray<string>;
  readonly storyFiles: ReadonlyArray<string>;
  readonly chapterContent?: string;
  readonly pendingHooksPath?: string;
  readonly pendingHooks?: string;
  readonly chapterSummariesPath?: string;
  readonly chapterSummaries?: string;
}

const OMIT_MARKER_HEAD = "\n（后文已省略）";
const OMIT_MARKER_TAIL = "（前文已省略）\n";

function ruleFor(policy: ContextPolicy, blockId: PrestuffBlockId): PrestuffRule | undefined {
  return policy.prestuff.find((rule) => rule.blockId === blockId);
}

/** Include only when flagged and maxChars allows content (maxChars=0 ⇒ 视为不预塞). */
function shouldInclude(rule: PrestuffRule | undefined): boolean {
  return Boolean(rule?.defaultInclude && (rule.maxChars ?? 0) > 0);
}

/** Keep head; total length ≤ maxChars including omit marker. */
export function truncateTextHead(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const budget = Math.max(maxChars - OMIT_MARKER_HEAD.length, 0);
  return `${text.slice(0, budget)}${OMIT_MARKER_HEAD}`;
}

/** Keep tail (legacy hooks/summaries behavior); total length ≤ maxChars. */
export function truncateTextTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const budget = Math.max(maxChars - OMIT_MARKER_TAIL.length, 0);
  return `${OMIT_MARKER_TAIL}${text.slice(-budget)}`;
}

function includedBlockIds(policy: ContextPolicy): PrestuffBlockId[] {
  return policy.prestuff.filter((rule) => shouldInclude(rule)).map((rule) => rule.blockId);
}

function omittedBlockIds(policy: ContextPolicy): PrestuffBlockId[] {
  return policy.prestuff.filter((rule) => !shouldInclude(rule)).map((rule) => rule.blockId);
}

export function describeChapterPrestuff(
  policy: ContextPolicy,
  options?: { readonly authorBriefPresent?: boolean },
): {
  readonly includedBlocks: ReadonlyArray<PrestuffBlockId | "chapter_meta" | "author_brief">;
  readonly omittedBlocks: ReadonlyArray<PrestuffBlockId>;
} {
  const included: Array<PrestuffBlockId | "chapter_meta" | "author_brief"> = ["chapter_meta"];
  if (options?.authorBriefPresent) {
    included.push("author_brief");
  }
  included.push(...includedBlockIds(policy));
  return {
    includedBlocks: included,
    omittedBlocks: omittedBlockIds(policy),
  };
}

/**
 * Build chapter chat first-packet context from ContextPolicy + materials.
 */
export function buildChapterContextPrompt(
  policy: ContextPolicy,
  materials: ChapterContextMaterials,
): string {
  const parts: string[] = [];

  parts.push(
    [
      `书籍：${materials.bookTitle}（${materials.bookId}）`,
      `题材：${materials.genre}`,
      `平台：${materials.platform}`,
      `章节：第${materials.chapterNumber}章 ${materials.chapterTitle}`.trim(),
      materials.status ? `当前状态：${materials.status}` : "",
      materials.auditText || "审计问题：（暂无）",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const brief = materials.authorBrief.trim();
  parts.push(
    brief
      ? `长期创作约束（${materials.authorBriefPath}）：\n${truncateTextHead(brief, 1500)}`
      : "长期创作约束：（暂无）",
  );

  const pathMap = ruleFor(policy, "path_map");
  if (shouldInclude(pathMap)) {
    const pathBlock = [
      "## 路径地图",
      `- 书籍目录：${materials.bookDir}`,
      `- chapters 目录：${materials.chaptersDir}`,
      `- story 目录：${materials.storyDir}`,
      `- 当前章节文件：${materials.chapterFile}`,
      `- 作者简报：${materials.authorBriefPath}`,
      `- 状态卡：${materials.currentStatePath}`,
      materials.pendingHooksPath ? `- 伏笔池：${materials.pendingHooksPath}` : "",
      materials.chapterSummariesPath ? `- 章节摘要：${materials.chapterSummariesPath}` : "",
      `已确认真实章节文件：\n- ${materials.chapterFiles.join("\n- ") || "（无）"}`,
      `已确认真实 story 文件：\n- ${materials.storyFiles.join("\n- ") || "（无）"}`,
    ]
      .filter(Boolean)
      .join("\n");
    parts.push(truncateTextHead(pathBlock, pathMap!.maxChars));
  }

  const storyState = ruleFor(policy, "story_state");
  if (shouldInclude(storyState)) {
    const raw = materials.currentState.trim();
    const maxChars = storyState!.maxChars;
    const body = raw ? truncateTextHead(raw, maxChars) : "（暂无）";
    parts.push(`当前状态卡（${materials.currentStatePath}）：\n${body}`);
  }

  const chapterBody = ruleFor(policy, "chapter_body");
  if (shouldInclude(chapterBody)) {
    const raw = (materials.chapterContent ?? "").trim();
    const body = raw ? truncateTextHead(raw, chapterBody!.maxChars) : "（暂无）";
    parts.push(`当前章节正文：\n${body}`);
  }

  const longform = ruleFor(policy, "story_longform");
  if (shouldInclude(longform)) {
    const maxChars = longform!.maxChars;
    const hooks = (materials.pendingHooks ?? "").trim();
    if (hooks) {
      parts.push(
        `伏笔池（${materials.pendingHooksPath ?? ""}）：\n${truncateTextTail(hooks, maxChars)}`,
      );
    }
    const summaries = (materials.chapterSummaries ?? "").trim();
    if (summaries) {
      parts.push(
        `章节摘要（${materials.chapterSummariesPath ?? ""}）：\n${truncateTextTail(summaries, maxChars)}`,
      );
    }
  }

  return parts.filter(Boolean).join("\n\n");
}
