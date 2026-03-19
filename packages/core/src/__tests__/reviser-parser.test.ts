import { describe, expect, it } from "vitest";
import { ReviserAgent } from "../agents/reviser.js";
import type { ReviseOutput } from "../agents/reviser.js";
import type { GenreProfile } from "../models/genre-profile.js";

const defaultGenreProfile: GenreProfile = {
  name: "测试",
  id: "test",
  chapterTypes: [],
  fatigueWords: [],
  numericalSystem: true,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

function callParseOutput(
  content: string,
  genreProfile: GenreProfile = defaultGenreProfile,
): ReviseOutput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = ReviserAgent.prototype as any;
  return proto.parseOutput.call(null, content, genreProfile);
}

describe("ReviserAgent parseOutput", () => {
  it("extracts revised content and extended truth-file updates", () => {
    const output = [
      "=== FIXED_ISSUES ===",
      "- 修正订单规模冲突",
      "",
      "=== REVISED_CONTENT ===",
      "修订后的正文。",
      "",
      "=== UPDATED_STATE ===",
      "状态卡内容",
      "",
      "=== UPDATED_LEDGER ===",
      "账本内容",
      "",
      "=== UPDATED_HOOKS ===",
      "伏笔池内容",
      "",
      "=== UPDATED_CHAPTER_SUMMARIES ===",
      "章节摘要内容",
      "",
      "=== UPDATED_SUBPLOTS ===",
      "支线板内容",
      "",
      "=== UPDATED_EMOTIONAL_ARCS ===",
      "情感弧线内容",
      "",
      "=== UPDATED_CHARACTER_MATRIX ===",
      "角色矩阵内容",
    ].join("\n");

    const result = callParseOutput(output);

    expect(result.revisedContent).toBe("修订后的正文。");
    expect(result.fixedIssues).toEqual(["- 修正订单规模冲突"]);
    expect(result.updatedState).toBe("状态卡内容");
    expect(result.updatedLedger).toBe("账本内容");
    expect(result.updatedHooks).toBe("伏笔池内容");
    expect(result.updatedChapterSummaries).toBe("章节摘要内容");
    expect(result.updatedSubplots).toBe("支线板内容");
    expect(result.updatedEmotionalArcs).toBe("情感弧线内容");
    expect(result.updatedCharacterMatrix).toBe("角色矩阵内容");
  });

  it("returns placeholders when optional truth-file tags are missing", () => {
    const output = [
      "=== REVISED_CONTENT ===",
      "只修正文。",
      "",
      "=== UPDATED_STATE ===",
      "状态卡",
      "",
      "=== UPDATED_HOOKS ===",
      "伏笔池",
    ].join("\n");

    const result = callParseOutput(output);

    expect(result.updatedChapterSummaries).toBe("(章节摘要未更新)");
    expect(result.updatedSubplots).toBe("(支线进度板未更新)");
    expect(result.updatedEmotionalArcs).toBe("(情感弧线未更新)");
    expect(result.updatedCharacterMatrix).toBe("(角色交互矩阵未更新)");
  });
});
