import { describe, expect, it } from "vitest";
import {
  buildChapterContextPrompt,
  describeChapterPrestuff,
  truncateTextHead,
  truncateTextTail,
  type ChapterContextMaterials,
} from "../context/build-chapter-context.js";
import { resolveContextPolicy } from "../context/index.js";
import type { ContextPolicy } from "../context/types.js";

function baseMaterials(overrides: Partial<ChapterContextMaterials> = {}): ChapterContextMaterials {
  return {
    bookId: "book-1",
    bookTitle: "测试书",
    genre: "urban",
    platform: "tomato",
    chapterNumber: 1,
    chapterTitle: "开端",
    status: "draft",
    auditText: "审计问题：（暂无）",
    bookDir: "/tmp/books/book-1",
    chaptersDir: "/tmp/books/book-1/chapters",
    storyDir: "/tmp/books/book-1/story",
    chapterFile: "/tmp/books/book-1/chapters/001.md",
    authorBriefPath: "/tmp/books/book-1/author_brief.md",
    authorBrief: "主角要快节奏成长。",
    currentStatePath: "/tmp/books/book-1/story/current_state.md",
    currentState: "X".repeat(2000),
    chapterFiles: ["/tmp/books/book-1/chapters/001.md"],
    storyFiles: ["/tmp/books/book-1/story/current_state.md"],
    chapterContent: "这是很长的章节正文。" + "文".repeat(500),
    pendingHooksPath: "/tmp/books/book-1/story/pending_hooks.md",
    pendingHooks: "伏笔很多。" + "伏".repeat(200),
    chapterSummariesPath: "/tmp/books/book-1/story/chapter_summaries.md",
    chapterSummaries: "摘要很多。" + "摘".repeat(200),
    ...overrides,
  };
}

describe("truncate helpers", () => {
  it("truncateTextHead keeps total length ≤ maxChars", () => {
    const out = truncateTextHead("A".repeat(2000), 1500);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out).toContain("（后文已省略）");
  });

  it("truncateTextTail keeps tail and total length ≤ maxChars", () => {
    const out = truncateTextTail("HEAD" + "T".repeat(2000) + "TAIL", 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain("（前文已省略）");
    expect(out.endsWith("TAIL") || out.includes("TAIL")).toBe(true);
  });
});

describe("buildChapterContextPrompt", () => {
  it("N1/N2/N4: default policy omits body/longform and keeps path_map", () => {
    const policy = resolveContextPolicy("chapter", {});
    const prompt = buildChapterContextPrompt(policy, baseMaterials());
    expect(prompt).not.toContain("当前章节正文");
    expect(prompt).not.toContain("伏笔池（");
    expect(prompt).not.toContain("章节摘要（");
    expect(prompt).not.toContain("伏笔很多");
    expect(prompt).toContain("路径地图");
    expect(prompt).toContain("/tmp/books/book-1/chapters/001.md");
    expect(prompt).toContain("长期创作约束");
    expect(prompt).toContain("- 伏笔池：");
  });

  it("N3: story_state body ≤ maxChars", () => {
    const policy = resolveContextPolicy("chapter", {});
    const maxChars = policy.prestuff.find((rule) => rule.blockId === "story_state")!.maxChars;
    const prompt = buildChapterContextPrompt(policy, baseMaterials());
    const body = prompt.split(`当前状态卡（/tmp/books/book-1/story/current_state.md）：\n`)[1] ?? "";
    expect(body.length).toBeLessThanOrEqual(maxChars);
    expect(body).toContain("（后文已省略）");
  });

  it("B1: respects chapter_body include with maxChars", () => {
    const base = resolveContextPolicy("chapter", {});
    const policy: ContextPolicy = {
      ...base,
      prestuff: base.prestuff.map((rule) =>
        rule.blockId === "chapter_body"
          ? { ...rule, defaultInclude: true, maxChars: 100 }
          : rule,
      ),
    };
    const prompt = buildChapterContextPrompt(policy, baseMaterials());
    expect(prompt).toContain("当前章节正文");
    const body = prompt.split("当前章节正文：\n")[1] ?? "";
    expect(body.length).toBeLessThanOrEqual(100);
  });

  it("include=true maxChars=0 is treated as omitted", () => {
    const base = resolveContextPolicy("chapter", {});
    const policy: ContextPolicy = {
      ...base,
      prestuff: base.prestuff.map((rule) =>
        rule.blockId === "chapter_body"
          ? { ...rule, defaultInclude: true, maxChars: 0 }
          : rule,
      ),
    };
    const prompt = buildChapterContextPrompt(policy, baseMaterials());
    expect(prompt).not.toContain("当前章节正文");
  });

  it("longform uses tail truncation", () => {
    const base = resolveContextPolicy("chapter", {});
    const policy: ContextPolicy = {
      ...base,
      prestuff: base.prestuff.map((rule) =>
        rule.blockId === "story_longform"
          ? { ...rule, defaultInclude: true, maxChars: 80 }
          : rule,
      ),
    };
    const prompt = buildChapterContextPrompt(policy, baseMaterials({
      pendingHooks: "AAAA" + "中".repeat(200) + "HOOK_END",
    }));
    expect(prompt).toContain("伏笔池（");
    expect(prompt).toContain("（前文已省略）");
    expect(prompt).toContain("HOOK_END");
  });
});

describe("describeChapterPrestuff", () => {
  it("omits author_brief when absent", () => {
    const policy = resolveContextPolicy("chapter", {});
    const desc = describeChapterPrestuff(policy, { authorBriefPresent: false });
    expect(desc.includedBlocks).not.toContain("author_brief");
    expect(desc.includedBlocks).toContain("chapter_meta");
  });

  it("includes author_brief when present", () => {
    const policy = resolveContextPolicy("chapter", {});
    const desc = describeChapterPrestuff(policy, { authorBriefPresent: true });
    expect(desc.includedBlocks).toContain("author_brief");
  });
});
