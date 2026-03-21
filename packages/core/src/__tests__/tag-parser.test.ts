import { describe, it, expect } from "vitest";
import { extractTag } from "../utils/tag-parser.js";

describe("extractTag", () => {
  it("extracts standard === TAG === format", () => {
    const content = `=== CHAPTER_TITLE ===
测试标题

=== CHAPTER_CONTENT ===
这是正文内容，包含多行。
第二行。

=== UPDATED_STATE ===
状态卡内容`;

    expect(extractTag("CHAPTER_TITLE", content)).toBe("测试标题");
    expect(extractTag("CHAPTER_CONTENT", content)).toBe("这是正文内容，包含多行。\n第二行。");
    expect(extractTag("UPDATED_STATE", content)).toBe("状态卡内容");
  });

  it("returns empty string for missing tag", () => {
    const content = "=== CHAPTER_TITLE ===\n标题\n";
    expect(extractTag("CHAPTER_CONTENT", content)).toBe("");
  });

  it("handles == TAG == (two equals)", () => {
    const content = `== CHAPTER_TITLE ==
标题

== CHAPTER_CONTENT ==
正文`;

    expect(extractTag("CHAPTER_TITLE", content)).toBe("标题");
    expect(extractTag("CHAPTER_CONTENT", content)).toBe("正文");
  });

  it("handles ==== TAG ==== (four equals)", () => {
    const content = `==== CHAPTER_TITLE ====
标题

==== CHAPTER_CONTENT ====
正文`;

    expect(extractTag("CHAPTER_TITLE", content)).toBe("标题");
    expect(extractTag("CHAPTER_CONTENT", content)).toBe("正文");
  });

  it("handles extra whitespace around tag name", () => {
    const content = `===  CHAPTER_TITLE  ===
标题

===  CHAPTER_CONTENT  ===
正文`;

    // Strict regex may fail because of extra spaces; lenient pass should catch it
    expect(extractTag("CHAPTER_TITLE", content)).toBe("标题");
    expect(extractTag("CHAPTER_CONTENT", content)).toBe("正文");
  });

  it("handles empty content between tags", () => {
    const content = `=== CHAPTER_TITLE ===
标题

=== CHAPTER_CONTENT ===

=== UPDATED_STATE ===
状态`;

    expect(extractTag("CHAPTER_TITLE", content)).toBe("标题");
    expect(extractTag("CHAPTER_CONTENT", content)).toBe("");
    expect(extractTag("UPDATED_STATE", content)).toBe("状态");
  });

  it("extracts first occurrence when tag appears multiple times", () => {
    const content = `=== CHAPTER_TITLE ===
第一个

=== CHAPTER_CONTENT ===
内容

=== CHAPTER_TITLE ===
第二个`;

    expect(extractTag("CHAPTER_TITLE", content)).toBe("第一个");
  });

  it("handles completely empty input", () => {
    expect(extractTag("CHAPTER_TITLE", "")).toBe("");
  });

  it("handles content with no tags at all", () => {
    expect(extractTag("CHAPTER_TITLE", "一些没有标签的纯文本内容")).toBe("");
  });

  it("handles mixed equals in strict then lenient", () => {
    // Strict format for first tag, lenient for second
    const content = `=== CHAPTER_TITLE ===
标题

== CHAPTER_CONTENT ==
正文`;

    expect(extractTag("CHAPTER_TITLE", content)).toBe("标题");
    expect(extractTag("CHAPTER_CONTENT", content)).toBe("正文");
  });
});
