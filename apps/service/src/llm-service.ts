import {
  StateManager,
  chatCompletion,
  chatWithTools,
  createLLMClient,
  readGenreProfile,
  type AgentMessage,
  type ChapterMeta,
  type ToolDefinition,
} from "@actalk/inkos-core";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compactConversationMessages } from "./compaction.js";
import type { createBookService } from "./book-service.js";
import { loadProjectConfig, resolveBookId } from "./runtime.js";
import { describeError, logInfo, sanitizeForLog } from "./service-logging.js";

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

export interface InitAssistantMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ChapterAssistantMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmProfileRow {
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

export interface LlmProfilePayload {
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

export function createLlmService(
  projectRoot: string,
  bookService: ReturnType<typeof createBookService>,
) {
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
      readonly onTextDelta?: (delta: string) => void;
      readonly onReasoningDelta?: (delta: string) => void;
      readonly abortSignal?: AbortSignal;
    },
  ): Promise<{
    readonly content: string;
    readonly reasoning?: string;
    readonly toolTrace: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>;
  }> {
    const compacted = compactConversationMessages(messages, { mode: "profile" });
    logInfo("llm_profiles.chat.compaction", {
      profileId,
      model,
      originalEstimate: compacted.stats.originalTokenEstimate,
      compactedEstimate: compacted.stats.compactedTokenEstimate,
      compressionTriggered: compacted.stats.compressionTriggered,
      summaryLength: compacted.stats.summaryLength,
    });

    return runToolEnabledConversation(client, model, compacted.messages, {
      maxTurns: 8,
      useStream: options?.useStream,
      includeReasoning: options?.includeReasoning,
      onTextDelta: options?.onTextDelta,
      onReasoningDelta: options?.onReasoningDelta,
      abortSignal: options?.abortSignal,
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
      readonly onTextDelta?: (delta: string) => void;
      readonly onReasoningDelta?: (delta: string) => void;
      readonly abortSignal?: AbortSignal;
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

    const throwIfAborted = (): void => {
      if (options?.abortSignal?.aborted) {
        const error = new Error("Job cancelled by user");
        (error as { name?: string }).name = "AbortError";
        throw error;
      }
    };

    let lastAssistantMessage = "";
    let lastAssistantReasoning = "";
    const maxTurns = options?.maxTurns ?? 8;
    let reachedMaxTurns = false;
    for (let turn = 0; turn < maxTurns; turn++) {
      throwIfAborted();
      const result = await chatWithTools(client, model, conversation, tools, {
        useStream: options?.useStream,
        includeReasoning: options?.includeReasoning,
        onTextDelta: options?.onTextDelta,
        onReasoningDelta: options?.onReasoningDelta,
        abortSignal: options?.abortSignal,
      });
      throwIfAborted();
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
        throwIfAborted();
        const args = parseToolArguments(toolCall.arguments);
        toolTrace.push({ name: toolCall.name, args });
        options?.logToolCall?.(toolCall.name, args);
        const toolResult = await executeTool(toolCall.name, args);
        throwIfAborted();
        conversation.push({ role: "tool", toolCallId: toolCall.id, content: toolResult });
      }

      if (turn === maxTurns - 1) {
        reachedMaxTurns = true;
      }
    }

    const writeTools = new Set(["write_text_file", "move_path", "delete_path"]);
    const hasWriteToolCall = toolTrace.some((item) => writeTools.has(item.name));
    const claimMarkers = ["修改了", "已改", "写入了", "更新了", "删除了", "添加了", "创建了", "移动了", "重命名", "已写入", "写回", "改好了", "已经修改"];
    const replyClaimsModification = claimMarkers.some((marker) => lastAssistantMessage.includes(marker));

    const warnings: string[] = [];
    if (reachedMaxTurns) {
      warnings.push("⚠️ 本轮对话工具调用轮次已达上限，部分操作可能未完成。如有遗漏，请再发一条消息继续。");
    }
    if (replyClaimsModification && !hasWriteToolCall) {
      warnings.push("⚠️ 注意：本轮回复提到了文件修改，但实际未执行任何文件写入操作。如需真正修改文件，请明确要求我执行写入。");
    }
    if (hasWriteToolCall) {
      const writeOps = toolTrace.filter((item) => writeTools.has(item.name));
      const summary = writeOps.map((op) => `- \`${op.name}\`：${String(op.args.path ?? op.args.from ?? "")}`).join("\n");
      warnings.push(`\n---\n📋 **工具执行记录**\n${summary}`);
    }

    if (warnings.length > 0) {
      lastAssistantMessage = `${lastAssistantMessage}\n\n${warnings.join("\n\n")}`;
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
    const storyDir = bookService.storyDirPath(bookId);
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
        const chapterFile = await bookService.findChapterFile(bookDir, chapterNumber, chapterMeta?.title);
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
          authorBriefPath: bookService.authorBriefPath(bookId),
          currentStatePath: bookService.storyFilePath(bookId, "current_state.md"),
          pendingHooksPath: bookService.storyFilePath(bookId, "pending_hooks.md"),
          chapterSummariesPath: bookService.storyFilePath(bookId, "chapter_summaries.md"),
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

  function extractJsonBlock(text: string): string {
    const candidates: string[] = [];
    const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    for (let match = fencedRegex.exec(text); match !== null; match = fencedRegex.exec(text)) {
      const block = match[1]?.trim();
      if (block) candidates.push(block);
    }

    const balancedObjects: string[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        if (depth === 0) start = i;
        depth += 1;
        continue;
      }
      if (char === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          balancedObjects.push(text.slice(start, i + 1).trim());
          start = -1;
        }
      }
    }
    candidates.push(...balancedObjects);

    const trimmed = text.trim();
    if (trimmed) candidates.push(trimmed);

    const uniqueCandidates = candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);

    for (const candidate of uniqueCandidates) {
      const parsed = safeParseJson(candidate);
      if (parsed && typeof parsed === "object" && ("reply" in parsed || "brief" in parsed)) {
        return candidate;
      }
    }

    for (const candidate of uniqueCandidates) {
      const parsed = safeParseJson(candidate);
      if (parsed && typeof parsed === "object") {
        return candidate;
      }
    }

    return trimmed;
  }

