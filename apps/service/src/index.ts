import { StateManager, chatCompletion, createLLMClient, type ChapterMeta, type LLMMessage } from "@actalk/inkos-core";
import cors from "cors";
import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
const webCommandTimeoutMs = 60_000;

const app = express();

// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------
interface Job {
  readonly id: string;
  readonly type: "write-next" | "create-book";
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
app.use(express.json({ limit: "1mb" }));
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
  return ` ${JSON.stringify(meta)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeForLog(value: unknown): unknown {
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
  options?: { readonly expectJson?: boolean; readonly detached?: boolean; readonly timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number | null; parsed?: unknown }> {
  const launch = await cliEntry();
  const startedAt = Date.now();
  logInfo("cli.start", {
    command: launch.command,
    args: [...launch.args, ...args],
    detached: options?.detached ?? false,
    timeoutMs: options?.timeoutMs ?? 0,
  });
  const child = spawn(launch.command, [...launch.args, ...args], {
    cwd: projectRoot,
    env: process.env,
    detached: options?.detached ?? false,
    stdio: options?.detached ? "ignore" : "pipe",
  });

  if (options?.detached) {
    child.unref();
    logInfo("cli.detached", {
      pid: child.pid ?? null,
      command: launch.command,
      args: [...launch.args, ...args],
    });
    return { stdout: "", stderr: "", code: 0 };
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let killedByTimeout = false;
  const timeoutMs = options?.timeoutMs ?? 0;
  const timer = timeoutMs > 0
    ? setTimeout(() => {
        killedByTimeout = true;
        child.kill("SIGTERM");
      }, timeoutMs)
    : null;

  child.stdout?.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  if (timer) clearTimeout(timer);

  const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
  const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
  const finalStderr = killedByTimeout
    ? `${stderr ? `${stderr}\n` : ""}Command timed out after ${timeoutMs}ms and was terminated.`
    : stderr;
  const parsed = options?.expectJson && stdout ? safeParseJson(stdout) : undefined;

  const cliMeta = {
    pid: child.pid ?? null,
    code: killedByTimeout ? 124 : code,
    durationMs: Date.now() - startedAt,
    stdoutBytes: stdout.length,
    stderrBytes: finalStderr.length,
  };
  if (killedByTimeout || code !== 0) {
    logError("cli.finish", cliMeta);
  } else {
    logInfo("cli.finish", cliMeta);
  }

  return { stdout, stderr: finalStderr, code: killedByTimeout ? 124 : code, parsed };
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
    const home = process.env.HOME ?? "/root";
    const raw = await readFile(join(home, ".inkos", ".env"), "utf-8");
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

function inkosHomeDir(): string {
  return join(process.env.HOME ?? "/root", ".inkos");
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
    await writeGlobalLlmEnv({
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.base_url,
      apiKey: profile.api_key,
      model: profile.model,
      temperature: profile.temperature ?? undefined,
      maxTokens: profile.max_tokens ?? undefined,
      thinkingBudget: profile.thinking_budget ?? undefined,
      apiFormat: profile.api_format ?? undefined,
    });
    const activated = getProfileById(db, profileId);
    if (!activated) throw new Error(`LLM profile activation failed: ${profileId}`);
    return mapProfileRow(activated);
  } finally {
    db.close();
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

async function findChapterFile(bookDir: string, chapterNumber: number): Promise<string> {
  const chaptersDir = join(bookDir, "chapters");
  const files = await readdir(chaptersDir);
  const paddedNum = String(chapterNumber).padStart(4, "0");
  const match = files.find((file) => file.startsWith(paddedNum) && file.endsWith(".md"));
  if (!match) {
    throw new Error(`Chapter file not found for chapter ${chapterNumber}`);
  }
  return join(chaptersDir, match);
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

function authorBriefPath(bookId: string): string {
  return join(projectRoot, "books", bookId, "story", "author_brief.md");
}

async function readAuthorBrief(bookId: string): Promise<string> {
  try {
    return await readFile(authorBriefPath(bookId), "utf-8");
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

async function runInitAssistant(input: {
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly targetChapters: number;
  readonly chapterWords: number;
  readonly context?: string;
  readonly currentBrief?: string;
  readonly messages: ReadonlyArray<InitAssistantMessage>;
}): Promise<{ reply: string; brief: string }> {
  const config = await loadProjectConfig(projectRoot);
  const client = createLLMClient(config.llm);

  const systemPrompt = [
    "你是 InkOS 的智能初始化助手，负责在作者开书前通过对话梳理小说方案。",
    "你的任务不是直接写小说，而是帮助作者明确：主题、卖点、主线走向、阶段高潮、结局方向、主角人设、平台适配点。",
    "请使用简体中文，语气像资深网文编辑，直接、具体、可执行。",
    "如果信息还不完整，可以继续追问，但一次最多问 3 个关键问题。",
    "每次都要同步维护一份可直接用于初始化的“创作简报”。",
    "输出必须是 JSON，对象结构如下：",
    "{\"reply\":\"给作者的话\",\"brief\":\"完整创作简报Markdown\"}",
    "不要输出 Markdown 代码块，不要输出额外解释。",
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
    "",
    "创作简报建议至少包含这些部分：",
    "## 核心概念",
    "## 题材卖点与平台方向",
    "## 主线走向",
    "## 结局方向",
    "## 主角与关键角色",
    "## 世界观/舞台",
    "## 节奏与卷纲倾向",
    "## 明确禁忌与边界",
  ].join("\n");

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: metaPrompt },
    ...input.messages.map((message) => ({ role: message.role, content: message.content })),
  ];

  const response = await chatCompletion(client, config.llm.model, messages, {
    temperature: 0.8,
    maxTokens: 4096,
  });

  return parseInitAssistantPayload(response.content, input.currentBrief);
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
    genre: z.enum(["xuanhuan", "xianxia", "urban", "horror", "other"]).optional(),
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
    const chapterFile = await findChapterFile(bookDir, chapterNumber);
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
    title: z.string().min(1).default("未命名作品"),
    genre: z.enum(["xuanhuan", "xianxia", "urban", "horror", "other"]).default("other"),
    platform: z.enum(["tomato", "feilu", "qidian", "other"]).default("tomato"),
    targetChapters: z.number().int().min(1).default(200),
    chapterWords: z.number().int().min(1000).default(3000),
    context: z.string().optional(),
    currentBrief: z.string().optional(),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1),
    })).min(1),
  });

  try {
    const input = schema.parse(req.body ?? {});
    logInfo("init_assistant.chat.start", {
      title: input.title,
      genre: input.genre,
      platform: input.platform,
      messageCount: input.messages.length,
    });
    const result = await runInitAssistant(input);
    logInfo("init_assistant.chat.done", {
      title: input.title,
      genre: input.genre,
      briefLength: result.brief.length,
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
    genre: z.enum(["xuanhuan", "xianxia", "urban", "horror", "other"]).default("xuanhuan"),
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
    const initContext = composeInitContext(input.context, input.authorBrief);
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

        if (input.authorBrief?.trim()) {
          updateJobStep(job, "保存：作者创作简报");
          await writeAuthorBrief(book.id, input.authorBrief);
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
    const pipeline = createPipeline(projectRoot, config, input.context);
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
  });

  try {
    const input = schema.parse(req.body ?? {});
    const config = await loadProjectConfig(projectRoot);
    const bookId = await resolveBookId(projectRoot, input.bookId);
    logInfo("audit.start", { bookId, chapter: input.chapter ?? null });
    const pipeline = createPipeline(projectRoot, config);
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
  });

  try {
    const input = schema.parse(req.body ?? {});
    const config = await loadProjectConfig(projectRoot);
    const bookId = await resolveBookId(projectRoot, input.bookId);
    logInfo("revise.start", {
      bookId,
      chapter: input.chapter ?? null,
      mode: input.mode,
      hasInstruction: Boolean(input.instruction?.trim()),
    });
    const pipeline = createPipeline(projectRoot, config);
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

app.get("/api/commands", async (_req, res) => {
  res.json({
    commands: commandRegistry,
    daemon: await daemonStatus(),
  });
});

app.post("/api/commands/:id/run", async (req, res) => {
  const paramsSchema = z.object({
    values: z.record(z.string(), z.unknown()).default({}),
  });

  try {
    const command = getCommandDefinition(req.params.id);
    if (!command) {
      res.status(404).json({ error: `Unknown command: ${req.params.id}` });
      return;
    }

    const { values } = paramsSchema.parse(req.body ?? {});
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
