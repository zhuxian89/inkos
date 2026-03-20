import {
  StateManager,
  buildChapterFilename,
  chatCompletion,
  chatWithTools,
  createLLMClient,
  readGenreProfile,
  resolveChapterFile,
  type AgentMessage,
  type ChapterMeta,
  type ToolDefinition,
  writeCanonicalChapterFile,
} from "@actalk/inkos-core";
import cors from "cors";
import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { commandRegistry, getCommandDefinition } from "./command-registry.js";
import { loadProjectSummary } from "./project.js";
import { createBookConfig, createPipeline, loadProjectConfig, resolveBookId } from "./runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const projectRoot = resolve(process.env.INKOS_PROJECT_ROOT ?? repoRoot);
const port = parseInt(process.env.PORT ?? "4010", 10);
const webCommandTimeoutMs = parseInt(process.env.INKOS_WEB_COMMAND_TIMEOUT_MS ?? "600000", 10);

const app = express();
const LOG_STRING_PREVIEW_LIMIT = 120;

// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------
interface Job {
  readonly id: string;
  readonly type: "write-next" | "create-book" | "command" | "audit" | "revise" | "chapter-chat" | "init-assistant-chat";
  status: "running" | "done" | "error";
  step: string;
  bookId?: string;
  result?: unknown;
  error?: string;
  createdAt: number;
}

interface InitAssistantMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface ChapterAssistantMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

const PLATFORM_GUIDANCE: Record<string, string> = {
  tomato: "番茄：节奏要快，前三章要有钩子和反馈，强调强冲突、强反转、强情绪兑现。",
  qidian: "起点：设定完整度和世界观逻辑更重要，允许慢一点铺陈，但主线和成长曲线必须清晰。",
  feilu: "飞卢：题眼直接，卖点前置，冲突密集，主角动机和爽点要持续高频兑现。",
  other: "其他平台：按通俗网文逻辑处理，优先确保题眼明确、主线稳定、开篇抓人。",
};

const SUPPORTED_GENRES = [
  "xuanhuan(玄幻)",
  "xianxia(仙侠)",
  "chuanyue(穿越)",
  "urban(都市)",
  "horror(恐怖)",
  "other(其他)",
].join("、");