  function extractTaggedBlock(text: string, tag: string): string | undefined {
    const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i"));
    const value = match?.[1]?.trim();
    return value ? value : undefined;
  }

  function tryParseTaggedInitPayload(text: string, currentBrief?: string): { reply: string; brief: string } | undefined {
    const reply = extractTaggedBlock(text, "reply_md");
    const briefMode = extractTaggedBlock(text, "brief_mode")?.toLowerCase();
    const briefMd = extractTaggedBlock(text, "brief_md");
    if (!reply && !briefMode && !briefMd) return undefined;

    const preservedBrief = currentBrief?.trim() || "";
    const nextBrief = briefMode === "replace"
      ? (briefMd?.trim() || preservedBrief)
      : briefMode === "unchanged"
        ? preservedBrief
        : (briefMd?.trim() || preservedBrief);

    return {
      reply: reply || "",
      brief: nextBrief,
    };
  }

  function tryParseInitPayload(text: string): { reply: string; brief: string } | undefined {
    const candidate = extractJsonBlock(text);
    let parsed = safeParseJson(candidate);
    if (typeof parsed === "string") {
      parsed = safeParseJson(parsed);
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    const reply = "reply" in parsed ? String((parsed as { reply?: unknown }).reply ?? "").trim() : "";
    const brief = "brief" in parsed ? String((parsed as { brief?: unknown }).brief ?? "").trim() : "";
    if (!reply && !brief) return undefined;
    return { reply, brief };
  }

  function normalizeInitAssistantReplyMarkdown(text: string): string {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return normalized;

    let next = normalized;
    next = next.replace(/\s+---\s+/g, "\n\n---\n\n");
    next = next.replace(/([^\n])\s+(#{1,6}\s+)/g, "$1\n\n$2");
    next = next.replace(/([：:])\s+-\s+/g, "$1\n- ");
    next = next.replace(/([^\n])\s+(\d+\.\s+)/g, "$1\n$2");
    next = next.replace(/\n{3,}/g, "\n\n");

    return next.trim();
  }

  function parseInitAssistantPayload(raw: string, currentBrief?: string): { reply: string; brief: string } {
    const tagged = tryParseTaggedInitPayload(raw, currentBrief);
    if (tagged) {
      return {
        reply: normalizeInitAssistantReplyMarkdown(tagged.reply || "我已经整理好了当前方向，你可以继续补充人物、冲突或结局。"),
        brief: tagged.brief || currentBrief?.trim() || "",
      };
    }

    const parsed = tryParseInitPayload(raw);
    if (parsed) {
      let reply = parsed.reply;
      let brief = parsed.brief;

      const nested = reply ? tryParseInitPayload(reply) : undefined;
      if (nested) {
        if (nested.reply) reply = nested.reply;
        if (!brief && nested.brief) brief = nested.brief;
      }

      return {
        reply: normalizeInitAssistantReplyMarkdown(reply || "我已经整理好了当前方向，你可以继续补充人物、冲突或结局。"),
        brief: brief || currentBrief?.trim() || "",
      };
    }

    return {
      reply: normalizeInitAssistantReplyMarkdown(raw.trim()),
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
    readonly abortSignal?: AbortSignal;
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
      ? await bookService.buildExistingBookContext(resolvedBookId)
      : null;

    const initPathReference = existingBookContext
      ? [
          "",
          existingBookContext.pathBlock,
          existingBookContext.allPathsBlock,
          "如需读取或写入文件，请使用提供的工具（read_text_file / write_text_file / list_directory），并使用上述真实路径。",
        ].join("\n")
      : "";

    const systemPrompt = [
      "你是 InkOS 的智能初始化助手，负责在作者开书前通过对话梳理小说方案。",
      "你的任务不是直接写小说，而是帮助作者明确：主题、卖点、主线走向、阶段高潮、结局方向、主角人设、平台适配点。",
      "请使用简体中文，语气像资深网文编辑，直接、具体、可执行。",
      "如果信息还不完整，可以继续追问，但一次最多问 3 个关键问题。",
      "你必须显式利用系统给你的平台信息、题材规则和 InkOS 架构上下文，不要把自己当成普通写作助手。",
      "如果我提供了某本已存在书籍的目录、story 文件路径和已有长期记忆，说明这次是在旧书基础上继续补强，你必须优先尊重这些已有资料。",
      "遇到书名还不稳、主线不清、结局含糊、主角动机发虚时，优先追问这些关键点。",
      "每次都必须输出 <reply_md> 区块，里面写给作者看的 Markdown 正文。",
      "只有当本轮形成了新的稳定设定、平台策略或明确结论，才更新创作简报；否则不要重写简报。",
      "输出格式必须严格遵守以下标签协议：",
      "<reply_md>",
      "给作者看的 Markdown 回复",
      "</reply_md>",
      "",
      "<brief_mode>",
      "unchanged 或 replace",
      "</brief_mode>",
      "",
      "只有当 brief_mode=replace 时，才额外输出：",
      "<brief_md>",
      "更新后的完整创作简报 Markdown",
      "</brief_md>",
      "",
      "规则：",
      "1. 不要输出 JSON。",
      "2. 不要用 Markdown 代码块包裹整个回复。",
      "3. 标签名必须完全一致：reply_md、brief_mode、brief_md。",
      "4. reply_md / brief_md 内部都直接写 Markdown 原文，不要把换行写成 \\n，不要再次包装成 JSON 字符串。",
      "5. 如果本轮只是追问、解释、闲聊、格式测试或复述已有结论，brief_mode 应为 unchanged。",
      "6. 如果本轮要更新简报，brief_mode 必须为 replace，且 brief_md 必须是完整新版本，不是增量补丁。",
      "7. 不要输出任何额外解释。",
      "",
      systemContext,
      initPathReference,
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

    const bookDir = resolvedBookId ? join(projectRoot, "books", resolvedBookId) : "";
    const initPathReminder = resolvedBookId
      ? `[路径提醒] bookDir=${bookDir} | storyDir=${bookService.storyDirPath(resolvedBookId)} | authorBrief=${bookService.authorBriefPath(resolvedBookId)}`
      : "";
    const userMessages = input.messages.map((message, idx) => {
      if (message.role === "user" && idx === input.messages.length - 1 && initPathReminder) {
        return { role: message.role, content: `${initPathReminder}\n\n${message.content}` };
      }
      return { role: message.role, content: message.content };
    });

    const messages: Array<{ readonly role: "system" | "user" | "assistant"; readonly content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: metaPrompt },
      ...userMessages,
    ];
    const compacted = compactConversationMessages(messages, { mode: "init" });
    logInfo("init_assistant.chat.compaction", {
      bookId: input.bookId ?? null,
      profileId: llm.profileId ?? null,
      model: llm.model,
      originalEstimate: compacted.stats.originalTokenEstimate,
      compactedEstimate: compacted.stats.compactedTokenEstimate,
      compressionTriggered: compacted.stats.compressionTriggered,
      summaryLength: compacted.stats.summaryLength,
    });

    const response = await runToolEnabledConversation(llm.client, llm.model, compacted.messages, {
      maxTurns: 8,
      useStream: input.useStream,
      includeReasoning: input.includeReasoning,
      abortSignal: input.abortSignal,
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

  function resolveChatExecutionOptions(
    input: {
      readonly useStream?: boolean;
      readonly includeReasoning?: boolean;
      readonly async?: boolean;
    },
  ): { readonly useStream: boolean; readonly includeReasoning: boolean } {
    if (input.async === true) {
      return { useStream: false, includeReasoning: false };
    }
    return {
      useStream: input.useStream !== false,
      includeReasoning: input.includeReasoning === true,
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
    readonly abortSignal?: AbortSignal;
  }): Promise<{ reply: string; reasoning?: string; model: string; profileId?: string }> {
    const config = await loadProjectConfig(projectRoot);
    const state = new StateManager(projectRoot);
    const book = await state.loadBookConfig(input.bookId);
    const chapterMeta = (await state.loadChapterIndex(input.bookId)).find((item) => item.number === input.chapterNumber);
    const chapterFile = await bookService.findChapterFile(state.bookDir(input.bookId), input.chapterNumber, chapterMeta?.title);
    const chapterRaw = await readFile(chapterFile, "utf-8");
    const chapterContent = chapterRaw.split("\n").slice(2).join("\n").trim();
    const authorBrief = await bookService.readAuthorBrief(input.bookId);
    const currentState = await bookService.readStoryFile(input.bookId, "current_state.md");
    const pendingHooks = await bookService.readStoryFile(input.bookId, "pending_hooks.md");
    const chapterSummaries = await bookService.readStoryFile(input.bookId, "chapter_summaries.md");
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

    const pathReference = [
      "## 当前工作路径（每轮对话均有效）",
      `- bookId：${input.bookId}`,
      `- 书籍目录：${bookDir}`,
      `- story 目录：${bookService.storyDirPath(input.bookId)}`,
      `- 当前章节文件：${chapterFile}`,
      `- 作者简报：${bookService.authorBriefPath(input.bookId)}`,
      `- 状态卡：${bookService.storyFilePath(input.bookId, "current_state.md")}`,
      `- 伏笔池：${bookService.storyFilePath(input.bookId, "pending_hooks.md")}`,
      `- 章节摘要：${bookService.storyFilePath(input.bookId, "chapter_summaries.md")}`,
    ].join("\n");

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
      "",
      pathReference,
    ].join("\n");

    const contextPrompt = [
      `书籍：${book.title}（${input.bookId}）`,
      `题材：${book.genre}`,
      `平台：${book.platform}`,
      `章节：第${input.chapterNumber}章 ${chapterMeta?.title ?? ""}`.trim(),
      chapterMeta?.status ? `当前状态：${chapterMeta.status}` : "",
      chapterMeta?.auditIssues?.length ? `审计问题：\n- ${chapterMeta.auditIssues.join("\n- ")}` : "审计问题：（暂无）",
      formatChapterAuditDetails(chapterMeta),
      authorBrief.trim() ? `长期创作约束（${bookService.authorBriefPath(input.bookId)}）：\n${authorBrief.trim()}` : "长期创作约束：（暂无）",
      currentState.trim() ? `当前状态卡（${bookService.storyFilePath(input.bookId, "current_state.md")}）：\n${currentState.trim()}` : "",
      pendingHooks.trim() ? `伏笔池（${bookService.storyFilePath(input.bookId, "pending_hooks.md")}）：\n${pendingHooks.trim().slice(-2500)}` : "",
      chapterSummaries.trim() ? `章节摘要（${bookService.storyFilePath(input.bookId, "chapter_summaries.md")}）：\n${chapterSummaries.trim().slice(-3000)}` : "",
      `已确认真实章节文件：\n- ${pathSnapshot.chapterFiles.join("\n- ")}`,
      `已确认真实 story 文件：\n- ${pathSnapshot.storyFiles.join("\n- ")}`,
      `当前章节正文：\n${chapterContent.slice(0, 12000)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const pathReminder = `[路径提醒] bookDir=${bookDir} | chapterFile=${chapterFile} | storyDir=${bookService.storyDirPath(input.bookId)}`;

    const userMessages = input.messages.map((message, idx) => {
      if (message.role === "user" && idx === input.messages.length - 1) {
        return { role: message.role, content: `${pathReminder}\n\n${message.content}` };
      }
      return { role: message.role, content: message.content };
    });

    const messages: Array<{ readonly role: "system" | "user" | "assistant"; readonly content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: contextPrompt },
      ...userMessages,
    ];
    const compacted = compactConversationMessages(messages, { mode: "chapter" });
    logInfo("chapter.chat.compaction", {
      bookId: input.bookId,
      chapterNumber: input.chapterNumber,
      profileId: input.profileId ?? null,
      model: llm.model,
      originalEstimate: compacted.stats.originalTokenEstimate,
      compactedEstimate: compacted.stats.compactedTokenEstimate,
      compressionTriggered: compacted.stats.compressionTriggered,
      summaryLength: compacted.stats.summaryLength,
    });

    const response = await runToolEnabledConversation(
      llm.client,
      llm.model,
      compacted.messages,
      {
        maxTurns: 8,
        useStream: input.useStream,
        includeReasoning: input.includeReasoning,
        abortSignal: input.abortSignal,
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

  return {
    activateLlmProfile,
    buildProfileChatSystemPrompt,
    getProfileById,
    mapProfileRow,
    openProfilesDb,
    readGlobalLlmEnv,
    resolveChatExecutionOptions,
    runChapterAssistant,
    runInitAssistant,
    runProfileChatWithTools,
    testLlmProfile,
    updateProjectModelOverrides,
    upsertActiveLlmProfileFromInit,
    writeGlobalLlmEnv,
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
