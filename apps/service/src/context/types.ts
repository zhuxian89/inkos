export type ChatContextMode = "chapter" | "profile" | "init";

export type PrestuffBlockId = "path_map" | "story_state" | "chapter_body" | "story_longform";

export interface ContextBudget {
  readonly totalTokens: number;
  readonly contextTokens: number;
  readonly tailTokens: number;
  readonly compressPrimaryRatio: number;
  readonly compressSafetyRatio: number;
  readonly maxToolResultChars: number;
  readonly staleToolResultChars: number;
}

export interface PrestuffRule {
  readonly blockId: PrestuffBlockId;
  readonly defaultInclude: boolean;
  readonly maxChars: number;
}

export interface ContextPolicy {
  readonly mode: ChatContextMode;
  readonly budget: ContextBudget;
  readonly prestuff: ReadonlyArray<PrestuffRule>;
  readonly loopCompressDisabled: boolean;
}