const jobs = new Map<string, Job>();

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Auto-clean jobs older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.createdAt < cutoff) {
      logInfo("job.cleanup", { jobId: id, type: job.type, status: job.status });
      jobs.delete(id);
    }
  }
}, 600_000);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/jobs/")) {
    next();
    return;
  }
  const startedAt = Date.now();
  logInfo("request.start", { method: req.method, path: req.path });
  res.on("finish", () => {
    logInfo("request.finish", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
});

function logInfo(event: string, meta?: Record<string, unknown>): void {
  process.stdout.write(`${new Date().toISOString()} INFO ${event}${formatMeta(meta)}\n`);
}

function logError(event: string, meta?: Record<string, unknown>): void {
  process.stderr.write(`${new Date().toISOString()} ERROR ${event}${formatMeta(meta)}\n`);
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  return ` ${JSON.stringify(sanitizeForLog(meta))}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function forwardCliChunk(event: "cli.stdout" | "cli.stderr", chunk: Buffer, meta: Record<string, unknown>): void {
  const text = chunk.toString("utf-8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    logInfo(event, { ...meta, line: trimmed });
  }
}

function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .replace(/-+/g, "-")
    .slice(0, 120);
}

function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= LOG_STRING_PREVIEW_LIMIT) return value;
    return `${value.slice(0, LOG_STRING_PREVIEW_LIMIT)}…[truncated ${value.length - LOG_STRING_PREVIEW_LIMIT} chars]`;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (/key|token|secret|password/i.test(key)) {
        return [key, "<redacted>"];
      }
      return [key, sanitizeForLog(entry)];
    }),
  );
}

function startJob(job: Job, meta?: Record<string, unknown>): void {
  logInfo("job.start", { jobId: job.id, type: job.type, bookId: job.bookId, ...meta });
}

function updateJobStep(job: Job, step: string, meta?: Record<string, unknown>): void {
  job.step = step;
  logInfo("job.step", { jobId: job.id, type: job.type, bookId: job.bookId, step, ...meta });
}

function finishJob(job: Job, result?: Record<string, unknown>): void {
  job.status = "done";
  job.step = "已完成";
  logInfo("job.done", {
    jobId: job.id,
    type: job.type,
    bookId: job.bookId,
    durationMs: Date.now() - job.createdAt,
    ...result,
  });
}

function failJob(job: Job, error: unknown): void {
  job.status = "error";
  job.error = describeError(error);
  job.step = "失败";
  logError("job.error", {
    jobId: job.id,
    type: job.type,
    bookId: job.bookId,
    durationMs: Date.now() - job.createdAt,
    error: job.error,
  });
}

function createJob(params: {
  readonly type: Job["type"];
  readonly step: string;
  readonly bookId?: string;
}): Job {
  const job: Job = {
    id: generateJobId(),
    type: params.type,
    status: "running",
    step: params.step,
    bookId: params.bookId,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

function daemonPidPath(): string {
  return resolve(projectRoot, "inkos.pid");
}

async function cliEntry(): Promise<{ command: string; args: string[] }> {
  const distEntry = resolve(repoRoot, "packages/cli/dist/index.js");
  try {
    await access(distEntry, fsConstants.F_OK);
    return { command: "node", args: [distEntry] };
  } catch {
    const srcEntry = resolve(repoRoot, "packages/cli/src/index.ts");
    return { command: "node", args: ["--import", "tsx", srcEntry] };
  }
}

async function spawnCli(
  args: string[],
  options?: {
    readonly expectJson?: boolean;
    readonly detached?: boolean;
    readonly timeoutMs?: number;
    readonly retries?: number;
    readonly retryDelayMs?: number;
  },
): Promise<{ stdout: string; stderr: string; code: number | null; parsed?: unknown }> {
  const launch = await cliEntry();
  const latestGlobalLlmEnv = await readGlobalLlmEnv();
  const env = {
    ...process.env,
    ...(latestGlobalLlmEnv.provider ? { INKOS_LLM_PROVIDER: latestGlobalLlmEnv.provider } : {}),
    ...(latestGlobalLlmEnv.baseUrl ? { INKOS_LLM_BASE_URL: latestGlobalLlmEnv.baseUrl } : {}),
    ...(latestGlobalLlmEnv.apiKey ? { INKOS_LLM_API_KEY: latestGlobalLlmEnv.apiKey } : {}),
    ...(latestGlobalLlmEnv.model ? { INKOS_LLM_MODEL: latestGlobalLlmEnv.model } : {}),
  };
  const retries = Math.max(1, options?.retries ?? (parseInt(process.env.INKOS_WEB_COMMAND_RETRIES ?? "3", 10) || 3));
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? (parseInt(process.env.INKOS_WEB_COMMAND_RETRY_DELAY_MS ?? "1500", 10) || 1500));

  async function runOnce(attempt: number): Promise<{ stdout: string; stderr: string; code: number | null; parsed?: unknown }> {
    const startedAt = Date.now();
    logInfo("cli.start", {
      command: launch.command,
      args: [...launch.args, ...args],
      detached: options?.detached ?? false,
      timeoutMs: options?.timeoutMs ?? 0,
      attempt,
      retries,
      llmProvider: env.INKOS_LLM_PROVIDER ?? null,
      llmBaseUrl: env.INKOS_LLM_BASE_URL ?? null,
      llmModel: env.INKOS_LLM_MODEL ?? null,
      llmApiKeyConfigured: Boolean(env.INKOS_LLM_API_KEY),
    });
    const child = spawn(launch.command, [...launch.args, ...args], {
      cwd: projectRoot,
      env,
      detached: options?.detached ?? false,
      stdio: options?.detached ? "ignore" : ["ignore", "pipe", "pipe"],
    });

    if (options?.detached) {
      child.unref();
      logInfo("cli.detached", {
        pid: child.pid ?? null,
        command: launch.command,
        args: [...launch.args, ...args],
        attempt,
      });
      return { stdout: "", stderr: "", code: 0 };
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killedByTimeout = false;
    let forceKilledByTimeout = false;
    const timeoutMs = options?.timeoutMs ?? 0;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          killedByTimeout = true;
          child.kill("SIGTERM");
          forceKillTimer = setTimeout(() => {
            forceKilledByTimeout = true;
            child.kill("SIGKILL");
          }, 5_000);
        }, timeoutMs)
      : null;

    child.stdout?.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      stdoutChunks.push(buffer);
      if (!options?.expectJson) {
        forwardCliChunk("cli.stdout", buffer, { args, attempt });
      }
    });
    child.stderr?.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      stderrChunks.push(buffer);
      forwardCliChunk("cli.stderr", buffer, { args, attempt });
    });

    const code = await new Promise<number | null>((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", resolveCode);
    });
    if (timer) clearTimeout(timer);
    if (forceKillTimer) clearTimeout(forceKillTimer);

    const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
    const finalStderr = killedByTimeout
      ? `${stderr ? `${stderr}\n` : ""}Command timed out after ${timeoutMs}ms and was terminated${forceKilledByTimeout ? " with SIGKILL" : ""}.`
      : stderr;
    const parsed = options?.expectJson && stdout ? safeParseJson(stdout) : undefined;

    const cliMeta = {
      pid: child.pid ?? null,
      code: killedByTimeout ? 124 : code,
      durationMs: Date.now() - startedAt,
      stdoutBytes: stdout.length,
      stderrBytes: finalStderr.length,
      attempt,
      retries,
    };
    if (killedByTimeout || code !== 0) {
      logError("cli.finish", cliMeta);
    } else {
      logInfo("cli.finish", cliMeta);
    }

    return { stdout, stderr: finalStderr, code: killedByTimeout ? 124 : code, parsed };
  }

  let lastResult: { stdout: string; stderr: string; code: number | null; parsed?: unknown } | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await runOnce(attempt);
      lastResult = result;
      if ((result.code ?? 1) === 0) {
        return result;
      }
      if (attempt < retries) {
        logInfo("cli.retry.scheduled", {
          args,
          attempt,
          nextAttempt: attempt + 1,
          retryDelayMs,
          code: result.code,
        });
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
      }
    } catch (error) {
      lastError = error;
      logError("cli.retry.error", {
        args,
        attempt,
        retries,
        error: describeError(error),
      });
      if (attempt < retries) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
        continue;
      }
    }
  }

  if (lastResult) return lastResult;
  throw lastError instanceof Error ? lastError : new Error(describeError(lastError));
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readGlobalLlmEnv(): Promise<{
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly model?: string;
}> {
  try {
    const raw = await readFile(globalLlmEnvPath(), "utf-8");
    const pairs = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        if (index <= 0) return null;
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null);
    const map = Object.fromEntries(pairs);
    return {
      provider: map.INKOS_LLM_PROVIDER,
      baseUrl: map.INKOS_LLM_BASE_URL,
      apiKey: map.INKOS_LLM_API_KEY,
      model: map.INKOS_LLM_MODEL,
    };
  } catch {
    return {};
  }
}

interface LlmProfileRow {
  readonly id: string;
  readonly name: string;
  readonly provider: "openai" | "anthropic";
  readonly base_url: string;
  readonly api_key: string;
  readonly model: string;
  readonly temperature: number | null;
  readonly max_tokens: number | null;
  readonly thinking_budget: number | null;
  readonly api_format: "chat" | "responses" | null;
  readonly is_active: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface LlmProfilePayload {
  readonly name: string;
  readonly provider: "openai" | "anthropic";
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly thinkingBudget?: number;
  readonly apiFormat?: "chat" | "responses";
}

function resolveInkosHomeDir(): string {
  return process.env.INKOS_HOME?.trim() || join(process.env.HOME ?? "/root", ".inkos");
}

function inkosHomeDir(): string {
  return resolveInkosHomeDir();
}

function globalLlmEnvPath(): string {
  return join(inkosHomeDir(), ".env");
}

function llmProfilesDbPath(): string {
  return join(inkosHomeDir(), "profiles.db");
}

function openProfilesDb(): DatabaseSync {
  const db = new DatabaseSync(llmProfilesDbPath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      temperature REAL,
      max_tokens INTEGER,
      thinking_budget INTEGER,
      api_format TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function mapProfileRow(row: LlmProfileRow) {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    temperature: row.temperature ?? undefined,
    maxTokens: row.max_tokens ?? undefined,
    thinkingBudget: row.thinking_budget ?? undefined,
    apiFormat: row.api_format ?? undefined,
    apiKeyConfigured: Boolean(row.api_key),
    isActive: row.is_active === 1,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function getProfileById(db: DatabaseSync, id: string): LlmProfileRow | null {
  const row = db.prepare("SELECT * FROM llm_profiles WHERE id = ?").get(id) as LlmProfileRow | undefined;
  return row ?? null;
}

function profileRowToPayload(profile: LlmProfileRow): LlmProfilePayload {
  return {
    name: profile.name,
    provider: profile.provider,
    baseUrl: profile.base_url,
    apiKey: profile.api_key,
    model: profile.model,
    temperature: profile.temperature ?? undefined,
    maxTokens: profile.max_tokens ?? undefined,
    thinkingBudget: profile.thinking_budget ?? undefined,
    apiFormat: profile.api_format ?? undefined,
  };
}

async function writeGlobalLlmEnv(payload: LlmProfilePayload): Promise<void> {
  await mkdir(inkosHomeDir(), { recursive: true });
  await writeFile(
    globalLlmEnvPath(),
    [
      "# InkOS Global LLM Configuration",
      `INKOS_LLM_PROVIDER=${payload.provider}`,
      `INKOS_LLM_BASE_URL=${payload.baseUrl}`,
      `INKOS_LLM_API_KEY=${payload.apiKey}`,
      `INKOS_LLM_MODEL=${payload.model}`,
      ...(payload.temperature !== undefined ? [`INKOS_LLM_TEMPERATURE=${payload.temperature}`] : []),
      ...(payload.maxTokens !== undefined ? [`INKOS_LLM_MAX_TOKENS=${payload.maxTokens}`] : []),
      ...(payload.thinkingBudget !== undefined ? [`INKOS_LLM_THINKING_BUDGET=${payload.thinkingBudget}`] : []),
      ...(payload.apiFormat ? [`INKOS_LLM_API_FORMAT=${payload.apiFormat}`] : []),
    ].join("\n") + "\n",
    "utf-8",
  );
}

async function activateLlmProfile(profileId: string): Promise<ReturnType<typeof mapProfileRow>> {
  const db = openProfilesDb();
  try {
    const profile = getProfileById(db, profileId);
    if (!profile) {
      throw new Error(`LLM profile not found: ${profileId}`);
    }

    db.exec("UPDATE llm_profiles SET is_active = 0");
    db.prepare("UPDATE llm_profiles SET is_active = 1, updated_at = ? WHERE id = ?").run(Date.now(), profileId);
    await writeGlobalLlmEnv(profileRowToPayload(profile));
    const activated = getProfileById(db, profileId);
    if (!activated) throw new Error(`LLM profile activation failed: ${profileId}`);
    return mapProfileRow(activated);
  } finally {
    db.close();
  }
}

async function testLlmProfile(profileId: string): Promise<{
  readonly profileId: string;
  readonly model: string;
  readonly provider: string;
  readonly responsePreview: string;
}> {
  const db = openProfilesDb();
  let profile: LlmProfileRow | null = null;
  try {
    profile = getProfileById(db, profileId);
  } finally {
    db.close();
  }

  if (!profile) {
    throw new Error(`LLM profile not found: ${profileId}`);
  }

  const payload = profileRowToPayload(profile);
  const client = createLLMClient({
    provider: payload.provider,
    baseUrl: payload.baseUrl,
    apiKey: payload.apiKey,
    model: payload.model,
    temperature: payload.temperature ?? 0.7,
    maxTokens: payload.maxTokens ?? 16000,
    thinkingBudget: payload.thinkingBudget ?? 0,
    apiFormat: payload.apiFormat ?? "chat",
  });

  const response = await chatCompletion(client, payload.model, [
    {
      role: "system",
      content: "You are a health check assistant. Reply in plain text with a very short confirmation.",
    },
    {
      role: "user",
      content: "Reply with: LLM test passed",
    },
  ], {
    temperature: 0,
    maxTokens: 16000,
  });

  return {
    profileId,
    provider: payload.provider,
    model: payload.model,
    responsePreview: response.content.trim().slice(0, 200),
  };
}

async function chatWithLlmProfile(
  profileId: string,
  messages: ReadonlyArray<{ readonly role: "system" | "user" | "assistant"; readonly content: string }>,
  options?: {
    readonly useStream?: boolean;
    readonly includeReasoning?: boolean;
  },
): Promise<{
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly content: string;
  readonly reasoning?: string;
  readonly applied: {
    readonly useStream: boolean;
    readonly includeReasoning: boolean;
  };
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}> {
  const db = openProfilesDb();
  let profile: LlmProfileRow | null = null;
  try {
    profile = getProfileById(db, profileId);
  } finally {
    db.close();
  }

  if (!profile) {
    throw new Error(`LLM profile not found: ${profileId}`);
  }

  const payload = profileRowToPayload(profile);
  const client = createLLMClient({
    provider: payload.provider,
    baseUrl: payload.baseUrl,
    apiKey: payload.apiKey,
    model: payload.model,
    temperature: payload.temperature ?? 0.7,
    maxTokens: payload.maxTokens ?? 16000,
    thinkingBudget: payload.thinkingBudget ?? 0,
    apiFormat: payload.apiFormat ?? "chat",
  });

  const useStream = options?.useStream ?? true;
  const includeReasoning = options?.includeReasoning ?? false;

  if (client.provider === "openai" && client.apiFormat === "chat" && client._openai) {
    const response = await chatWithOpenAiCompatibleProfile(client._openai, payload.model, messages, {
      useStream,
      includeReasoning,
    });

    return {
      profileId,
      provider: payload.provider,
      model: payload.model,
      content: response.content,
      reasoning: response.reasoning,
      applied: {
        useStream,
        includeReasoning,
      },
      usage: response.usage,
    };
  }

  const response = await chatCompletion(client, payload.model, messages, {
    temperature: 0.7,
    maxTokens: 16000,
  });

  return {
    profileId,
    provider: payload.provider,
    model: payload.model,
    content: response.content,
    applied: {
      useStream: true,
      includeReasoning: false,
    },
    usage: response.usage,
  };
}

async function createClientFromOptionalProfile(
  profileId?: string,
): Promise<{
  readonly client: ReturnType<typeof createLLMClient>;
  readonly model: string;
  readonly profileId?: string;
}> {
  if (!profileId?.trim()) {
    const config = await loadProjectConfig(projectRoot);
    return {
      client: createLLMClient(config.llm),
      model: config.llm.model,
    };
  }

  const db = openProfilesDb();
  let profile: LlmProfileRow | null = null;
  try {
    profile = getProfileById(db, profileId.trim());
  } finally {
    db.close();
  }

  if (!profile) {
    throw new Error(`LLM profile not found: ${profileId}`);
  }

  const payload = profileRowToPayload(profile);
  return {
    client: createLLMClient({
      provider: payload.provider,
      baseUrl: payload.baseUrl,
      apiKey: payload.apiKey,
      model: payload.model,
      temperature: payload.temperature ?? 0.7,
      maxTokens: payload.maxTokens ?? 16000,
      thinkingBudget: payload.thinkingBudget ?? 0,
      apiFormat: payload.apiFormat ?? "chat",
    }),
    model: payload.model,
    profileId: profile.id,
  };
}

function isMoonshotCompatible(model: string, client: { baseURL?: string }): boolean {
  const normalizedModel = model.toLowerCase();
  const normalizedBaseUrl = client.baseURL?.toLowerCase() ?? "";
  return normalizedModel.includes("moonshot")
    || normalizedModel.includes("kimi")
    || normalizedBaseUrl.includes("moonshot");
}

function extractTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractTextValue(item)).join("");
  }
  if (value && typeof value === "object") {
    if ("text" in value && typeof value.text === "string") {
      return value.text;
    }
    if ("content" in value) {
      return extractTextValue((value as { content?: unknown }).content);
    }
  }
  return "";
}

async function chatWithOpenAiCompatibleProfile(
  client: any,
  model: string,
  messages: ReadonlyArray<{ readonly role: "system" | "user" | "assistant"; readonly content: string }>,
  options: {
    readonly useStream: boolean;
    readonly includeReasoning: boolean;
  },
): Promise<{
  readonly content: string;
  readonly reasoning?: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}> {
  const moonshotCompat = isMoonshotCompatible(model, client);
  const request = {
    model,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    temperature: 0.7,
    max_tokens: 16000,
  };

  if (options.useStream) {
    const stream = await client.chat.completions.create({
      ...request,
      stream: true,
    });

    const contentChunks: string[] = [];
    const reasoningChunks: string[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as {
        content?: unknown;
        reasoning?: unknown;
        reasoning_content?: unknown;
      } | undefined;

      const content = extractTextValue(delta?.content);
      if (content) {
        contentChunks.push(content);
      }

      if (options.includeReasoning) {
        const reasoning = extractTextValue(
          moonshotCompat ? (delta?.reasoning_content ?? delta?.reasoning) : delta?.reasoning,
        );
        if (reasoning) {
          reasoningChunks.push(reasoning);
        }
      }

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
      }
    }

    const content = contentChunks.join("").trim();
    if (!content) {
      throw new Error("LLM returned empty response");
    }

    const reasoning = reasoningChunks.join("").trim();
    return {
      content,
      reasoning: reasoning || undefined,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }

  const completion = await client.chat.completions.create({
    ...request,
    stream: false,
  });

  const message = completion.choices[0]?.message as {
    content?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
  } | undefined;

  const content = extractTextValue(message?.content).trim();
  if (!content) {
    throw new Error("LLM returned empty response");
  }

  const reasoning = options.includeReasoning
    ? extractTextValue(moonshotCompat ? (message?.reasoning_content ?? message?.reasoning) : message?.reasoning).trim()
    : "";

  return {
    content,
    reasoning: reasoning || undefined,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens
        ?? ((completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0)),
    },
  };
}

async function buildProfileChatSystemPrompt(input?: {
  readonly genre?: string;
  readonly platform?: string;
  readonly provider?: string;
  readonly model?: string;
}): Promise<string> {
  const genre = input?.genre?.trim() || "other";
  const platform = input?.platform?.trim() || "other";
  const systemContext = await buildInitAssistantSystemContext({ genre, platform });
  const inkosHome = process.env.INKOS_HOME?.trim() || join(process.env.HOME ?? "/root", ".inkos");
  const inkosProjectRoot = process.env.INKOS_PROJECT_ROOT?.trim() || projectRoot;

  return [
    "以下内容是当前项目的业务背景资料，供你在 InkOS 使用场景下回答问题时参考。",
    `当前测试面板绑定的模型配置：provider=${input?.provider ?? "unknown"}，model=${input?.model ?? "unknown"}。`,
    `当前 InkOS 全局配置目录（INKOS_HOME）：${inkosHome}`,
    `当前 InkOS 项目目录（INKOS_PROJECT_ROOT）：${inkosProjectRoot}`,
    "已知的关键文件与目录：",
    `- 模型配置目录：${inkosHome}`,
    `- 全局环境文件：${join(inkosHome, ".env")}`,
    `- 多套模型配置数据库：${join(inkosHome, "profiles.db")}`,
    `- 书籍根目录：${join(inkosProjectRoot, "books")}`,
    `- 单本书章节目录模式：${join(inkosProjectRoot, "books", "<bookId>", "chapters")}`,
    `- 项目配置文件：${join(inkosProjectRoot, "inkos.json")}`,
    "书籍目录下包含书籍配置、story 长期记忆文件、chapters 章节文件等内容。",
    "当问题与小说生产、题材、平台、写作流程、审计流程、项目文件路径有关时，可以结合这些背景信息提高回答相关性。",
    "",
    systemContext,
  ].join("\n");
}

const PROFILE_CHAT_TOOLS: ReadonlyArray<ToolDefinition> = [
  {
    name: "list_directory",
    description: "列出目录内容。可用于查看 INKOS_HOME 或 INKOS_PROJECT_ROOT 下的文件和目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_text_file",
    description: "读取文本文件内容。适合 .env、.json、.md、.txt 等文本文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_text_file",
    description: "覆盖写入文本文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
        content: { type: "string", description: "要写入的完整文本内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "make_directory",
    description: "创建目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["path"],
    },
  },
  {
    name: "move_path",
    description: "移动或重命名文件/目录。",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "源路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
        to: { type: "string", description: "目标路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "delete_path",
    description: "删除文件或目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_books",
    description: "列出当前项目下的所有书籍及其状态。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_llm_profiles",
    description: "列出当前多套 LLM 配置。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "activate_llm_profile",
    description: "激活指定的 LLM 配置，并写回当前全局 .env。",
    parameters: {
      type: "object",
      properties: {
        profileId: { type: "string", description: "要激活的 profile id" },
      },
      required: ["profileId"],
    },
  },
];

function normalizeProfileToolPath(inputPath: string): string {
  const inkosHome = resolveInkosHomeDir();
  const raw = inputPath.trim()
    .replace(/^INKOS_HOME(?=\/|$)/, inkosHome)
    .replace(/^INKOS_PROJECT_ROOT(?=\/|$)/, projectRoot);
  const resolvedPath = resolve(raw);
  const allowedRoots = [resolve(inkosHome), resolve(projectRoot)];
  const inAllowedRoot = allowedRoots.some((root) => resolvedPath === root || resolvedPath.startsWith(`${root}/`));
  if (!inAllowedRoot) {
    throw new Error(`Path not allowed: ${inputPath}`);
  }
  return resolvedPath;
}

async function executeProfileChatTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "list_directory": {
      const dirPath = normalizeProfileToolPath(String(args.path ?? ""));
      const entries = await readdir(dirPath, { withFileTypes: true });
      const payload = await Promise.all(entries.slice(0, 200).map(async (entry) => {
        const fullPath = join(dirPath, entry.name);
        const info = await stat(fullPath);
        return {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? "dir" : "file",
          size: info.size,
          mtime: info.mtime.toISOString(),
        };
      }));
      return JSON.stringify({ path: dirPath, entries: payload }, null, 2);
    }

    case "read_text_file": {
      const filePath = normalizeProfileToolPath(String(args.path ?? ""));
      const allowedTextExt = new Set([".env", ".json", ".md", ".txt", ".yaml", ".yml", ".log"]);
      const extension = extname(filePath).toLowerCase();
      if (!allowedTextExt.has(extension) && basename(filePath) !== ".env") {
        throw new Error(`Only text-like files are supported: ${filePath}`);
      }
      const content = await readFile(filePath, "utf-8");
      return JSON.stringify({ path: filePath, content }, null, 2);
    }

    case "write_text_file": {
      const filePath = normalizeProfileToolPath(String(args.path ?? ""));
      const content = String(args.content ?? "");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf-8");
      return JSON.stringify({ ok: true, path: filePath, size: content.length }, null, 2);
    }

    case "make_directory": {
      const dirPath = normalizeProfileToolPath(String(args.path ?? ""));
      await mkdir(dirPath, { recursive: true });
      return JSON.stringify({ ok: true, path: dirPath }, null, 2);
    }

    case "move_path": {
      const fromPath = normalizeProfileToolPath(String(args.from ?? ""));
      const toPath = normalizeProfileToolPath(String(args.to ?? ""));
      await mkdir(dirname(toPath), { recursive: true });
      await rename(fromPath, toPath);
      return JSON.stringify({ ok: true, from: fromPath, to: toPath }, null, 2);
    }

    case "delete_path": {
      const path = normalizeProfileToolPath(String(args.path ?? ""));
      await rm(path, { recursive: true, force: true });
      return JSON.stringify({ ok: true, path }, null, 2);
    }

    case "list_books": {
      const state = new StateManager(projectRoot);
      const books = await state.listBooks();
      const summaries = await Promise.all(books.map(async (bookId) => {
        try {
          const book = await state.loadBookConfig(bookId);
          const chapters = await state.loadChapterIndex(bookId);
          return {
            id: book.id,
            title: book.title,
            status: book.status,
            chapters: chapters.length,
          };
        } catch {
          return { id: bookId, error: "failed to load" };
        }
      }));
      return JSON.stringify(summaries, null, 2);
    }

    case "list_llm_profiles": {
      const db = openProfilesDb();
      try {
        const rows = db.prepare("SELECT * FROM llm_profiles ORDER BY is_active DESC, updated_at DESC").all() as unknown as LlmProfileRow[];
        return JSON.stringify(rows.map((row) => mapProfileRow(row)), null, 2);
      } finally {
        db.close();
      }
    }

    case "activate_llm_profile": {
      const profileId = String(args.profileId ?? "");
      const profile = await activateLlmProfile(profileId);
      return JSON.stringify({ ok: true, profile }, null, 2);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function runProfileChatWithTools(
  profileId: string,
  client: ReturnType<typeof createLLMClient>,
  model: string,
  messages: ReadonlyArray<{ readonly role: "system" | "user" | "assistant"; readonly content: string }>,
  options?: {
    readonly useStream?: boolean;
    readonly includeReasoning?: boolean;
  },
): Promise<{
  readonly content: string;
  readonly reasoning?: string;
  readonly toolTrace: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>;
}> {
  return runToolEnabledConversation(client, model, messages, {
    maxTurns: 8,
    useStream: options?.useStream,
    includeReasoning: options?.includeReasoning,
    logToolCall: (name, args) => {
      logInfo("llm_profiles.chat.tool", { profileId, tool: name, args: sanitizeForLog(args) as Record<string, unknown> });
    },
  });
}

async function runToolEnabledConversation(
  client: ReturnType<typeof createLLMClient>,
  model: string,
  messages: ReadonlyArray<{ readonly role: "system" | "user" | "assistant"; readonly content: string }>,
  options?: {
    readonly maxTurns?: number;
    readonly useStream?: boolean;
    readonly includeReasoning?: boolean;
    readonly logToolCall?: (name: string, args: Record<string, unknown>) => void;
    readonly tools?: ReadonlyArray<ToolDefinition>;
    readonly executeTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
  },
): Promise<{
  readonly content: string;
  readonly reasoning?: string;
  readonly toolTrace: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>;
}> {
  const tools = options?.tools ?? PROFILE_CHAT_TOOLS;
  const executeTool = options?.executeTool ?? executeProfileChatTool;
  const toolTrace: Array<{ readonly name: string; readonly args: Record<string, unknown> }> = [];
  const conversation: AgentMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  })) as AgentMessage[];

  let lastAssistantMessage = "";
  let lastAssistantReasoning = "";
  for (let turn = 0; turn < (options?.maxTurns ?? 8); turn++) {
    const result = await chatWithTools(client, model, conversation, tools, {
      useStream: options?.useStream,
      includeReasoning: options?.includeReasoning,
    });
    conversation.push({
      role: "assistant",
      content: result.content || null,
      ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
    });

    if (result.content) {
      lastAssistantMessage = result.content;
    }
    if (result.reasoning) {
      lastAssistantReasoning = result.reasoning;
    }
    if (result.toolCalls.length === 0) {
      break;
    }

    for (const toolCall of result.toolCalls) {
      const args = parseToolArguments(toolCall.arguments);
      toolTrace.push({ name: toolCall.name, args });
      options?.logToolCall?.(toolCall.name, args);
      const toolResult = await executeTool(toolCall.name, args);
      conversation.push({ role: "tool", toolCallId: toolCall.id, content: toolResult });
    }
  }

  return { content: lastAssistantMessage, reasoning: lastAssistantReasoning || undefined, toolTrace };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Tool arguments must be a JSON object: ${raw}`);
  }
  return parsed as Record<string, unknown>;
}

