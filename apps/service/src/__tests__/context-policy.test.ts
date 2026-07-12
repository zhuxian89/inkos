import { describe, expect, it } from "vitest";
import { resolveContextPolicy } from "../context/index.js";

describe("resolveContextPolicy", () => {
  it("N1: chapter defaults enforce hard prestuff constraints", () => {
    const policy = resolveContextPolicy("chapter", {});
    const byId = Object.fromEntries(policy.prestuff.map((rule) => [rule.blockId, rule]));

    expect(policy.mode).toBe("chapter");
    expect(byId.path_map?.defaultInclude).toBe(true);
    expect(byId.chapter_body?.defaultInclude).toBe(false);
    expect(byId.chapter_body?.maxChars).toBe(0);
    expect(byId.story_longform?.defaultInclude).toBe(false);
    expect(byId.story_longform?.maxChars).toBe(0);
    expect(policy.loopCompressDisabled).toBe(false);
    expect(policy.budget.compressPrimaryRatio).toBe(0.5);
    expect(policy.budget.compressSafetyRatio).toBe(0.85);
  });

  it("N2: INKOS_CTX_TOTAL_TOKENS overrides totalTokens", () => {
    const policy = resolveContextPolicy("chapter", {
      INKOS_CTX_TOTAL_TOKENS: "12000",
    });
    expect(policy.budget.totalTokens).toBe(12000);
  });

  it("N3: ratio env overrides apply when ordered", () => {
    const policy = resolveContextPolicy("chapter", {
      INKOS_CTX_COMPRESS_RATIO: "0.6",
      INKOS_CTX_SAFETY_RATIO: "0.9",
    });
    expect(policy.budget.compressPrimaryRatio).toBe(0.6);
    expect(policy.budget.compressSafetyRatio).toBe(0.9);
  });

  it("B1: inverted ratios fall back to defaults", () => {
    const policy = resolveContextPolicy("chapter", {
      INKOS_CTX_COMPRESS_RATIO: "0.9",
      INKOS_CTX_SAFETY_RATIO: "0.5",
    });
    expect(policy.budget.compressPrimaryRatio).toBe(0.5);
    expect(policy.budget.compressSafetyRatio).toBe(0.85);
  });

  it("B2: invalid TOTAL_TOKENS falls back to default without throw", () => {
    expect(() =>
      resolveContextPolicy("chapter", {
        INKOS_CTX_TOTAL_TOKENS: "abc",
      }),
    ).not.toThrow();
    const policy = resolveContextPolicy("chapter", {
      INKOS_CTX_TOTAL_TOKENS: "abc",
    });
    expect(policy.budget.totalTokens).toBe(30000);
  });

  it("reads INKOS_DISABLE_LOOP_COMPRESS", () => {
    const policy = resolveContextPolicy("chapter", {
      INKOS_DISABLE_LOOP_COMPRESS: "true",
    });
    expect(policy.loopCompressDisabled).toBe(true);
  });

  it("rejects unknown mode at runtime", () => {
    expect(() => resolveContextPolicy("nope" as "chapter", {})).toThrow(/Unknown ChatContextMode/);
  });
});
