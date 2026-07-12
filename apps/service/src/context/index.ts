export type {
  ChatContextMode,
  ContextBudget,
  ContextPolicy,
  PrestuffBlockId,
  PrestuffRule,
} from "./types.js";

export {
  CHAPTER_PRESTUFF,
  DEFAULT_CONTEXT_BUDGET,
  INIT_PRESTUFF,
  PROFILE_PRESTUFF,
  buildDefaultPolicy,
} from "./defaults.js";

export { resolveContextPolicy } from "./resolve-context-policy.js";

export {
  buildChapterContextPrompt,
  describeChapterPrestuff,
  truncateTextHead,
  truncateTextTail,
  type ChapterContextMaterials,
} from "./build-chapter-context.js";

export {
  capToolResultContent,
  pruneToolOutputs,
  unwrapToolContent,
  type PruneInput,
  type PruneResult,
} from "./prune-tool-outputs.js";

export {
  WRITE_TOOL_NAMES,
  buildHonestChapterFallback,
  finalizeAssistantReply,
  hasSuccessfulWrite,
  parseToolResultError,
  parseToolResultOk,
  replyClaimsModification,
  type ToolTraceItem,
} from "./write-integrity.js";

export {
  maybeCompressConversation,
  type CompressInput,
  type CompressResult,
} from "./maybe-compress-conversation.js";