const CHAPTER_CHAT_TOOLS: ReadonlyArray<ToolDefinition> = [
  {
    name: "get_current_chapter_paths",
    description: "获取当前章节的真实文件路径与相关目录。凡是提到路径、文件位置、要读哪个文件，都应先调用这个工具，不允许凭空猜测。",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "read_text_file",
    description: "读取当前项目中的文本文件。适合查看章节、story 文件、.env、json、markdown 等。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "列出目录内容。可用于查看章节目录、story 目录等。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_text_file",
    description: "覆盖写入一个文本文件。你在 INKOS_PROJECT_ROOT 范围内可以自由使用它直接修改项目文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
        content: { type: "string", description: "写入后的完整文本内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "make_directory",
    description: "创建目录。你在 INKOS_PROJECT_ROOT 范围内可以自由创建需要的目录结构。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["path"],
    },
  },
  {
    name: "move_path",
    description: "移动或重命名项目目录内的文件/目录。",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "源路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
        to: { type: "string", description: "目标路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "delete_path",
    description: "删除项目目录内的文件或目录。请仅在用户明确要求删除时使用。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
      },
      required: ["path"],
    },
  },
];

function formatChapterAuditDetails(chapterMeta?: ChapterMeta, limit = 8): string {
  if (!chapterMeta?.auditDetails?.length) {
    return "结构化审计详情：（暂无）";
  }
  return [
    "结构化审计详情：",
    ...chapterMeta.auditDetails.slice(0, limit).map((issue, index) =>
      `${index + 1}. [${issue.severity}] ${issue.category}: ${issue.description}｜建议：${issue.suggestion}`),
  ].join("\n");
}

function buildChapterChatPathSnapshot(bookId: string, bookDir: string): {
  readonly bookDir: string;
  readonly chaptersDir: string;
  readonly storyDir: string;
  readonly chapterFiles: string[];
  readonly storyFiles: string[];
} {
  const chaptersDir = join(bookDir, "chapters");
  const storyDir = storyDirPath(bookId);
  return {
    bookDir,
    chaptersDir,
    storyDir,
    chapterFiles: [],
    storyFiles: [],
  };
}

async function hydrateChapterChatPathSnapshot(snapshot: ReturnType<typeof buildChapterChatPathSnapshot>): Promise<ReturnType<typeof buildChapterChatPathSnapshot>> {
  const chapterEntries = await readdir(snapshot.chaptersDir, { withFileTypes: true }).catch(() => []);
  const storyEntries = await readdir(snapshot.storyDir, { withFileTypes: true }).catch(() => []);
  return {
    ...snapshot,
    chapterFiles: chapterEntries.filter((entry) => entry.isFile()).map((entry) => join(snapshot.chaptersDir, entry.name)).sort(),
    storyFiles: storyEntries.filter((entry) => entry.isFile()).map((entry) => join(snapshot.storyDir, entry.name)).sort(),
  };
}

function ensureChapterChatPathAllowed(bookDir: string, rawPath: string): void {
  const normalized = normalizeProfileToolPath(rawPath);
  const relative = normalized.startsWith(bookDir) ? normalized.slice(bookDir.length) : null;
  const isInsideBook = relative !== null && (relative === "" || relative.startsWith("/"));
  if (!isInsideBook) {
    throw new Error(`章节对话只允许访问当前书籍目录内的真实路径：${normalized}`);
  }
}

async function executeChapterChatTool(
  input: { readonly bookId: string; readonly chapterNumber: number },
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const state = new StateManager(projectRoot);
  const bookDir = state.bookDir(input.bookId);
  const pathSnapshot = await hydrateChapterChatPathSnapshot(buildChapterChatPathSnapshot(input.bookId, bookDir));

  if (
    name === "read_text_file"
    || name === "list_directory"
    || name === "write_text_file"
    || name === "make_directory"
    || name === "delete_path"
  ) {
    try {
      ensureChapterChatPathAllowed(bookDir, String(args.path ?? ""));
      return await executeProfileChatTool(name, args);
    } catch (error) {
      return JSON.stringify({
        ok: false,
        recoverable: true,
        tool: name,
        error: describeError(error),
        nextAction: "call get_current_chapter_paths",
        hint: "路径错误后，不要继续猜路径。请先重新调用 get_current_chapter_paths，再严格从返回的 chapterFiles / storyFiles 里选择真实存在的文件。",
        chapterFiles: pathSnapshot.chapterFiles,
        storyFiles: pathSnapshot.storyFiles,
      }, null, 2);
    }
  }

  if (name === "move_path") {
    try {
      ensureChapterChatPathAllowed(bookDir, String(args.from ?? ""));
      ensureChapterChatPathAllowed(bookDir, String(args.to ?? ""));
      return await executeProfileChatTool(name, args);
    } catch (error) {
      return JSON.stringify({
        ok: false,
        recoverable: true,
        tool: name,
        error: describeError(error),
        nextAction: "call get_current_chapter_paths",
        hint: "路径错误后，不要继续猜路径。请先重新调用 get_current_chapter_paths，再严格从返回的 chapterFiles / storyFiles 里选择真实存在的文件。",
        chapterFiles: pathSnapshot.chapterFiles,
        storyFiles: pathSnapshot.storyFiles,
      }, null, 2);
    }
  }

  const bookId = input.bookId;
  const chapterNumber = input.chapterNumber;

  switch (name) {
    case "get_current_chapter_paths": {
      const book = await state.loadBookConfig(bookId);
      const index = await state.loadChapterIndex(bookId);
      const chapterMeta = index.find((item) => item.number === chapterNumber);
      const chapterFile = await findChapterFile(bookDir, chapterNumber, chapterMeta?.title);
      return JSON.stringify({
        ok: true,
        bookId,
        bookTitle: book.title,
        chapter: chapterNumber,
        chapterTitle: chapterMeta?.title ?? null,
        projectRoot,
        bookDir,
        chaptersDir: pathSnapshot.chaptersDir,
        storyDir: pathSnapshot.storyDir,
        chapterFile,
        authorBriefPath: authorBriefPath(bookId),
        currentStatePath: storyFilePath(bookId, "current_state.md"),
        pendingHooksPath: storyFilePath(bookId, "pending_hooks.md"),
        chapterSummariesPath: storyFilePath(bookId, "chapter_summaries.md"),
        chapterFiles: pathSnapshot.chapterFiles,
        storyFiles: pathSnapshot.storyFiles,
      }, null, 2);
    }

    default:
      throw new Error(`Unknown chapter chat tool: ${name}`);
  }
}

