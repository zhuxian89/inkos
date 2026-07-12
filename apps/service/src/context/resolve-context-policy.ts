import {
  CHAPTER_PRESTUFF,
  DEFAULT_CONTEXT_BUDGET,
  INIT_PRESTUFF,
  PROFILE_PRESTUFF,
  buildDefaultPolicy,
} from "./defaults.js";
import type { ChatContextMode, ContextBudget, ContextPolicy, PrestuffRule } from "./types.js";

const MODES = new Set<ChatContextMode>(["chapter", "profile", "init"]);

function readEnvInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max?: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.max(parsed, min);
  return typeof max === "number" ? Math.min(clamped, max) : clamped;
}

function readEnvRatio(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

function readEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function resolveBudget(env: NodeJS.ProcessEnv): ContextBudget {
  const defaults = DEFAULT_CONTEXT_BUDGET;
  let totalTokens = readEnvInt(env, "INKOS_CTX_TOTAL_TOKENS", defaults.totalTokens, 2000);
  let contextTokens = readEnvInt(env, "INKOS_CTX_CONTEXT_TOKENS", defaults.contextTokens, 1000);
  contextTokens = Math.min(contextTokens, totalTokens);

  let compressPrimaryRatio = readEnvRatio(env, "INKOS_CTX_COMPRESS_RATIO", defaults.compressPrimaryRatio);
  let compressSafetyRatio = readEnvRatio(env, "INKOS_CTX_SAFETY_RATIO", defaults.compressSafetyRatio);
  if (compressPrimaryRatio >= compressSafetyRatio) {
    compressPrimaryRatio = defaults.compressPrimaryRatio;
    compressSafetyRatio = defaults.compressSafetyRatio;
  }

  return {
    totalTokens,
    contextTokens,
    tailTokens: readEnvInt(env, "INKOS_CTX_TAIL_TOKENS", defaults.tailTokens, 1000),
    compressPrimaryRatio,
    compressSafetyRatio,
    maxToolResultChars: readEnvInt(env, "INKOS_CTX_MAX_TOOL_RESULT_CHARS", defaults.maxToolResultChars, 256),
    staleToolResultChars: readEnvInt(env, "INKOS_CTX_STALE_TOOL_RESULT_CHARS", defaults.staleToolResultChars, 0),
  };
}

function defaultPrestuff(mode: ChatContextMode): ReadonlyArray<PrestuffRule> {
  switch (mode) {
    case "chapter":
      return CHAPTER_PRESTUFF;
    case "profile":
      return PROFILE_PRESTUFF;
    case "init":
      return INIT_PRESTUFF;
  }
}

/**
 * Resolve an immutable ContextPolicy for a chat mode.
 * Reads INKOS_CTX_* from the provided env (defaults to process.env).
 */
export function resolveContextPolicy(
  mode: ChatContextMode,
  env: NodeJS.ProcessEnv = process.env,
): ContextPolicy {
  if (!MODES.has(mode)) {
    throw new Error(`Unknown ChatContextMode: ${String(mode)}`);
  }

  const base = buildDefaultPolicy(mode, defaultPrestuff(mode));
  return {
    mode,
    budget: resolveBudget(env),
    prestuff: base.prestuff.map((rule) => ({ ...rule })),
    loopCompressDisabled: readEnvFlag(env, "INKOS_DISABLE_LOOP_COMPRESS"),
  };
}
