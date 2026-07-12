import type { ContextBudget, ContextPolicy, PrestuffRule } from "./types.js";

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalTokens: 30000,
  contextTokens: 16000,
  tailTokens: 20000,
  compressPrimaryRatio: 0.5,
  compressSafetyRatio: 0.85,
  maxToolResultChars: 8000,
  staleToolResultChars: 500,
};

export const CHAPTER_PRESTUFF: ReadonlyArray<PrestuffRule> = [
  { blockId: "path_map", defaultInclude: true, maxChars: 4000 },
  { blockId: "story_state", defaultInclude: true, maxChars: 1500 },
  { blockId: "chapter_body", defaultInclude: false, maxChars: 0 },
  { blockId: "story_longform", defaultInclude: false, maxChars: 0 },
];

export const PROFILE_PRESTUFF: ReadonlyArray<PrestuffRule> = [
  { blockId: "path_map", defaultInclude: true, maxChars: 4000 },
];

export const INIT_PRESTUFF: ReadonlyArray<PrestuffRule> = [
  { blockId: "path_map", defaultInclude: true, maxChars: 4000 },
];

export function buildDefaultPolicy(
  mode: ContextPolicy["mode"],
  prestuff: ReadonlyArray<PrestuffRule>,
): ContextPolicy {
  return {
    mode,
    budget: { ...DEFAULT_CONTEXT_BUDGET },
    prestuff: prestuff.map((rule) => ({ ...rule })),
    loopCompressDisabled: false,
  };
}