async function upsertActiveLlmProfileFromInit(payload: LlmProfilePayload): Promise<void> {
  const db = openProfilesDb();
  const now = Date.now();
  try {
    const active = db.prepare("SELECT * FROM llm_profiles WHERE is_active = 1 LIMIT 1").get() as LlmProfileRow | undefined;
    if (active) {
      db
        .prepare(
          `UPDATE llm_profiles
             SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?,
                 temperature = ?, max_tokens = ?, thinking_budget = ?, api_format = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          payload.name,
          payload.provider,
          payload.baseUrl,
          payload.apiKey,
          payload.model,
          payload.temperature ?? null,
          payload.maxTokens ?? null,
          payload.thinkingBudget ?? null,
          payload.apiFormat ?? null,
          now,
          active.id,
        );
      return;
    }

    db
      .prepare(
        `INSERT INTO llm_profiles
          (id, name, provider, base_url, api_key, model, temperature, max_tokens, thinking_budget, api_format, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        randomUUID(),
        payload.name,
        payload.provider,
        payload.baseUrl,
        payload.apiKey,
        payload.model,
        payload.temperature ?? null,
        payload.maxTokens ?? null,
        payload.thinkingBudget ?? null,
        payload.apiFormat ?? null,
        now,
        now,
      );
  } finally {
    db.close();
  }
}

function computeAnalytics(
  bookId: string,
  chapters: ReadonlyArray<Pick<ChapterMeta, "number" | "status" | "wordCount" | "auditIssues">>,
): {
  readonly bookId: string;
  readonly totalChapters: number;
  readonly totalWords: number;
  readonly avgWordsPerChapter: number;
  readonly auditPassRate: number;
  readonly topIssueCategories: ReadonlyArray<{ readonly category: string; readonly count: number }>;
  readonly chaptersWithMostIssues: ReadonlyArray<{ readonly chapter: number; readonly issueCount: number }>;
  readonly statusDistribution: Record<string, number>;
} {
  const totalChapters = chapters.length;
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
  const avgWordsPerChapter = totalChapters > 0 ? Math.round(totalWords / totalChapters) : 0;
  const passedStatuses = new Set(["ready-for-review", "approved", "published"]);
  const audited = chapters.filter((chapter) => !["drafted", "drafting", "card-generated"].includes(chapter.status));
  const passed = audited.filter((chapter) => passedStatuses.has(chapter.status));
  const auditPassRate = audited.length > 0 ? Math.round((passed.length / audited.length) * 100) : 100;

  const categoryCounts = new Map<string, number>();
  for (const chapter of chapters) {
    for (const issue of chapter.auditIssues) {
      const match = issue.match(/\[(?:critical|warning|info)\]\s*(.+?)[:：]/);
      const category = match?.[1] ?? "未分类";
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
  }
  const topIssueCategories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([category, count]) => ({ category, count }));

  const chaptersWithMostIssues = [...chapters]
    .filter((chapter) => chapter.auditIssues.length > 0)
    .sort((a, b) => b.auditIssues.length - a.auditIssues.length)
    .slice(0, 5)
    .map((chapter) => ({ chapter: chapter.number, issueCount: chapter.auditIssues.length }));

  const statusDistribution: Record<string, number> = {};
  for (const chapter of chapters) {
    statusDistribution[chapter.status] = (statusDistribution[chapter.status] ?? 0) + 1;
  }

  return {
    bookId,
    totalChapters,
    totalWords,
    avgWordsPerChapter,
    auditPassRate,
    topIssueCategories,
    chaptersWithMostIssues,
    statusDistribution,
  };
}

async function findChapterFile(bookDir: string, chapterNumber: number, preferredTitle?: string): Promise<string> {
  const chaptersDir = join(bookDir, "chapters");
  const resolved = await resolveChapterFile(chaptersDir, chapterNumber, preferredTitle);
  if (resolved.duplicates.length > 0) {
    logInfo("chapter.file.multiple_matches", {
      chapterNumber,
      bookDir,
      preferredTitle: preferredTitle ?? null,
      selected: resolved.selected.file,
      candidates: resolved.candidates.map((item) => ({
        file: item.file,
        size: item.size,
        mtimeMs: item.mtimeMs,
        headingTitle: item.headingTitle,
      })),
    });
  }
  return resolved.selected.fullPath;
}

async function daemonStatus(): Promise<{ running: boolean; pid: number | null }> {
  try {
    const pid = parseInt((await readFile(daemonPidPath(), "utf-8")).trim(), 10);
    return {
      running: Number.isFinite(pid),
      pid: Number.isFinite(pid) ? pid : null,
    };
  } catch {
    return { running: false, pid: null };
  }
}

async function initializeBookSkeleton(bookId: string): Promise<void> {
  const storyDir = join(projectRoot, "books", bookId, "story");
  await mkdir(storyDir, { recursive: true });
  await Promise.all([
    writeFile(join(storyDir, "story_bible.md"), "# 故事圣经\n\n（快速初始化占位，后续写作会逐步完善）\n", "utf-8"),
    writeFile(join(storyDir, "volume_outline.md"), "# 卷纲\n\n（快速初始化占位）\n", "utf-8"),
    writeFile(
      join(storyDir, "book_rules.md"),
      [
        "---",
        "version: \"1.0\"",
        "protagonist:",
        "  name: \"未命名主角\"",
        "  personalityLock: []",
        "  behavioralConstraints: []",
        "genreLock:",
        "  primary: other",
        "  forbidden: []",
        "prohibitions: []",
        "chapterTypesOverride: []",
        "fatigueWordsOverride: []",
        "additionalAuditDimensions: []",
        "enableFullCastTracking: false",
        "---",
        "",
        "## 叙事视角",
        "第一人称/第三人称按章节需要确定。",
      ].join("\n"),
      "utf-8",
    ),
    writeFile(join(storyDir, "current_state.md"), "# 当前状态\n\n| 字段 | 值 |\n|------|-----|\n| 当前章节 | 0 |\n", "utf-8"),
    writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n\n| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |\n|--------|----------|------|------|----------|----------|------|\n", "utf-8"),
    writeFile(join(storyDir, "particle_ledger.md"), "# 资源账本\n\n| 章节 | 期初值 | 来源 | 完整度 | 增量 | 期末值 | 依据 |\n|------|--------|------|--------|------|--------|------|\n", "utf-8"),
    writeFile(join(storyDir, "chapter_summaries.md"), "# 章节摘要\n\n", "utf-8"),
    writeFile(join(storyDir, "subplot_board.md"), "# 支线进度板\n\n", "utf-8"),
    writeFile(join(storyDir, "emotional_arcs.md"), "# 情感弧线\n\n", "utf-8"),
    writeFile(join(storyDir, "character_matrix.md"), "# 角色交互矩阵\n\n", "utf-8"),
  ]);
}

function storyDirPath(bookId: string): string {
  return join(projectRoot, "books", bookId, "story");
}

function storyFilePath(bookId: string, filename: string): string {
  return join(storyDirPath(bookId), filename);
}

function authorBriefPath(bookId: string): string {
  return storyFilePath(bookId, "author_brief.md");
}

async function readAuthorBrief(bookId: string): Promise<string> {
  try {
    return await readFile(authorBriefPath(bookId), "utf-8");
  } catch {
    return "";
  }
}

async function readStoryFile(bookId: string, filename: string): Promise<string> {
  try {
    return await readFile(storyFilePath(bookId, filename), "utf-8");
  } catch {
    return "";
  }
}

async function writeAuthorBrief(bookId: string, content: string): Promise<void> {
  if (!content.trim()) return;
  await mkdir(dirname(authorBriefPath(bookId)), { recursive: true });
  await writeFile(authorBriefPath(bookId), content.trimEnd() + "\n", "utf-8");
}

function composeInitContext(context?: string, authorBrief?: string): string | undefined {
  const sections = [
    context?.trim() ? `## 作者补充约束\n${context.trim()}` : "",
    authorBrief?.trim() ? `## 作者创作简报\n${authorBrief.trim()}` : "",
  ].filter(Boolean);

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function mergeAuthorBrief(context?: string, authorBrief?: string): string | undefined {
  const sections = [
    context?.trim() ? `## 长期创作约束\n${context.trim()}` : "",
    authorBrief?.trim() ? authorBrief.trim() : "",
  ].filter(Boolean);

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

async function buildExistingBookContext(bookId: string): Promise<{
  readonly pathBlock: string;
  readonly memoryBlock: string;
}> {
  const state = new StateManager(projectRoot);
  const bookDir = state.bookDir(bookId);
  const chapterIndex = await state.loadChapterIndex(bookId);
  const latestChapter = [...chapterIndex].sort((left, right) => right.number - left.number)[0];
  const latestChapterFile = latestChapter
    ? await findChapterFile(bookDir, latestChapter.number, latestChapter.title).catch(() => "")
    : "";

  const [authorBrief, currentState, pendingHooks, chapterSummaries] = await Promise.all([
    readAuthorBrief(bookId),
    readStoryFile(bookId, "current_state.md"),
    readStoryFile(bookId, "pending_hooks.md"),
    readStoryFile(bookId, "chapter_summaries.md"),
  ]);

  const pathBlock = [
    "## 当前书籍项目路径",
    `- bookId：${bookId}`,
    `- 书籍目录：${bookDir}`,
    `- story 目录：${storyDirPath(bookId)}`,
    `- 作者简报：${authorBriefPath(bookId)}`,
    `- 状态卡：${storyFilePath(bookId, "current_state.md")}`,
    `- 伏笔池：${storyFilePath(bookId, "pending_hooks.md")}`,
    `- 章节摘要：${storyFilePath(bookId, "chapter_summaries.md")}`,
    `- 支线进度板：${storyFilePath(bookId, "subplot_board.md")}`,
    `- 情感弧线：${storyFilePath(bookId, "emotional_arcs.md")}`,
    `- 角色矩阵：${storyFilePath(bookId, "character_matrix.md")}`,
    latestChapter
      ? `- 最新章节文件：${latestChapterFile || `第${latestChapter.number}章文件解析失败`}`
      : "- 最新章节文件：（暂无）",
    `- 已有章节数：${chapterIndex.length}`,
    latestChapter ? `- 最近章节：第${latestChapter.number}章 ${latestChapter.title}` : "- 最近章节：（暂无）",
    "这是一本已经存在的书，请优先在这些已有资料基础上补强，不要把它当成全新开书。",
  ].join("\n");

  const memoryBlock = [
    authorBrief.trim() ? `## 已有作者简报（${authorBriefPath(bookId)}）\n${authorBrief.trim()}` : "",
    currentState.trim() ? `## 当前状态卡（${storyFilePath(bookId, "current_state.md")}）\n${currentState.trim()}` : "",
    pendingHooks.trim() ? `## 当前伏笔池（${storyFilePath(bookId, "pending_hooks.md")}）\n${pendingHooks.trim().slice(-2500)}` : "",
    chapterSummaries.trim() ? `## 章节摘要（${storyFilePath(bookId, "chapter_summaries.md")}）\n${chapterSummaries.trim().slice(-3500)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { pathBlock, memoryBlock };
}

function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

function parseInitAssistantPayload(raw: string, currentBrief?: string): { reply: string; brief: string } {
  const candidate = extractJsonBlock(raw);
  const parsed = safeParseJson(candidate);
  if (parsed && typeof parsed === "object") {
    const reply = "reply" in parsed ? String((parsed as { reply?: unknown }).reply ?? "").trim() : "";
    const brief = "brief" in parsed ? String((parsed as { brief?: unknown }).brief ?? "").trim() : "";
    if (reply || brief) {
      return {
        reply: reply || "我已经整理好了当前方向，你可以继续补充人物、冲突或结局。",
        brief: brief || currentBrief?.trim() || "",
      };
    }
  }

  return {
    reply: raw.trim(),
    brief: currentBrief?.trim() || "",
  };
}

async function buildInitAssistantSystemContext(input: {
  readonly genre: string;
  readonly platform: string;
}): Promise<string> {
  let genreContext = `题材 ${input.genre} 暂无专属 profile，请按通俗网文开书逻辑处理。`;

  try {
    const parsed = await readGenreProfile(projectRoot, input.genre);
    const trimmedBody = parsed.body
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .slice(0, 2200);
    genreContext = [
      `题材名称：${parsed.profile.name}（${parsed.profile.id}）`,
      `章节类型：${parsed.profile.chapterTypes.join("、")}`,
      `节奏规则：${parsed.profile.pacingRule}`,
      `爽点类型：${parsed.profile.satisfactionTypes.join("、")}`,
      "",
      "题材规则摘要：",
      trimmedBody,
    ].join("\n");
  } catch {
    // Fallback to generic context.
  }

  return [
    "## InkOS 系统上下文",
    "你服务的是 InkOS 小说生产系统，不是通用聊天机器人。",
    `系统当前支持的标准题材有：${SUPPORTED_GENRES}。如果作者的想法跨题材，你要帮助他收束成最接近的一种主题材。`,
    "作者一旦确认方案，系统后续会基于该方案自动生成：故事圣经、卷纲、本书规则、当前状态、伏笔池、资源账本、章节摘要等长期记忆文件。",
    "所以你在初始化阶段必须帮作者把以下内容尽量聊清楚：题眼、主线、主角目标、阶段性高潮、结局方向、关键角色、世界或舞台边界、明显禁忌。",
    "如果作者要写爽文，你要主动把爽点结构、反转节奏、开篇钩子和回报机制聊实，不要停留在空泛概念。",
    "",
    "## 平台偏好",
    PLATFORM_GUIDANCE[input.platform] ?? PLATFORM_GUIDANCE.other,
    "",
    "## 题材知识",
    genreContext,
  ].join("\n");
}

async function runInitAssistant(input: {
  readonly bookId?: string;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly targetChapters: number;
  readonly chapterWords: number;
  readonly context?: string;
  readonly currentBrief?: string;
  readonly messages: ReadonlyArray<InitAssistantMessage>;
  readonly useStream?: boolean;
  readonly includeReasoning?: boolean;
  readonly profileId?: string;
}): Promise<{ reply: string; brief: string; reasoning?: string; model: string; profileId?: string }> {
  const llm = await createClientFromOptionalProfile(input.profileId);
  logInfo("init_assistant.llm.start", {
    bookId: input.bookId ?? null,
    profileId: llm.profileId ?? null,
    model: llm.model,
  });
  const resolvedBookId = input.bookId?.trim()
    ? await resolveBookId(projectRoot, input.bookId.trim())
    : undefined;
  const systemContext = await buildInitAssistantSystemContext({
    genre: input.genre,
    platform: input.platform,
  });
  const existingBookContext = resolvedBookId
    ? await buildExistingBookContext(resolvedBookId)
    : null;

  const systemPrompt = [
    "你是 InkOS 的智能初始化助手，负责在作者开书前通过对话梳理小说方案。",
    "你的任务不是直接写小说，而是帮助作者明确：主题、卖点、主线走向、阶段高潮、结局方向、主角人设、平台适配点。",
    "请使用简体中文，语气像资深网文编辑，直接、具体、可执行。",
    "如果信息还不完整，可以继续追问，但一次最多问 3 个关键问题。",
    "你必须显式利用系统给你的平台信息、题材规则和 InkOS 架构上下文，不要把自己当成普通写作助手。",
    "如果我提供了某本已存在书籍的目录、story 文件路径和已有长期记忆，说明这次是在旧书基础上继续补强，你必须优先尊重这些已有资料。",
    "遇到书名还不稳、主线不清、结局含糊、主角动机发虚时，优先追问这些关键点。",
    "每次都要同步维护一份可直接用于初始化的“创作简报”。",
    "reply 字段可以使用 Markdown，便于用标题、列表等方式提高可读性；brief 字段继续输出完整创作简报 Markdown。",
    "输出必须是 JSON，对象结构如下：",
    "{\"reply\":\"给作者的话\",\"brief\":\"完整创作简报Markdown\"}",
    "不要用 Markdown 代码块包裹整个 JSON，不要输出额外解释。",
    "",
    systemContext,
  ].join("\n");

  const metaPrompt = [
    "以下是当前书籍基础信息：",
    `- 书名：${input.title || "未命名"}`,
    `- 题材：${input.genre}`,
    `- 平台：${input.platform}`,
    `- 目标章节数：${input.targetChapters}`,
    `- 每章字数：${input.chapterWords}`,
    input.context?.trim() ? `- 作者额外约束：${input.context.trim()}` : "- 作者额外约束：（暂无）",
    "",
    "当前创作简报：",
    input.currentBrief?.trim() ? input.currentBrief.trim() : "（暂无，请你根据对话逐步整理）",
    existingBookContext?.pathBlock ?? "",
    existingBookContext?.memoryBlock ?? "",
    "",
    "创作简报建议至少包含这些部分：",
    "## 书名候选与题眼",
    "## 核心概念",
    "## 题材卖点与平台方向",
    "## 开篇切入与前三章钩子",
    "## 主线走向",
    "## 阶段高潮设计",
    "## 结局方向",
    "## 主角与关键角色",
    "## 世界观/舞台",
    "## 节奏与卷纲倾向",
    "## 明确禁忌与边界",
  ].join("\n");

  const messages: Array<{ readonly role: "system" | "user" | "assistant"; readonly content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: metaPrompt },
    ...input.messages.map((message) => ({ role: message.role, content: message.content })),
  ];

  const response = await runToolEnabledConversation(llm.client, llm.model, messages, {
    maxTurns: 8,
    useStream: input.useStream,
    includeReasoning: input.includeReasoning,
    logToolCall: (name, args) => {
      logInfo("init_assistant.chat.tool", { tool: name, args: sanitizeForLog(args) as Record<string, unknown> });
    },
  });

  return {
    ...parseInitAssistantPayload(response.content, input.currentBrief),
    reasoning: response.reasoning,
    model: llm.model,
    profileId: llm.profileId,
  };
}

async function updateProjectModelOverrides(updates: Record<string, string | null | undefined>): Promise<Record<string, unknown>> {
  const configPath = join(projectRoot, "inkos.json");
  const raw = await readFile(configPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, unknown> & {
    modelOverrides?: Record<string, string>;
  };

  const merged = { ...(config.modelOverrides ?? {}) };
  for (const [key, value] of Object.entries(updates)) {
    if (value && value.trim()) {
      merged[key] = value.trim();
    } else {
      delete merged[key];
    }
  }

  if (Object.keys(merged).length > 0) {
    config.modelOverrides = merged;
  } else {
    delete config.modelOverrides;
  }

  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

function buildChapterChatFallbackReply(toolTrace: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>): string {
  if (toolTrace.some((item) => item.name === "write_text_file")) {
    return "已按你的要求完成修改，并写回相关文件。你可以继续让我解释改动点，或再提具体调整要求。";
  }
  if (toolTrace.some((item) => item.name === "read_text_file")) {
    return "我已经查看了相关章节/状态文件。本次没有直接输出正文答复，你可以继续告诉我要改哪里。";
  }
  if (toolTrace.length > 0) {
    return "我已经完成本次处理，但没有生成可展示的正文回复。你可以继续补充更具体的修改要求。";
  }
  return "我收到了这次请求，但没有生成可展示的回复。你可以换一种更具体的说法再试一次。";
}

async function runChapterAssistant(input: {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly messages: ReadonlyArray<ChapterAssistantMessage>;
  readonly useStream?: boolean;
  readonly includeReasoning?: boolean;
  readonly profileId?: string;
}): Promise<{ reply: string; reasoning?: string; model: string; profileId?: string }> {
  const config = await loadProjectConfig(projectRoot);
  const state = new StateManager(projectRoot);
  const book = await state.loadBookConfig(input.bookId);
  const chapterMeta = (await state.loadChapterIndex(input.bookId)).find((item) => item.number === input.chapterNumber);
  const chapterFile = await findChapterFile(state.bookDir(input.bookId), input.chapterNumber, chapterMeta?.title);
  const chapterRaw = await readFile(chapterFile, "utf-8");
  const chapterContent = chapterRaw.split("\n").slice(2).join("\n").trim();
  const authorBrief = await readAuthorBrief(input.bookId);
  const currentState = await readStoryFile(input.bookId, "current_state.md");
  const pendingHooks = await readStoryFile(input.bookId, "pending_hooks.md");
  const chapterSummaries = await readStoryFile(input.bookId, "chapter_summaries.md");
  const bookDir = state.bookDir(input.bookId);
  const pathSnapshot = await hydrateChapterChatPathSnapshot(buildChapterChatPathSnapshot(input.bookId, bookDir));
  const dialogueModel = (config.modelOverrides?.dialogue ?? config.llm.model).trim();
  const llm = input.profileId?.trim()
    ? await createClientFromOptionalProfile(input.profileId)
    : {
        client: createLLMClient(config.llm),
        model: dialogueModel,
      };
  logInfo("chapter.chat.llm.start", {
    bookId: input.bookId,
    chapterNumber: input.chapterNumber,
    profileId: input.profileId ?? null,
    model: llm.model,
  });

  const systemPrompt = [
    "你是 InkOS 的章节级写作编辑助手。",
    "你的任务是围绕当前章节直接干活：读文件、改文件、解释修改。",
    "在 INKOS_PROJECT_ROOT 范围内，你可以自由读取、写入、创建、移动、删除项目文件；优先自己完成，不要空谈方案。",
    "章节对话框不是工作流执行器，不要自动触发审计、修订、再审计这类整章流程；这些继续由章节区按钮手动操作。",
    "凡是涉及路径、文件位置、读取哪个文件、修改哪个文件，必须先调用 get_current_chapter_paths 工具获取真实路径，然后再继续。",
    "禁止凭经验猜测目录结构，禁止自行拼接路径，禁止把 books/<bookId>/ 这一层省略掉。",
    "如果没有先调用工具确认路径，就不要在回答中写任何具体文件路径或执行任何文件操作。",
    "如果任何文件工具返回 recoverable=true 的路径错误，你必须立刻重新调用 get_current_chapter_paths，然后只从返回的 chapterFiles / storyFiles 中选择真实存在的文件继续执行。禁止在报错后继续猜路径。",
    "无论是否调用工具、无论是否已经完成文件修改，最后都必须输出一段面向用户的中文最终回复。",
    "如果你修改了文件，最终回复必须明确告诉用户你改了什么；如果你只读取了文件，也必须明确告诉用户你看了什么以及下一步建议。",
    "禁止只调用工具后直接结束，禁止把最终回复留空。",
    "最终回复必须使用规范 Markdown。标题、列表、表格、分隔线前后都要保留标准空行，禁止输出半截表格、半截标题或格式残缺的 Markdown。",
    "你可以使用 Markdown 组织回复，优先用短标题、列表、表格或代码块提高可读性。",
    "请使用自然简体中文，结论要直接，尽量给出分点建议。",
    "除文件路径、模型名、命令名这类必须保留的内容外，不要夹杂英文单词或中英混写表达。",
  ].join("\n");

  const contextPrompt = [
    `书籍：${book.title}（${input.bookId}）`,
    `题材：${book.genre}`,
    `平台：${book.platform}`,
    `章节：第${input.chapterNumber}章 ${chapterMeta?.title ?? ""}`.trim(),
    chapterMeta?.status ? `当前状态：${chapterMeta.status}` : "",
    chapterMeta?.auditIssues?.length ? `审计问题：\n- ${chapterMeta.auditIssues.join("\n- ")}` : "审计问题：（暂无）",
    formatChapterAuditDetails(chapterMeta),
    authorBrief.trim() ? `长期创作约束（${authorBriefPath(input.bookId)}）：\n${authorBrief.trim()}` : "长期创作约束：（暂无）",
    currentState.trim() ? `当前状态卡（${storyFilePath(input.bookId, "current_state.md")}）：\n${currentState.trim()}` : "",
    pendingHooks.trim() ? `伏笔池（${storyFilePath(input.bookId, "pending_hooks.md")}）：\n${pendingHooks.trim().slice(-2500)}` : "",
    chapterSummaries.trim() ? `章节摘要（${storyFilePath(input.bookId, "chapter_summaries.md")}）：\n${chapterSummaries.trim().slice(-3000)}` : "",
    `已确认真实章节文件：\n- ${pathSnapshot.chapterFiles.join("\n- ")}`,
    `已确认真实 story 文件：\n- ${pathSnapshot.storyFiles.join("\n- ")}`,
    `当前章节正文：\n${chapterContent.slice(0, 12000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await runToolEnabledConversation(
    llm.client,
    llm.model,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: contextPrompt },
      ...input.messages.map((message) => ({ role: message.role, content: message.content })),
    ],
    {
      maxTurns: 8,
      useStream: input.useStream,
      includeReasoning: input.includeReasoning,
      tools: CHAPTER_CHAT_TOOLS,
      executeTool: (name, args) => executeChapterChatTool(
        { bookId: input.bookId, chapterNumber: input.chapterNumber },
        name,
        args,
      ),
      logToolCall: (name, args) => {
        logInfo("chapter.chat.tool", {
          bookId: input.bookId,
          chapterNumber: input.chapterNumber,
          tool: name,
          args: sanitizeForLog(args) as Record<string, unknown>,
        });
      },
    },
  );

  const reply = response.content.trim() || buildChapterChatFallbackReply(response.toolTrace);

  if (!response.content.trim()) {
    logInfo("chapter.chat.empty_reply_fallback", {
      bookId: input.bookId,
      chapterNumber: input.chapterNumber,
      toolCount: response.toolTrace.length,
      toolNames: response.toolTrace.map((item) => item.name),
    });
  }

  return {
    reply,
    reasoning: response.reasoning,
    model: llm.model,
    profileId: "profileId" in llm ? llm.profileId : undefined,
  };
}

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    service: "inkos-service",
    projectRoot,
    daemon: await daemonStatus(),
  });
});

app.get("/api/project/summary", async (_req, res) => {
  res.json(await loadProjectSummary(projectRoot));
});

app.get("/api/project/config", async (_req, res) => {
  try {
    const raw = await readFile(join(projectRoot, "inkos.json"), "utf-8");
    res.json({ ok: true, config: JSON.parse(raw) });
  } catch (error) {
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.put("/api/project/config", async (req, res) => {
  const schema = z.object({
    modelOverrides: z.object({
      dialogue: z.string().optional().nullable(),
    }).optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    logInfo("project.config.update.start", { keys: Object.keys(input.modelOverrides ?? {}) });
    const config = await updateProjectModelOverrides({
      dialogue: input.modelOverrides?.dialogue,
    });
    logInfo("project.config.update.done", { hasDialogueOverride: Boolean((config.modelOverrides as Record<string, unknown> | undefined)?.dialogue) });
    res.json({ ok: true, config });
  } catch (error) {
    logError("project.config.update.error", { error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.get("/api/books/:bookId/status", async (req, res) => {
  try {
    const config = await loadProjectConfig(projectRoot);
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const pipeline = createPipeline(projectRoot, config);
    res.json({ ok: true, status: await pipeline.getBookStatus(bookId) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/books/:bookId/config", async (req, res) => {
  try {
    const state = new StateManager(projectRoot);
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const book = await state.loadBookConfig(bookId);
    res.json({ ok: true, book });
  } catch (error) {
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.put("/api/books/:bookId/config", async (req, res) => {
  const schema = z.object({
    targetChapters: z.number().int().min(1).optional(),
    chapterWordCount: z.number().int().min(1000).optional(),
    status: z.enum(["incubating", "outlining", "active", "paused", "completed", "dropped"]).optional(),
    genre: z.enum(["xuanhuan", "xianxia", "chuanyue", "urban", "horror", "other"]).optional(),
    platform: z.enum(["tomato", "feilu", "qidian", "other"]).optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const state = new StateManager(projectRoot);
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const existing = await state.loadBookConfig(bookId);
    logInfo("books.config.update.start", { bookId, updates: sanitizeForLog(input) as Record<string, unknown> });
    const updated = {
      ...existing,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    await state.saveBookConfig(bookId, updated);
    logInfo("books.config.update.done", { bookId });
    res.json({ ok: true, book: updated });
  } catch (error) {
    logError("books.config.update.error", { bookId: req.params.bookId, error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.post("/api/books/:bookId/style-import", async (req, res) => {
  const schema = z.object({
    filename: z.string().min(1),
    content: z.string().min(1),
    name: z.string().optional(),
    statsOnly: z.boolean().optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const state = new StateManager(projectRoot);
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const bookDir = state.bookDir(bookId);
    const refsDir = join(bookDir, "story", "style_references");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = sanitizeFilename(input.filename.endsWith(".txt") ? input.filename : `${input.filename}.txt`);
    const savedPath = join(refsDir, `${timestamp}_${safeName}`);

    logInfo("books.style_import.upload.start", {
      bookId,
      filename: input.filename,
      bytes: input.content.length,
      statsOnly: input.statsOnly ?? false,
    });

    await mkdir(refsDir, { recursive: true });
    await writeFile(savedPath, input.content, "utf-8");

    const args = ["style", "import", savedPath, bookId];
    if (input.name?.trim()) {
      args.push("--name", input.name.trim());
    }
    if (input.statsOnly) {
      args.push("--stats-only");
    }
    args.push("--json");

    const result = await spawnCli(args, {
      expectJson: true,
      timeoutMs: webCommandTimeoutMs,
    });

    const ok = result.code === 0 && (!result.parsed || !("error" in (result.parsed as Record<string, unknown>)));
    if (!ok) {
      throw new Error(
        typeof (result.parsed as { error?: unknown } | undefined)?.error === "string"
          ? String((result.parsed as { error?: unknown }).error)
          : result.stderr || result.stdout || "导入参考文风失败",
      );
    }

    logInfo("books.style_import.upload.done", {
      bookId,
      savedPath,
      statsOnly: input.statsOnly ?? false,
    });
    res.json({
      ok: true,
      bookId,
      savedPath,
      imported: result.parsed ?? { ok: true },
    });
  } catch (error) {
    logError("books.style_import.upload.error", {
      bookId: req.params.bookId,
      error: describeError(error),
    });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.get("/api/books/:bookId/analytics", async (req, res) => {
  try {
    const state = new StateManager(projectRoot);
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const chapters = await state.loadChapterIndex(bookId);
    res.json({ ok: true, analytics: computeAnalytics(bookId, chapters) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/books/:bookId/chapters", async (req, res) => {
  try {
    const state = new StateManager(projectRoot);
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const chapters = await state.loadChapterIndex(bookId);
    const sorted = [...chapters].sort((a, b) => a.number - b.number);
    res.json({ ok: true, bookId, chapters: sorted });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/books/:bookId/chapters/:chapter", async (req, res) => {
  try {
    const state = new StateManager(projectRoot);
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const chapterNumber = parseInt(req.params.chapter, 10);
    if (!Number.isFinite(chapterNumber) || chapterNumber < 1) {
      throw new Error(`Invalid chapter number: ${req.params.chapter}`);
    }
    const bookDir = state.bookDir(bookId);
    const chapterMeta = (await state.loadChapterIndex(bookId)).find((item) => item.number === chapterNumber);
    const chapterFile = await findChapterFile(bookDir, chapterNumber, chapterMeta?.title);
    const raw = await readFile(chapterFile, "utf-8");
    const lines = raw.split("\n");
    const title = lines[0]?.replace(/^#\s*/, "") ?? `第${chapterNumber}章`;
    const content = lines.slice(2).join("\n");
    res.json({
      ok: true,
      bookId,
      chapter: chapterNumber,
      title,
      filePath: chapterFile,
      content,
      meta: chapterMeta ?? null,
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/books/:bookId/chapters/:chapter/replace", async (req, res) => {
  const schema = z.object({
    content: z.string().min(1),
    title: z.string().optional(),
  });

  try {
    const state = new StateManager(projectRoot);
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const chapterNumber = parseInt(req.params.chapter, 10);
    if (!Number.isFinite(chapterNumber) || chapterNumber < 1) {
      throw new Error(`Invalid chapter number: ${req.params.chapter}`);
    }
    const input = schema.parse(req.body ?? {});
    const bookDir = state.bookDir(bookId);
    const chapterIndex = await state.loadChapterIndex(bookId);
    const chapterMeta = chapterIndex.find((item) => item.number === chapterNumber);
    if (!chapterMeta) {
      throw new Error(`Chapter ${chapterNumber} not found in index`);
    }
    const chapterFile = await findChapterFile(bookDir, chapterNumber, chapterMeta.title);

    const normalized = input.content.replace(/\r\n/g, "\n").trim();
    const withoutFence = normalized
      .replace(/^```[a-zA-Z0-9_-]*\n/, "")
      .replace(/\n```$/, "")
      .trim();
    const lines = withoutFence.split("\n");
    const heading = lines[0]?.trim() ?? "";
    const inferredTitle = heading.startsWith("#")
      ? heading.replace(/^#\s*/, "").replace(/^第\d+章\s*/, "").trim()
      : "";
    const nextTitle = input.title?.trim() || inferredTitle || chapterMeta.title;
    const nextBody = heading.startsWith("#")
      ? lines.slice(1).join("\n").trim()
      : withoutFence;

    const writeResult = await writeCanonicalChapterFile({
      chaptersDir: join(bookDir, "chapters"),
      chapterNumber,
      title: nextTitle,
      body: nextBody,
      trailingNewline: true,
    });

    const updatedAt = new Date().toISOString();
    const updatedIndex = chapterIndex.map((item) =>
      item.number === chapterNumber
        ? {
            ...item,
            title: nextTitle,
            wordCount: nextBody.length,
            status: "drafted" as ChapterMeta["status"],
            updatedAt,
            auditIssues: [],
          }
        : item,
    );
    await state.saveChapterIndex(bookId, updatedIndex);

    logInfo("chapter.replace.done", {
      bookId,
      chapter: chapterNumber,
      filePath: writeResult.fullPath,
      previousFilePath: chapterFile,
      removedDuplicates: writeResult.removedDuplicates,
      canonicalFile: buildChapterFilename(chapterNumber, nextTitle),
      title: nextTitle,
      wordCount: nextBody.length,
    });
    res.json({ ok: true, bookId, chapter: chapterNumber, filePath: writeResult.fullPath, title: nextTitle, wordCount: nextBody.length });
  } catch (error) {
    logError("chapter.replace.error", {
      bookId: req.params.bookId,
      chapter: req.params.chapter,
      error: describeError(error),
    });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.post("/api/books/:bookId/chapters/:chapter/chat", async (req, res) => {
  const schema = z.object({
    messages: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1),
    })).min(1),
    useStream: z.boolean().optional(),
    includeReasoning: z.boolean().optional(),
    profileId: z.string().optional(),
    async: z.boolean().optional(),
  });

  try {
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const chapterNumber = parseInt(req.params.chapter, 10);
    if (!Number.isFinite(chapterNumber) || chapterNumber < 1) {
      throw new Error(`Invalid chapter number: ${req.params.chapter}`);
    }
    const input = schema.parse(req.body ?? {});
    logInfo("chapter.chat.start", {
      bookId,
      chapterNumber,
      messageCount: input.messages.length,
      useStream: input.useStream !== false,
      includeReasoning: input.includeReasoning === true,
      profileId: input.profileId ?? null,
      async: input.async === true,
    });
    if (input.async) {
      const job = createJob({
        type: "chapter-chat",
        step: `ch${chapterNumber}:chat:queued`,
        bookId,
      });
      startJob(job, { chapter: chapterNumber, profileId: input.profileId ?? null });
      void (async () => {
        try {
          updateJobStep(job, `ch${chapterNumber}:chat:start`, { chapter: chapterNumber, profileId: input.profileId ?? null });
          const result = await runChapterAssistant({
            bookId,
            chapterNumber,
            messages: input.messages,
            useStream: input.useStream,
            includeReasoning: input.includeReasoning,
            profileId: input.profileId,
          });
          job.result = { ok: true, ...result };
          updateJobStep(job, `ch${chapterNumber}:chat:done`, {
            chapter: chapterNumber,
            profileId: result.profileId ?? input.profileId ?? null,
            model: result.model,
          });
          logInfo("chapter.chat.done", {
            bookId,
            chapterNumber,
            jobId: job.id,
            profileId: result.profileId ?? input.profileId ?? null,
            model: result.model,
          });
          finishJob(job, { chapter: chapterNumber, model: result.model });
        } catch (error) {
          failJob(job, error);
          logError("chapter.chat.error", {
            bookId,
            chapter: chapterNumber,
            jobId: job.id,
            error: describeError(error),
          });
        }
      })();
      res.json({ ok: true, jobId: job.id, queued: true });
      return;
    }
    const result = await runChapterAssistant({
      bookId,
      chapterNumber,
      messages: input.messages,
      useStream: input.useStream,
      includeReasoning: input.includeReasoning,
      profileId: input.profileId,
    });
    logInfo("chapter.chat.done", {
      bookId,
      chapterNumber,
      profileId: result.profileId ?? input.profileId ?? null,
      model: result.model,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    logError("chapter.chat.error", {
      bookId: req.params.bookId,
      chapter: req.params.chapter,
      error: describeError(error),
    });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.get("/api/llm-profiles", async (_req, res) => {
  try {
    const db = openProfilesDb();
    try {
      const rows = db
        .prepare("SELECT * FROM llm_profiles ORDER BY is_active DESC, updated_at DESC, created_at DESC")
        .all() as unknown as LlmProfileRow[];
      const profiles = rows.map((row) => mapProfileRow(row));
      const active = rows.find((row) => row.is_active === 1);
      res.json({ ok: true, profiles, activeProfileId: active?.id ?? null });
    } finally {
      db.close();
    }
  } catch (error) {
    logError("llm_profiles.list.error", { error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.post("/api/llm-profiles", async (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1),
    provider: z.enum(["openai", "anthropic"]).default("openai"),
    baseUrl: z.string().url().default("https://api.openai.com/v1"),
    apiKey: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).default("gpt-4o"),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).optional(),
    thinkingBudget: z.number().int().min(0).optional(),
    apiFormat: z.enum(["chat", "responses"]).optional(),
    activate: z.boolean().default(false),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const existingGlobal = await readGlobalLlmEnv();
    const finalApiKey = input.apiKey ?? existingGlobal.apiKey;
    if (!finalApiKey) {
      throw new Error("API Key is required for creating a profile.");
    }

    const now = Date.now();
    const id = randomUUID();
    const db = openProfilesDb();
    try {
      db
        .prepare(
          `INSERT INTO llm_profiles
            (id, name, provider, base_url, api_key, model, temperature, max_tokens, thinking_budget, api_format, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.provider,
          input.baseUrl,
          finalApiKey,
          input.model,
          input.temperature ?? null,
          input.maxTokens ?? null,
          input.thinkingBudget ?? null,
          input.apiFormat ?? null,
          now,
          now,
        );
    } finally {
      db.close();
    }

    const profile = input.activate
      ? await activateLlmProfile(id)
      : (() => {
          const db2 = openProfilesDb();
          try {
            const row = getProfileById(db2, id);
            if (!row) throw new Error(`LLM profile create verification failed: ${id}`);
            return mapProfileRow(row);
          } finally {
            db2.close();
          }
        })();

    logInfo("llm_profiles.create.done", {
      profileId: id,
      name: input.name,
      provider: input.provider,
      model: input.model,
      activated: input.activate,
    });
    res.json({ ok: true, profile, activated: input.activate });
  } catch (error) {
    logError("llm_profiles.create.error", { error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.put("/api/llm-profiles/:id", async (req, res) => {
  const schema = z.object({
    name: z.string().trim().min(1).optional(),
    provider: z.enum(["openai", "anthropic"]).optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).optional(),
    thinkingBudget: z.number().int().min(0).optional(),
    apiFormat: z.enum(["chat", "responses"]).optional(),
    activate: z.boolean().optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const profileId = req.params.id;
    const db = openProfilesDb();
    try {
      const existing = getProfileById(db, profileId);
      if (!existing) {
        throw new Error(`LLM profile not found: ${profileId}`);
      }
      const now = Date.now();
      db
        .prepare(
          `UPDATE llm_profiles
             SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?,
                 temperature = ?, max_tokens = ?, thinking_budget = ?, api_format = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.name ?? existing.name,
          input.provider ?? existing.provider,
          input.baseUrl ?? existing.base_url,
          input.apiKey ?? existing.api_key,
          input.model ?? existing.model,
          input.temperature ?? existing.temperature,
          input.maxTokens ?? existing.max_tokens,
          input.thinkingBudget ?? existing.thinking_budget,
          input.apiFormat ?? existing.api_format,
          now,
          profileId,
        );
    } finally {
      db.close();
    }

    const profile = input.activate ? await activateLlmProfile(profileId) : (() => {
      const db2 = openProfilesDb();
      try {
        const updated = getProfileById(db2, profileId);
        if (!updated) throw new Error(`LLM profile update verification failed: ${profileId}`);
        return mapProfileRow(updated);
      } finally {
        db2.close();
      }
    })();
    logInfo("llm_profiles.update.done", { profileId, activated: input.activate ?? false });
    res.json({ ok: true, profile, activated: input.activate ?? false });
  } catch (error) {
    logError("llm_profiles.update.error", { profileId: req.params.id, error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.post("/api/llm-profiles/:id/activate", async (req, res) => {
  try {
    const profileId = req.params.id;
    const profile = await activateLlmProfile(profileId);
    logInfo("llm_profiles.activate.done", { profileId });
    res.json({ ok: true, profile, activeProfileId: profileId });
  } catch (error) {
    logError("llm_profiles.activate.error", { profileId: req.params.id, error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.post("/api/llm-profiles/:id/test", async (req, res) => {
  try {
    const profileId = req.params.id;
    logInfo("llm_profiles.test.start", { profileId });
    const result = await testLlmProfile(profileId);
    logInfo("llm_profiles.test.done", {
      profileId,
      provider: result.provider,
      model: result.model,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    logError("llm_profiles.test.error", { profileId: req.params.id, error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.post("/api/llm-profiles/:id/chat", async (req, res) => {
  try {
    const profileId = req.params.id;
    const incoming: unknown[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = incoming
      .filter((item: unknown): item is { role?: unknown; content?: unknown } => Boolean(item) && typeof item === "object")
      .map((item: { role?: unknown; content?: unknown }) => ({
        role: item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user",
        content: typeof item.content === "string" ? item.content : "",
      }))
      .filter((item) => item.content.trim().length > 0) as Array<{ role: "system" | "user" | "assistant"; content: string }>;

    if (messages.length === 0) {
      res.status(400).json({ ok: false, error: "messages is required" });
      return;
    }

    const genre = typeof req.body?.genre === "string" ? req.body.genre : undefined;
    const platform = typeof req.body?.platform === "string" ? req.body.platform : undefined;
    const useStream = req.body?.useStream !== false;
    const includeReasoning = req.body?.includeReasoning === true;
    const db = openProfilesDb();
    let profile: LlmProfileRow | null = null;
    try {
      profile = getProfileById(db, profileId);
    } finally {
      db.close();
    }
    const systemPrompt = await buildProfileChatSystemPrompt({
      genre,
      platform,
      provider: profile?.provider,
      model: profile?.model,
    });
    const normalizedMessages = [
      { role: "system" as const, content: systemPrompt },
      ...messages.filter((item) => item.role !== "system"),
    ];

    if (!profile) {
      throw new Error(`LLM profile not found: ${profileId}`);
    }
    logInfo("llm_profiles.chat.start", {
      profileId,
      messageCount: normalizedMessages.length,
      genre,
      platform,
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.base_url,
      apiKeyConfigured: Boolean(profile.api_key),
    });
    const client = createLLMClient({
      provider: profile.provider,
      baseUrl: profile.base_url,
      apiKey: profile.api_key,
      model: profile.model,
      temperature: profile.temperature ?? 0.7,
      maxTokens: profile.max_tokens ?? 16000,
      thinkingBudget: profile.thinking_budget ?? 0,
      apiFormat: profile.api_format ?? "chat",
    });
    const result = await runProfileChatWithTools(profileId, client, profile.model, normalizedMessages);
    logInfo("llm_profiles.chat.done", {
      profileId,
      provider: profile.provider,
      model: profile.model,
      toolCalls: result.toolTrace.length,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    logError("llm_profiles.chat.error", { profileId: req.params.id, error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.delete("/api/llm-profiles/:id", async (req, res) => {
  try {
    const profileId = req.params.id;
    const db = openProfilesDb();
    try {
      const existing = getProfileById(db, profileId);
      if (!existing) {
        throw new Error(`LLM profile not found: ${profileId}`);
      }
      if (existing.is_active === 1) {
        throw new Error("Active profile cannot be deleted. Please activate another profile first.");
      }
      db.prepare("DELETE FROM llm_profiles WHERE id = ?").run(profileId);
    } finally {
      db.close();
    }
    logInfo("llm_profiles.delete.done", { profileId });
    res.json({ ok: true, profileId });
  } catch (error) {
    logError("llm_profiles.delete.error", { profileId: req.params.id, error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.post("/api/project/init", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    provider: z.enum(["openai", "anthropic"]).default("openai"),
    baseUrl: z.string().url().default("https://api.openai.com/v1"),
    apiKey: z.string().min(1).optional(),
    model: z.string().min(1).default("gpt-4o"),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).optional(),
    thinkingBudget: z.number().int().min(0).optional(),
    apiFormat: z.enum(["chat", "responses"]).optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    logInfo("project.init.start", {
      name: input.name ?? basename(projectRoot),
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
    });
    const existingGlobal = await readGlobalLlmEnv();
    const finalApiKey = input.apiKey ?? existingGlobal.apiKey;
    if (!finalApiKey) {
      throw new Error("API Key is required for first-time setup.");
    }
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(projectRoot, "books"), { recursive: true });
    await mkdir(join(projectRoot, "radar"), { recursive: true });
    await mkdir(inkosHomeDir(), { recursive: true });

    const config = {
      name: input.name ?? basename(projectRoot),
      version: "0.1.0",
      llm: {
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
      },
      notify: [],
      daemon: {
        schedule: {
          radarCron: "0 */6 * * *",
          writeCron: "*/15 * * * *",
        },
        maxConcurrentBooks: 3,
      },
    };

    await writeFile(join(projectRoot, "inkos.json"), JSON.stringify(config, null, 2), "utf-8");
    await writeFile(
      join(projectRoot, ".env"),
      [
        "# Project-level overrides are optional. Shared LLM config lives in ~/.inkos/.env",
        "# Uncomment below to override only this project:",
        "# INKOS_LLM_PROVIDER=openai",
        "# INKOS_LLM_BASE_URL=https://api.openai.com/v1",
        "# INKOS_LLM_API_KEY=your-api-key-here",
        "# INKOS_LLM_MODEL=gpt-4o",
      ].join("\n"),
      "utf-8",
    );
    await writeGlobalLlmEnv({
      name: input.name ?? basename(projectRoot),
      provider: input.provider,
      baseUrl: input.baseUrl,
      apiKey: finalApiKey,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      thinkingBudget: input.thinkingBudget,
      apiFormat: input.apiFormat,
    });
    await upsertActiveLlmProfileFromInit({
      name: input.name ?? basename(projectRoot),
      provider: input.provider,
      baseUrl: input.baseUrl,
      apiKey: finalApiKey,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      thinkingBudget: input.thinkingBudget,
      apiFormat: input.apiFormat,
    });

    logInfo("project.init.done", {
      name: config.name,
      projectRoot,
      provider: input.provider,
      model: input.model,
    });
    res.json({ ok: true, projectRoot, name: config.name });
  } catch (error) {
    logError("project.init.error", { error: describeError(error) });
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/review/pending", async (req, res) => {
  try {
    const state = new StateManager(projectRoot);
    const requestedBookId = typeof req.query.bookId === "string" ? req.query.bookId : undefined;
    const bookIds = requestedBookId ? [await resolveBookId(projectRoot, requestedBookId)] : await state.listBooks();
    const pending: Array<{
      readonly bookId: string;
      readonly title: string;
      readonly chapter: number;
      readonly chapterTitle: string;
      readonly wordCount: number;
      readonly status: string;
      readonly issues: ReadonlyArray<string>;
    }> = [];

    for (const bookId of bookIds) {
      const book = await state.loadBookConfig(bookId);
      const index = await state.loadChapterIndex(bookId);
      for (const chapter of index.filter((item) => item.status === "ready-for-review" || item.status === "audit-failed")) {
        pending.push({
          bookId,
          title: book.title,
          chapter: chapter.number,
          chapterTitle: chapter.title,
          wordCount: chapter.wordCount,
          status: chapter.status,
          issues: chapter.auditIssues,
        });
      }
    }

    res.json({ pending });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/init-assistant/chat", async (req, res) => {
  const schema = z.object({
    bookId: z.string().optional(),
    title: z.string().min(1).default("未命名作品"),
    genre: z.enum(["xuanhuan", "xianxia", "chuanyue", "urban", "horror", "other"]).default("other"),
    platform: z.enum(["tomato", "feilu", "qidian", "other"]).default("tomato"),
    targetChapters: z.number().int().min(1).default(200),
    chapterWords: z.number().int().min(1000).default(3000),
    context: z.string().optional(),
    currentBrief: z.string().optional(),
    useStream: z.boolean().optional(),
    includeReasoning: z.boolean().optional(),
    profileId: z.string().optional(),
    async: z.boolean().optional(),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1),
    })).min(1),
  });

  try {
    const input = schema.parse(req.body ?? {});
    logInfo("init_assistant.chat.start", {
      bookId: input.bookId ?? null,
      title: input.title,
      genre: input.genre,
      platform: input.platform,
      messageCount: input.messages.length,
      useStream: input.useStream !== false,
      includeReasoning: input.includeReasoning === true,
      profileId: input.profileId ?? null,
      async: input.async === true,
    });
    if (input.async) {
      const job = createJob({
        type: "init-assistant-chat",
        step: `init-assistant:queued`,
        bookId: input.bookId,
      });
      startJob(job, { title: input.title, profileId: input.profileId ?? null });
      void (async () => {
        try {
          updateJobStep(job, "init-assistant:start", { title: input.title, profileId: input.profileId ?? null });
          const result = await runInitAssistant(input);
          job.result = { ok: true, ...result };
          updateJobStep(job, "init-assistant:done", {
            briefLength: result.brief.length,
            profileId: result.profileId ?? input.profileId ?? null,
            model: result.model,
          });
          logInfo("init_assistant.chat.done", {
            bookId: input.bookId ?? null,
            title: input.title,
            genre: input.genre,
            jobId: job.id,
            briefLength: result.brief.length,
            profileId: result.profileId ?? input.profileId ?? null,
            model: result.model,
          });
          finishJob(job, { model: result.model });
        } catch (error) {
          failJob(job, error);
          logError("init_assistant.chat.error", { jobId: job.id, error: describeError(error) });
        }
      })();
      res.json({ ok: true, jobId: job.id, queued: true });
      return;
    }
    const result = await runInitAssistant(input);
    logInfo("init_assistant.chat.done", {
      bookId: input.bookId ?? null,
      title: input.title,
      genre: input.genre,
      briefLength: result.brief.length,
      profileId: result.profileId ?? input.profileId ?? null,
      model: result.model,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    logError("init_assistant.chat.error", { error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.post("/api/books", async (req, res) => {
  const schema = z.object({
    title: z.string().min(1),
    genre: z.enum(["xuanhuan", "xianxia", "chuanyue", "urban", "horror", "other"]).default("chuanyue"),
    platform: z.enum(["tomato", "feilu", "qidian", "other"]).default("tomato"),
    targetChapters: z.number().int().min(1).default(200),
    chapterWords: z.number().int().min(1000).default(3000),
    context: z.string().optional(),
    fastInit: z.boolean().optional(),
    initMode: z.enum(["fast", "full", "smart"]).optional(),
    authorBrief: z.string().optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const book = await createBookConfig(input);
    const initMode = input.initMode ?? (input.fastInit ? "fast" : "full");
    const mergedBrief = mergeAuthorBrief(input.context, input.authorBrief);
    const initContext = composeInitContext(input.context, mergedBrief);
    logInfo("books.create.accepted", {
      bookId: book.id,
      title: book.title,
      genre: input.genre,
      platform: input.platform,
      initMode,
    });

    const job: Job = {
      id: generateJobId(),
      type: "create-book",
      status: "running",
      step: initMode === "fast" ? "快速初始化：准备中" : "初始化：准备中",
      bookId: book.id,
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    startJob(job, { title: book.title, initMode });

    // Return immediately with job ID (async init can take a long time)
    res.json({ ok: true, jobId: job.id, bookId: book.id });

    // Run creation in background
    (async () => {
      try {
        const state = new StateManager(projectRoot);
        updateJobStep(job, "保存：书籍配置");
        await state.saveBookConfig(book.id, book);
        updateJobStep(job, "保存：章节索引");
        await state.saveChapterIndex(book.id, []);

        if (initMode === "fast") {
          updateJobStep(job, "快速初始化：生成骨架文件");
          await initializeBookSkeleton(book.id);
        } else {
          updateJobStep(job, "初始化：加载项目配置");
          const config = await loadProjectConfig(projectRoot);
          updateJobStep(job, "初始化：运行管线");
          const pipeline = createPipeline(projectRoot, config, initContext);
          await pipeline.initBook(book);
        }

        if (mergedBrief?.trim()) {
          updateJobStep(job, "保存：作者创作简报");
          await writeAuthorBrief(book.id, mergedBrief);
        }

        job.result = {
          ok: true,
          bookId: book.id,
          title: book.title,
          location: `books/${book.id}`,
          mode: initMode,
        };
        finishJob(job, { title: book.title, mode: initMode });
      } catch (error) {
        failJob(job, error);
      }
    })();
  } catch (error) {
    logError("books.create.error", { error: describeError(error) });
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/books/:bookId/init-brief", async (req, res) => {
  try {
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const content = await readAuthorBrief(bookId);
    res.json({ ok: true, bookId, content });
  } catch (error) {
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.put("/api/books/:bookId/init-brief", async (req, res) => {
  const schema = z.object({
    content: z.string().default(""),
  });

  try {
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    const input = schema.parse(req.body ?? {});
    logInfo("books.init_brief.save.start", { bookId, contentLength: input.content.length });
    await writeAuthorBrief(bookId, input.content);
    logInfo("books.init_brief.save.done", { bookId, contentLength: input.content.length });
    res.json({ ok: true, bookId, content: input.content });
  } catch (error) {
    logError("books.init_brief.save.error", { bookId: req.params.bookId, error: describeError(error) });
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.delete("/api/books/:bookId", async (req, res) => {
  try {
    const bookId = await resolveBookId(projectRoot, req.params.bookId);
    logInfo("books.delete.start", { bookId });
    const state = new StateManager(projectRoot);
    await rm(state.bookDir(bookId), { recursive: true, force: true });
    logInfo("books.delete.done", { bookId });
    res.json({ ok: true, bookId });
  } catch (error) {
    logError("books.delete.error", { bookId: req.params.bookId, error: describeError(error) });
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/writing/next", async (req, res) => {
  const schema = z.object({
    bookId: z.string().optional(),
    count: z.number().int().min(1).max(10).default(1),
    words: z.number().int().min(1000).optional(),
    context: z.string().optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const config = await loadProjectConfig(projectRoot);
    const bookId = await resolveBookId(projectRoot, input.bookId);
    logInfo("writing.next.accepted", {
      bookId,
      count: input.count,
      words: input.words ?? null,
      hasContext: Boolean(input.context),
    });

    const job: Job = {
      id: generateJobId(),
      type: "write-next",
      status: "running",
      step: "开始",
      bookId,
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    startJob(job, {
      count: input.count,
      words: input.words ?? null,
      hasContext: Boolean(input.context),
    });

    // Return immediately with job ID
    res.json({ ok: true, jobId: job.id, bookId });

    // Run pipeline in background
    const pipeline = createPipeline(projectRoot, config, input.context, (event, meta) => {
      logInfo(event, { bookId, jobId: job.id, ...(meta ?? {}) });
    });
    const results: unknown[] = [];
    (async () => {
      try {
        for (let i = 0; i < input.count; i++) {
          updateJobStep(job, input.count > 1
            ? `章节 ${i + 1}/${input.count}：开始`
            : "开始", { chapterIndex: i + 1, total: input.count });
          const onProgress = (step: string) => {
            updateJobStep(job, input.count > 1
              ? `章节 ${i + 1}/${input.count}：${step}`
              : step, { chapterIndex: i + 1, total: input.count });
          };
          results.push(await pipeline.writeNextChapter(bookId, input.words, undefined, onProgress));
        }
        job.result = { ok: true, bookId, results };
        finishJob(job, { resultCount: results.length });
      } catch (error) {
        failJob(job, error);
      }
    })();
  } catch (error) {
    logError("writing.next.error", { error: describeError(error) });
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ ok: false, error: "任务不存在" });
    return;
  }
  res.json({
    ok: true,
    id: job.id,
    type: job.type,
    status: job.status,
    step: job.step,
    bookId: job.bookId,
    result: job.result,
    error: job.error,
    elapsed: Date.now() - job.createdAt,
  });
});

app.post("/api/audit", async (req, res) => {
  const schema = z.object({
    bookId: z.string().optional(),
    chapter: z.number().int().min(1).optional(),
    async: z.boolean().optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const config = await loadProjectConfig(projectRoot);
    const bookId = await resolveBookId(projectRoot, input.bookId);
    if (input.async) {
      const job = createJob({
        type: "audit",
        step: `ch${input.chapter ?? "latest"}:audit:queued`,
        bookId,
      });
      startJob(job, { chapter: input.chapter ?? null });
      void (async () => {
        try {
          updateJobStep(job, `ch${input.chapter ?? "latest"}:audit:start`, { chapter: input.chapter ?? null });
          logInfo("audit.start", { bookId, chapter: input.chapter ?? null, jobId: job.id });
          const pipeline = createPipeline(projectRoot, config, undefined, (event, meta) => {
            logInfo(event, { bookId, chapter: input.chapter ?? null, jobId: job.id, ...(meta ?? {}) });
          });
          const result = await pipeline.auditDraft(bookId, input.chapter);
          job.result = { ok: true, bookId, result };
          updateJobStep(job, `ch${result.chapterNumber}:audit:done`, { chapter: result.chapterNumber, passed: result.passed });
          logInfo("audit.done", { bookId, chapter: input.chapter ?? result.chapterNumber, passed: result.passed, jobId: job.id });
          finishJob(job, { chapter: result.chapterNumber });
        } catch (error) {
          failJob(job, error);
          logError("audit.error", { bookId, chapter: input.chapter ?? null, jobId: job.id, error: describeError(error) });
        }
      })();
      res.json({ ok: true, jobId: job.id, queued: true });
      return;
    }
    logInfo("audit.start", { bookId, chapter: input.chapter ?? null });
    const pipeline = createPipeline(projectRoot, config, undefined, (event, meta) => {
      logInfo(event, { bookId, chapter: input.chapter ?? null, ...(meta ?? {}) });
    });
    const result = await pipeline.auditDraft(bookId, input.chapter);
    logInfo("audit.done", { bookId, chapter: input.chapter ?? result.chapterNumber, passed: result.passed });
    res.json({ ok: true, bookId, result });
  } catch (error) {
    logError("audit.error", { bookId: req.body?.bookId ?? null, chapter: req.body?.chapter ?? null, error: describeError(error) });
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/revise", async (req, res) => {
  const schema = z.object({
    bookId: z.string().optional(),
    chapter: z.number().int().min(1).optional(),
    mode: z.enum(["polish", "rewrite", "rework", "spot-fix"]).default("rewrite"),
    instruction: z.string().optional(),
    async: z.boolean().optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const config = await loadProjectConfig(projectRoot);
    const bookId = await resolveBookId(projectRoot, input.bookId);
    if (input.async) {
      const job = createJob({
        type: "revise",
        step: `ch${input.chapter ?? "latest"}:revise:queued`,
        bookId,
      });
      startJob(job, { chapter: input.chapter ?? null, mode: input.mode });
      void (async () => {
        try {
          updateJobStep(job, `ch${input.chapter ?? "latest"}:revise:start`, { chapter: input.chapter ?? null, mode: input.mode });
          logInfo("revise.start", {
            bookId,
            chapter: input.chapter ?? null,
            mode: input.mode,
            jobId: job.id,
            hasInstruction: Boolean(input.instruction?.trim()),
            instructionPreview: input.instruction?.slice(0, 1000) ?? null,
          });
          const pipeline = createPipeline(projectRoot, config, undefined, (event, meta) => {
            logInfo(event, { bookId, chapter: input.chapter ?? null, mode: input.mode, jobId: job.id, ...(meta ?? {}) });
          });
          const result = await pipeline.reviseDraft(bookId, input.chapter, input.mode, input.instruction);
          job.result = { ok: true, bookId, result };
          updateJobStep(job, `ch${result.chapterNumber}:revise:done`, { chapter: result.chapterNumber, mode: input.mode });
          logInfo("revise.done", { bookId, chapter: result.chapterNumber, mode: input.mode, jobId: job.id });
          finishJob(job, { chapter: result.chapterNumber });
        } catch (error) {
          failJob(job, error);
          logError("revise.error", {
            bookId,
            chapter: input.chapter ?? null,
            mode: input.mode,
            jobId: job.id,
            hasInstruction: Boolean(input.instruction),
            error: describeError(error),
          });
        }
      })();
      res.json({ ok: true, jobId: job.id, queued: true });
      return;
    }
    logInfo("revise.start", {
      bookId,
      chapter: input.chapter ?? null,
      mode: input.mode,
      hasInstruction: Boolean(input.instruction?.trim()),
      instructionPreview: input.instruction?.slice(0, 1000) ?? null,
    });
    const pipeline = createPipeline(projectRoot, config, undefined, (event, meta) => {
      logInfo(event, { bookId, chapter: input.chapter ?? null, mode: input.mode, ...(meta ?? {}) });
    });
    const result = await pipeline.reviseDraft(bookId, input.chapter, input.mode, input.instruction);
    logInfo("revise.done", { bookId, chapter: result.chapterNumber, mode: input.mode });
    res.json({ ok: true, bookId, result });
  } catch (error) {
    logError("revise.error", {
      bookId: req.body?.bookId ?? null,
      chapter: req.body?.chapter ?? null,
      mode: req.body?.mode ?? null,
      hasInstruction: Boolean(req.body?.instruction),
      error: describeError(error),
    });
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/review/approve", async (req, res) => {
  const schema = z.object({
    bookId: z.string().optional(),
    chapter: z.number().int().min(1),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const bookId = await resolveBookId(projectRoot, input.bookId);
    logInfo("review.approve.start", { bookId, chapter: input.chapter });
    const state = new StateManager(projectRoot);
    const index = [...(await state.loadChapterIndex(bookId))];
    const target = index.findIndex((chapter) => chapter.number === input.chapter);
    if (target === -1) {
      throw new Error(`Chapter ${input.chapter} not found in "${bookId}"`);
    }
    index[target] = {
      ...index[target]!,
      status: "approved",
      updatedAt: new Date().toISOString(),
    };
    await state.saveChapterIndex(bookId, index);
    logInfo("review.approve.done", { bookId, chapter: input.chapter });
    res.json({ ok: true, bookId, chapter: input.chapter, status: "approved" });
  } catch (error) {
    logError("review.approve.error", { bookId: req.body?.bookId ?? null, chapter: req.body?.chapter ?? null, error: describeError(error) });
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/review/reject", async (req, res) => {
  const schema = z.object({
    bookId: z.string().optional(),
    chapter: z.number().int().min(1),
    reason: z.string().optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const bookId = await resolveBookId(projectRoot, input.bookId);
    logInfo("review.reject.start", { bookId, chapter: input.chapter });
    const state = new StateManager(projectRoot);
    const index = [...(await state.loadChapterIndex(bookId))];
    const target = index.findIndex((chapter) => chapter.number === input.chapter);
    if (target === -1) {
      throw new Error(`Chapter ${input.chapter} not found in "${bookId}"`);
    }
    index[target] = {
      ...index[target]!,
      status: "rejected",
      reviewNote: input.reason ?? "Rejected without reason",
      updatedAt: new Date().toISOString(),
    };
    await state.saveChapterIndex(bookId, index);
    logInfo("review.reject.done", { bookId, chapter: input.chapter });
    res.json({ ok: true, bookId, chapter: input.chapter, status: "rejected" });
  } catch (error) {
    logError("review.reject.error", { bookId: req.body?.bookId ?? null, chapter: req.body?.chapter ?? null, error: describeError(error) });
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/review/approve-all", async (req, res) => {
  const schema = z.object({
    bookId: z.string().optional(),
  });

  try {
    const input = schema.parse(req.body ?? {});
    const bookId = await resolveBookId(projectRoot, input.bookId);
    logInfo("review.approve_all.start", { bookId });
    const state = new StateManager(projectRoot);
    const index = [...(await state.loadChapterIndex(bookId))];
    let approvedCount = 0;
    const now = new Date().toISOString();
    const updated = index.map((chapter) => {
      if (chapter.status === "ready-for-review" || chapter.status === "audit-failed") {
        approvedCount += 1;
        return { ...chapter, status: "approved" as const, updatedAt: now };
      }
      return chapter;
    });
    await state.saveChapterIndex(bookId, updated);
    logInfo("review.approve_all.done", { bookId, approvedCount });
    res.json({ ok: true, bookId, approvedCount });
  } catch (error) {
    logError("review.approve_all.error", { bookId: req.body?.bookId ?? null, error: describeError(error) });
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/radar/history", async (_req, res) => {
  try {
    const radarDir = join(projectRoot, "radar");
    const entries = await readdir(radarDir, { withFileTypes: true }).catch(() => []);
    const scans = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const fullPath = join(radarDir, entry.name);
        const raw = await readFile(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          timestamp?: string;
          marketSummary?: string;
          recommendations?: Array<unknown>;
        };
        const info = await stat(fullPath);
        return {
          id: entry.name,
          filename: entry.name,
          path: fullPath,
          timestamp: parsed.timestamp ?? info.mtime.toISOString(),
          recommendationCount: Array.isArray(parsed.recommendations) ? parsed.recommendations.length : 0,
          marketSummary: typeof parsed.marketSummary === "string" ? parsed.marketSummary : "",
          size: info.size,
        };
      }));
    scans.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    res.json({ ok: true, scans });
  } catch (error) {
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.get("/api/radar/history/:id", async (req, res) => {
  try {
    const fileName = basename(req.params.id);
    const filePath = join(projectRoot, "radar", fileName);
    const raw = await readFile(filePath, "utf-8");
    res.json({ ok: true, id: fileName, data: JSON.parse(raw) });
  } catch (error) {
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.delete("/api/radar/history/:id", async (req, res) => {
  try {
    const fileName = basename(req.params.id);
    const filePath = join(projectRoot, "radar", fileName);
    await rm(filePath, { force: true });
    res.json({ ok: true, id: fileName });
  } catch (error) {
    res.status(400).json({ ok: false, error: describeError(error) });
  }
});

app.get("/api/commands", async (_req, res) => {
  res.json({
    commands: commandRegistry,
    daemon: await daemonStatus(),
  });
});

app.post("/api/commands/:id/run", async (req, res) => {
  const paramsSchema = z.object({
    values: z.record(z.string(), z.unknown()).default({}),
    async: z.boolean().optional(),
  });

  try {
    const command = getCommandDefinition(req.params.id);
    if (!command) {
      res.status(404).json({ error: `Unknown command: ${req.params.id}` });
      return;
    }

    const { values, async: runAsync } = paramsSchema.parse(req.body ?? {});
    logInfo("command.run.start", { command: command.id, values: sanitizeForLog(values) });

    if (command.specialHandler === "daemon-up") {
      const status = await daemonStatus();
      if (status.running) {
        logInfo("command.run.skip", { command: command.id, reason: "daemon-already-running", daemon: status });
        res.json({ ok: true, message: "Daemon already running.", daemon: status });
        return;
      }
      await spawnCli(command.buildArgs(values), { detached: true });
      logInfo("command.run.done", { command: command.id, detached: true });
      res.json({ ok: true, message: "Daemon start requested.", daemon: await daemonStatus() });
      return;
    }

    if (command.specialHandler === "daemon-down") {
      await spawnCli(command.buildArgs(values));
      logInfo("command.run.done", { command: command.id });
      res.json({ ok: true, message: "Daemon stop requested.", daemon: await daemonStatus() });
      return;
    }

    const args = command.buildArgs(values);
    if (command.supportsJson) args.push("--json");
    if (runAsync) {
      const asyncBookId = typeof values.bookId === "string" ? values.bookId : undefined;
      const job = createJob({
        type: "command",
        step: `${command.id}:queued`,
        bookId: asyncBookId,
      });
      startJob(job, { command: command.id });
      void (async () => {
        try {
          updateJobStep(job, `${command.id}:start`, { command: command.id });
          const result = await spawnCli(args, { expectJson: command.supportsJson, timeoutMs: webCommandTimeoutMs });
          if (result.code !== 0) {
            const timeoutError = result.code === 124 ? `Command timed out after ${webCommandTimeoutMs}ms.` : undefined;
            throw new Error(
              timeoutError ?? (typeof result.parsed === "object" && result.parsed && "error" in result.parsed
                ? String((result.parsed as { error?: unknown }).error ?? "")
                : result.stderr || result.stdout || `Command failed with code ${result.code}`),
            );
          }
          job.result = {
            ok: true,
            command: command.id,
            args,
            stdout: result.stdout,
            stderr: result.stderr,
            parsed: result.parsed,
          };
          updateJobStep(job, `${command.id}:done`, { command: command.id });
          finishJob(job, { command: command.id });
        } catch (error) {
          failJob(job, error);
          logError("command.run.error", { command: command.id, jobId: job.id, error: describeError(error) });
        }
      })();
      res.json({ ok: true, jobId: job.id, queued: true });
      return;
    }
    const result = await spawnCli(args, { expectJson: command.supportsJson, timeoutMs: webCommandTimeoutMs });

    if (result.code !== 0) {
      const status = result.code === 124 ? 504 : 400;
      const timeoutError =
        result.code === 124 ? `Command timed out after ${webCommandTimeoutMs}ms.` : undefined;

      logError("command.run.error", {
        command: command.id,
        code: result.code,
        status,
        error: timeoutError ?? (typeof result.parsed === "object" && result.parsed && "error" in result.parsed
          ? String((result.parsed as { error?: unknown }).error ?? "")
          : result.stderr),
      });
      res.status(status).json({
        ok: false,
        command: command.id,
        args,
        stdout: result.stdout,
        stderr: result.stderr,
        parsed: result.parsed,
        error: timeoutError,
      });
      return;
    }

    logInfo("command.run.done", { command: command.id, code: result.code });
    res.json({
      ok: true,
      command: command.id,
      args,
      stdout: result.stdout,
      stderr: result.stderr,
      parsed: result.parsed,
      daemon: command.id === "up" || command.id === "down" ? await daemonStatus() : undefined,
    });
  } catch (error) {
    logError("command.run.error", { command: req.params.id, error: describeError(error) });
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(port, () => {
  process.stdout.write(`InkOS service listening on http://0.0.0.0:${port}\n`);
  process.stdout.write(`Project root: ${projectRoot}\n`);
});
