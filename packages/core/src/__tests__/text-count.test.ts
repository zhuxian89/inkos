import { describe, expect, it } from "vitest";
import { countNovelWords } from "../utils/text-count.js";

describe("countNovelWords", () => {
  it("counts Han characters one by one and ignores whitespace", () => {
    expect(countNovelWords("你 好\n世界")).toBe(4);
  });

  it("counts contiguous non-Han runs as one unit", () => {
    expect(countNovelWords("Hello, world! 123")).toBe(3);
    expect(countNovelWords("abc123...")).toBe(1);
  });

  it("mixes Chinese and English with Word-like behavior", () => {
    expect(countNovelWords("第1章 Hello世界!!!")).toBe(7);
  });
});
