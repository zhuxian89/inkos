import {
  StateManager,
  chatCompletion,
  chatWithTools,
  createLLMClient,
  readGenreProfile,
  type AgentMessage,
  type ChapterMeta,
  type ReasoningEffort,
  type ToolDefinition,
} from "@actalk/inkos-core";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildChapterContextPrompt,
  buildHonestChapterFallback,
  describeChapterPrestuff,
  finalizeAssistantReply,
  maybeCompressConversation,
  parseToolResultError,
  parseToolResultOk,
  resolveContextPolicy,
  type ChatContextMode,
  type ContextPolicy,
  type PrestuffBlockId,
  type ToolTraceItem,
} from "./context/index.js";
import type { createBookService } from "./book-service.js";
import { loadProjectConfig, resolveBookId } from "./runtime.js";
import { describeError, logInfo, sanitizeForLog } from "./service-logging.js";

function policyIncludes(policy: ContextPolicy, blockId: PrestuffBlockId): boolean {
  const rule = policy.prestuff.find((item) => item.blockId === blockId);
  return Boolean(rule?.defaultInclude && rule.maxChars > 0);
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
  readonly reasoning_effort: ReasoningEffort | null;
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
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly apiFormat?: "chat" | "responses";
}

export interface LlmProfileConnectionInput {
  readonly provider: "openai";
  readonly baseUrl: string;
  readonly apiKey: string;
}

export interface LlmProfileCapabilityTestResult {
  readonly provider: "openai" | "anthropic";
  readonly baseUrl: string;
  readonly model: string;
  readonly available: boolean;
  readonly checks: {
    readonly text: {
      readonly ok: boolean;
      readonly responsePreview?: string;
      readonly error?: string;
    };
    readonly tools: {
      readonly ok: boolean;
      readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly arguments: string }>;
      readonly responsePreview?: string;
      readonly error?: string;
    };
    readonly thinking: {
      readonly ok: boolean;
      readonly accepted?: boolean;
      readonly reasoningReturned?: boolean;
      readonly reasoningPreview?: string;
      readonly responsePreview?: string;
      readonly note?: string;
      readonly error?: string;
    };
  };
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
        reasoning_effort TEXT,
        api_format TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = db.prepare("PRAGMA table_info(llm_profiles)").all() as Array<{ readonly name: string }>;
    if (!columns.some((column) => column.name === "reasoning_effort")) {
      db.exec("ALTER TABLE llm_profiles ADD COLUMN reasoning_effort TEXT");
    }
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
      reasoningEffort: row.reasoning_effort ?? undefined,
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
      reasoningEffort: profile.reasoning_effort ?? undefined,
      apiFormat: profile.api_format ?? undefined,
    };
  }

  function assertOpenAiProfile(profile: LlmProfileRow): void {
    if (profile.provider !== "openai") {
      throw new Error("Only openai-compatible LLM profiles are supported.");
    }
  }

  function redactUrl(value: string): string {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return value;
    }
  }

  function modelsEndpoint(input: LlmProfileConnectionInput): string {
    const trimmed = input.baseUrl.replace(/\/+$/, "");
    return `${trimmed}/models`;
  }

  function modelIdFromUnknown(value: unknown): string | null {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const id = record.id ?? record.name ?? record.model;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  }

  async function listLlmModels(input: LlmProfileConnectionInput): Promise<{
    readonly provider: "openai";
    readonly baseUrl: string;
    readonly models: ReadonlyArray<string>;
    readonly count: number;
  }> {
    const response = await fetch(modelsEndpoint(input), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
      },
    });
    const rawText = await response.text();
    const parsed = safeParseJson(rawText);
    if (!response.ok) {
      const errorMessage = parsed && typeof parsed === "object" && "error" in parsed
        ? JSON.stringify((parsed as { error?: unknown }).error)
        : rawText.slice(0, 500);
      throw new Error(`模型列表读取失败(${response.status}): ${errorMessage}`);
    }

    const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const rawModels = Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : [];
    const models = [...new Set(rawModels.map(modelIdFromUnknown).filter((item): item is string => Boolean(item)))];

    return {
      provider: input.provider,
      baseUrl: redactUrl(input.baseUrl),
      models,
      count: models.length,
    };
  }

  function createClientFromProfilePayload(
    payload: LlmProfilePayload,
    overrides?: Partial<Pick<LlmProfilePayload, "maxTokens" | "thinkingBudget">>,
  ): ReturnType<typeof createLLMClient> {
    return createLLMClient({
      provider: payload.provider,
      baseUrl: payload.baseUrl,
      apiKey: payload.apiKey,
      model: payload.model,
      temperature: payload.temperature ?? 0.7,
      maxTokens: overrides?.maxTokens ?? payload.maxTokens ?? 16000,
      thinkingBudget: overrides?.thinkingBudget ?? payload.thinkingBudget ?? 0,
      ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
      apiFormat: payload.apiFormat ?? "chat",
    });
  }

  const PROFILE_HEALTH_TOOL: ToolDefinition = {
    name: "inkos_health_check",
    description: "Report model tool-call capability for InkOS.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "Use the exact value ok." },
      },
      required: ["status"],
    },
  };

  async function testLlmProfileConfig(payload: LlmProfilePayload): Promise<LlmProfileCapabilityTestResult> {
    const textCheck: LlmProfileCapabilityTestResult["checks"]["text"] = await (async () => {
      try {
        const client = createClientFromProfilePayload(payload, { maxTokens: 128, thinkingBudget: 0 });
        const response = await chatCompletion(client, payload.model, [
          { role: "system", content: "You are a health check assistant. Reply in plain text with a very short confirmation." },
          { role: "user", content: "Reply with exactly: LLM test passed" },
        ], {
          temperature: 0,
          maxTokens: 128,
        });
        return { ok: true, responsePreview: response.content.trim().slice(0, 200) };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    })();

    const toolCheck: LlmProfileCapabilityTestResult["checks"]["tools"] = await (async () => {
      try {
        const client = createClientFromProfilePayload(payload, { maxTokens: 512, thinkingBudget: 0 });
        const response = await chatWithTools(client, payload.model, [
          {
            role: "system",
            content: "You are testing tool-call capability. You must call inkos_health_check with status=ok. Do not answer in natural language.",
          },
          { role: "user", content: "Call the health check tool now." },
        ], [PROFILE_HEALTH_TOOL], {
          temperature: 0,
          maxTokens: 512,
          useStream: true,
          includeReasoning: false,
        });
        const toolCalls = response.toolCalls.map((item) => ({
          name: item.name,
          arguments: item.arguments,
        }));
        return {
          ok: toolCalls.some((item) => item.name === PROFILE_HEALTH_TOOL.name),
          toolCalls,
          responsePreview: response.content.trim().slice(0, 200),
        };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    })();

    const thinkingCheck: LlmProfileCapabilityTestResult["checks"]["thinking"] = await (async () => {
      const thinkingBudget = Math.max(payload.thinkingBudget ?? 0, 1024);
      try {
        const client = createClientFromProfilePayload(payload, {
          maxTokens: Math.max(payload.maxTokens ?? 0, thinkingBudget + 256),
          thinkingBudget,
        });
        const response = await chatWithTools(client, payload.model, [
          {
            role: "system",
            content: "You are testing hidden thinking support. Reply only with THINK TEST PASSED.",
          },
          { role: "user", content: "Answer now." },
        ], [PROFILE_HEALTH_TOOL], {
          temperature: 0,
          maxTokens: Math.max(1536, thinkingBudget + 256),
          useStream: true,
          includeReasoning: true,
        });
        const reasoning = response.reasoning?.trim() ?? "";
        return {
          ok: Boolean(reasoning),
          accepted: true,
          reasoningReturned: Boolean(reasoning),
          ...(reasoning ? { reasoningPreview: reasoning.slice(0, 300) } : {}),
          responsePreview: response.content.trim().slice(0, 200),
          ...(!reasoning ? { note: "请求成功，但没有返回 reasoning/thinking 字段。" } : {}),
        };
      } catch (error) {
        return {
          ok: false,
          accepted: false,
          reasoningReturned: false,
          error: describeError(error),
        };
      }
    })();

    return {
      provider: payload.provider,
      baseUrl: redactUrl(payload.baseUrl),
      model: payload.model,
      available: textCheck.ok,
      checks: {
        text: textCheck,
        tools: toolCheck,
        thinking: thinkingCheck,
      },
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
        ...(payload.reasoningEffort ? [`INKOS_LLM_REASONING_EFFORT=${payload.reasoningEffort}`] : []),
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
      assertOpenAiProfile(profile);

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
    readonly provider: "openai" | "anthropic";
    readonly baseUrl: string;
    readonly model: string;
    readonly available: boolean;
    readonly checks: LlmProfileCapabilityTestResult["checks"];
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
    assertOpenAiProfile(profile);

    const payload = profileRowToPayload(profile);
    const result = await testLlmProfileConfig(payload);

    return {
      profileId,
      provider: result.provider,
      baseUrl: result.baseUrl,
      model: result.model,
      available: result.available,
      checks: result.checks,
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
    assertOpenAiProfile(profile);

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
        ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
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
      "如需处理本地文件：先用 search_text_files 或 list_directory 定位，再用 read_text_file 读取真实文件；需要修改时再用 write_text_file 写回。",
      "如需验证模型执行本地命令的能力，可以调用 run_shell_command 工具；除删除/清理类命令会被拒绝外，它会按真实 shell 执行。",
      "如需验证模型读取 HTTP(S) 页面或 API 的能力，可以调用 curl 工具；它支持本地/内网/公网 URL、鉴权请求头、请求体和常见非删除 HTTP 方法。",
      "当问题与小说生产、题材、平台、写作流程、审计流程、项目文件路径有关时，可以结合这些背景信息提高回答相关性。",
      "最终回复必须使用规范 GitHub-Flavored Markdown；如果展示书籍列表、章节列表、对比数据等表格信息，必须输出带管道和分隔行的标准 Markdown 表格，例如 `| # | 书名 | 状态 | 章节数 |` 和 `|---|---|---|---|`，禁止用空格或制表符伪装表格。",
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
      description: "读取文本文件内容。适合配置、Markdown、日志、源码等文本文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
        },
        required: ["path"],
      },
    },
    {
      name: "search_text_files",
      description: "在本地文本文件中搜索关键词。适合先定位文件，再调用 read_text_file 读取完整内容。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要搜索的关键词" },
          path: { type: "string", description: "搜索目录，默认 INKOS_PROJECT_ROOT，支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头" },
          maxResults: { type: "number", description: "最多返回多少条匹配，默认 20，最大 50" },
        },
        required: ["query"],
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
    {
      name: "curl",
      description: "读取 HTTP(S) URL，类似模型测试用 curl。支持本地/内网/公网 URL、鉴权请求头、请求体和常见非删除 HTTP 方法。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要请求的 http/https URL，可为本地、内网或公网地址" },
          method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS"], description: "请求方法，默认 GET；不支持 DELETE" },
          headers: {
            type: "object",
            description: "可选请求头，支持 Authorization、Cookie、x-api-key 等测试场景常用头。",
            additionalProperties: { type: "string" },
          },
          body: { type: "string", description: "POST/PUT/PATCH 请求体" },
          maxBytes: { type: "number", description: "最多读取多少字节，默认 1000000，最大 5000000" },
          timeoutMs: { type: "number", description: "超时时间，默认 30000，最大 120000" },
        },
        required: ["url"],
      },
    },
    {
      name: "run_shell_command",
      description: "在本机真实 shell 中执行命令，用于模型配置对话测试。除删除/清理类命令会被拒绝外，其它命令按 shell 执行。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
          cwd: { type: "string", description: "工作目录，默认 INKOS_PROJECT_ROOT；支持 INKOS_HOME 或 INKOS_PROJECT_ROOT 开头，也可传绝对路径" },
          timeoutMs: { type: "number", description: "超时时间，默认 120000，最大 600000" },
          maxBytes: { type: "number", description: "最多返回多少输出字节，默认 5000000，最大 20000000" },
          env: {
            type: "object",
            description: "可选环境变量覆盖。",
            additionalProperties: { type: "string" },
          },
        },
        required: ["command"],
      },
    },
  ];

  const PROFILE_TEXT_EXTENSIONS = new Set([
    ".css",
    ".csv",
    ".env",
    ".go",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".log",
    ".md",
    ".mjs",
    ".py",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".vue",
    ".xml",
    ".yaml",
    ".yml",
  ]);

  const PROFILE_SEARCH_SKIP_DIRS = new Set([
    ".git",
    ".next",
    "dist",
    "build",
    "node_modules",
    "target",
  ]);

  function profileToolOk(payload: Record<string, unknown>): string {
    return JSON.stringify({ ok: true, ...payload }, null, 2);
  }

  function profileToolError(name: string, error: unknown): string {
    return JSON.stringify({
      ok: false,
      recoverable: true,
      tool: name,
      error: describeError(error),
    }, null, 2);
  }

  function validateCurlUrl(rawUrl: string): URL {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("curl only supports http/https URLs");
    }
    return url;
  }

  function sanitizeCurlHeaders(input: unknown): Record<string, string> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const denied = new Set([
      "connection",
      "content-length",
      "host",
      "transfer-encoding",
    ]);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const normalized = key.trim().toLowerCase();
      if (!normalized || denied.has(normalized)) {
        throw new Error(`curl header is not allowed: ${key}`);
      }
      if (typeof value !== "string") continue;
      result[key.trim()] = value.slice(0, 500);
    }
    return result;
  }

  function hasCurlHeader(headers: Record<string, string>, name: string): boolean {
    const normalizedName = name.toLowerCase();
    return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName);
  }

  function prepareCurlRequestUrl(inputUrl: URL, headers: Record<string, string>): URL {
    const requestUrl = new URL(inputUrl.toString());
    if ((requestUrl.username || requestUrl.password) && !hasCurlHeader(headers, "authorization")) {
      const username = decodeURIComponent(requestUrl.username);
      const password = decodeURIComponent(requestUrl.password);
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }
    requestUrl.username = "";
    requestUrl.password = "";
    return requestUrl;
  }

  function redactCurlUrl(inputUrl: URL): string {
    const url = new URL(inputUrl.toString());
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  }

  async function readLimitedResponseText(response: Response, maxBytes: number): Promise<{
    readonly body: string;
    readonly truncated: boolean;
  }> {
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      return {
        body: text.slice(0, maxBytes),
        truncated: text.length > maxBytes,
      };
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const remaining = maxBytes - received;
        if (remaining <= 0) {
          truncated = true;
          await reader.cancel();
          break;
        }
        if (value.byteLength > remaining) {
          chunks.push(value.slice(0, remaining));
          received += remaining;
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
        received += value.byteLength;
        if (received >= maxBytes) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const buffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { body: new TextDecoder().decode(buffer), truncated };
  }

  async function fetchSafeCurlResponse(input: {
    readonly url: URL;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly timeoutMs: number;
  }): Promise<{
    readonly response: Response;
    readonly finalUrl: URL;
    readonly redirects: ReadonlyArray<string>;
  }> {
    let currentUrl = input.url;
    const redirects: string[] = [];
    for (let index = 0; index <= 5; index += 1) {
      const requestUrl = prepareCurlRequestUrl(currentUrl, input.headers);
      const response = await fetch(requestUrl, {
        method: input.method,
        headers: input.headers,
        ...(input.body !== undefined && input.method !== "GET" && input.method !== "HEAD" ? { body: input.body } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location) {
          if (index >= 5) {
            await response.body?.cancel();
            throw new Error("curl redirect limit exceeded");
          }
          await response.body?.cancel();
          currentUrl = validateCurlUrl(new URL(location, currentUrl).toString());
          redirects.push(redactCurlUrl(currentUrl));
          continue;
        }
      }
      return { response, finalUrl: currentUrl, redirects };
    }
    throw new Error("curl redirect limit exceeded");
  }

  async function executeSafeCurl(args: Record<string, unknown>): Promise<string> {
    const url = validateCurlUrl(String(args.url ?? ""));
    const method = String(args.method ?? "GET").toUpperCase();
    const allowedMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS"]);
    if (!allowedMethods.has(method)) {
      throw new Error("curl supports GET, HEAD, POST, PUT, PATCH and OPTIONS only");
    }
    const maxBytesRaw = Number(args.maxBytes ?? 1000000);
    const maxBytes = Math.min(Math.max(Number.isFinite(maxBytesRaw) ? Math.trunc(maxBytesRaw) : 1000000, 1), 5000000);
    const timeoutRaw = Number(args.timeoutMs ?? 30000);
    const timeoutMs = Math.min(Math.max(Number.isFinite(timeoutRaw) ? Math.trunc(timeoutRaw) : 30000, 1000), 120000);
    const requestBody = typeof args.body === "string" ? args.body : undefined;
    const { response, finalUrl, redirects } = await fetchSafeCurlResponse({
      url,
      method,
      headers: sanitizeCurlHeaders(args.headers),
      ...(requestBody !== undefined ? { body: requestBody } : {}),
      timeoutMs,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const { body: responseBody, truncated } = method === "HEAD"
      ? { body: "", truncated: false }
      : await readLimitedResponseText(response, maxBytes);
    return profileToolOk({
      url: redactCurlUrl(finalUrl),
      originalUrl: redactCurlUrl(url),
      redirects,
      method,
      status: response.status,
      statusText: response.statusText,
      headers: {
        contentType,
        contentLength: response.headers.get("content-length"),
      },
      truncated,
      body: responseBody,
    });
  }

  function normalizeProfileShellCwd(input: unknown): string {
    const raw = typeof input === "string" && input.trim()
      ? input.trim()
      : projectRoot;
    const inkosHome = resolveInkosHomeDir();
    const expanded = raw
      .replace(/^INKOS_HOME(?=\/|$)/, inkosHome)
      .replace(/^INKOS_PROJECT_ROOT(?=\/|$)/, projectRoot);
    return resolve(expanded);
  }

  function sanitizeShellEnv(input: unknown): Record<string, string> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const name = key.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") continue;
      env[name] = value;
    }
    return env;
  }

  function blockedShellDeleteReason(command: string): string | null {
    const patterns: ReadonlyArray<readonly [RegExp, string]> = [
      [/(^|[\s;&|()])rm(\s|$)/i, "rm"],
      [/(^|[\s;&|()])rmdir(\s|$)/i, "rmdir"],
      [/(^|[\s;&|()])unlink(\s|$)/i, "unlink"],
      [/(^|[\s;&|()])shred(\s|$)/i, "shred"],
      [/(^|[\s;&|()])trash(-put)?(\s|$)/i, "trash"],
      [/(^|[\s;&|()])del(\s|$)/i, "del"],
      [/(^|[\s;&|()])rd(\s|$)/i, "rd"],
      [/(^|[\s;&|()])erase(\s|$)/i, "erase"],
      [/(^|[\s;&|()])find\b[\s\S]*\s-delete(\s|$)/i, "find -delete"],
      [/(^|[\s;&|()])git\s+clean\b/i, "git clean"],
      [/(^|[\s;&|()])git\s+reset\s+--hard\b/i, "git reset --hard"],
      [/\bremove-item\b/i, "Remove-Item"],
      [/\bos\.(remove|unlink|rmdir)\s*\(/i, "Python delete API"],
      [/\bshutil\.rmtree\s*\(/i, "Python rmtree"],
      [/\bfs\.(rm|unlink|rmdir)\s*\(/i, "Node delete API"],
      [/\b(rmSync|unlinkSync|rmdirSync)\s*\(/i, "Node delete API"],
    ];
    for (const [pattern, reason] of patterns) {
      if (pattern.test(command)) return reason;
    }
    return null;
  }

  function appendShellOutput(input: {
    readonly current: string;
    readonly chunk: Buffer;
    readonly maxBytes: number;
    readonly usedBytes: number;
  }): { readonly text: string; readonly usedBytes: number; readonly truncated: boolean } {
    const remaining = input.maxBytes - input.usedBytes;
    if (remaining <= 0) return { text: input.current, usedBytes: input.usedBytes, truncated: true };
    if (input.chunk.byteLength <= remaining) {
      return {
        text: input.current + input.chunk.toString("utf-8"),
        usedBytes: input.usedBytes + input.chunk.byteLength,
        truncated: false,
      };
    }
    return {
      text: input.current + input.chunk.subarray(0, remaining).toString("utf-8"),
      usedBytes: input.maxBytes,
      truncated: true,
    };
  }

  async function executeShellCommand(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? "").trim();
    if (!command) {
      return profileToolError("run_shell_command", new Error("command is required"));
    }
    const blockedReason = blockedShellDeleteReason(command);
    if (blockedReason) {
      return profileToolError("run_shell_command", new Error(`delete-like shell command is disabled: ${blockedReason}`));
    }

    const cwd = normalizeProfileShellCwd(args.cwd);
    const maxBytesRaw = Number(args.maxBytes ?? 5000000);
    const maxBytes = Math.min(Math.max(Number.isFinite(maxBytesRaw) ? Math.trunc(maxBytesRaw) : 5000000, 1), 20000000);
    const timeoutRaw = Number(args.timeoutMs ?? 120000);
    const timeoutMs = Math.min(Math.max(Number.isFinite(timeoutRaw) ? Math.trunc(timeoutRaw) : 120000, 1000), 600000);
    const env = { ...process.env, ...sanitizeShellEnv(args.env) };

    return await new Promise((resolvePromise) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let usedBytes = 0;
      let truncated = false;
      let timedOut = false;

      const settle = (payload: string): void => {
        if (settled) return;
        settled = true;
        resolvePromise(payload);
      };

      const child = spawn(command, {
        cwd,
        env,
        shell: true,
        windowsHide: true,
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled && child.exitCode === null) child.kill("SIGKILL");
        }, 2000).unref();
      }, timeoutMs);
      timeout.unref();

      child.stdout.on("data", (chunk: Buffer) => {
        const appended = appendShellOutput({ current: stdout, chunk, maxBytes, usedBytes });
        stdout = appended.text;
        usedBytes = appended.usedBytes;
        truncated = truncated || appended.truncated;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const appended = appendShellOutput({ current: stderr, chunk, maxBytes, usedBytes });
        stderr = appended.text;
        usedBytes = appended.usedBytes;
        truncated = truncated || appended.truncated;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        settle(profileToolError("run_shell_command", error));
      });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
        settle(profileToolOk({
          command,
          cwd,
          exitCode,
          signal,
          timedOut,
          truncated,
          stdout,
          stderr,
        }));
      });
    });
  }

  function isProfileTextPath(filePath: string): boolean {
    const extension = extname(filePath).toLowerCase();
    return PROFILE_TEXT_EXTENSIONS.has(extension) || basename(filePath) === ".env";
  }

  type ProfileToolStatus = "running" | "in_progress" | "complete" | "success" | "failed" | "error" | "cancelled";

  type ProfileToolContentItem =
    | { readonly type: "text"; readonly text?: string; readonly path?: string; readonly changeKind?: string }
    | { readonly type: "diff"; readonly path?: string; readonly oldText?: string; readonly newText?: string; readonly changeKind?: string };

  type ProfileToolCall = {
    readonly callId: string;
    readonly title?: string;
    readonly status: ProfileToolStatus;
    readonly kind: string;
    readonly content?: ReadonlyArray<ProfileToolContentItem>;
    readonly locations?: ReadonlyArray<{ readonly path: string; readonly line?: number }>;
    readonly meta?: Record<string, unknown>;
    readonly result?: string;
    readonly rawType?: string;
  };

  function profileToolKind(name: string): string {
    if (name === "read_text_file" || name === "list_directory" || name === "list_books" || name === "list_llm_profiles") return "read";
    if (name === "search_text_files") return "search";
    if (name === "curl") return "fetch";
    if (name === "run_shell_command") return "command";
    if (name === "write_text_file" || name === "make_directory") return "edit";
    if (name === "move_path") return "move";
    if (name === "delete_path") return "delete";
    return "other";
  }

  function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  function parseProfileToolPayload(raw?: string): Record<string, unknown> | null {
    if (!raw?.trim().startsWith("{")) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  function toolPrimaryPath(name: string, args: Record<string, unknown>, payload: Record<string, unknown> | null): string | undefined {
    if (name === "move_path") return optionalString(args.from) ?? optionalString(payload?.from);
    return optionalString(args.path) ?? optionalString(payload?.path);
  }

  function buildProfileToolCall(input: {
    readonly id: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly status: ProfileToolStatus;
    readonly result?: string;
    readonly error?: string;
  }): ProfileToolCall {
    const payload = parseProfileToolPayload(input.result);
    const primaryPath = toolPrimaryPath(input.name, input.args, payload);
    const url = optionalString(input.args.url) ?? optionalString(payload?.url);
    const command = optionalString(input.args.command) ?? optionalString(payload?.command);
    const query = optionalString(input.args.query) ?? optionalString(payload?.query);
    const title = primaryPath ?? url ?? command ?? query ?? input.name;
    const locations: Array<{ path: string; line?: number }> = [];
    const content: ProfileToolContentItem[] = [];

    if (input.name === "read_text_file") {
      const text = optionalString(payload?.content);
      if (text !== undefined) {
        content.push({ type: "text", text, ...(primaryPath ? { path: primaryPath } : {}) });
      }
      if (primaryPath) locations.push({ path: primaryPath });
    } else if (input.name === "write_text_file") {
      const text = optionalString(input.args.content);
      if (text !== undefined) {
        content.push({ type: "text", text, ...(primaryPath ? { path: primaryPath } : {}), changeKind: "add" });
      }
      if (primaryPath) locations.push({ path: primaryPath });
    } else if (input.name === "search_text_files") {
      const results = Array.isArray(payload?.results) ? payload.results : [];
      const lines: string[] = [];
      for (const item of results) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const path = optionalString(row.path);
        const line = typeof row.line === "number" ? row.line : undefined;
        const text = optionalString(row.text) ?? "";
        if (path) locations.push({ path, ...(line ? { line } : {}) });
        lines.push(`${path ?? "(unknown)"}${line ? `:${line}` : ""} ${text}`.trim());
      }
      if (lines.length > 0) {
        content.push({ type: "text", text: lines.join("\n") });
      }
    } else if (input.name === "curl" && input.result && input.status !== "running") {
      const body = optionalString(payload?.body) ?? input.result;
      content.push({ type: "text", text: body });
    } else if (input.name === "run_shell_command" && input.result && input.status !== "running") {
      const stdout = optionalString(payload?.stdout);
      const stderr = optionalString(payload?.stderr);
      const exitCode = payload?.exitCode;
      const timedOut = payload?.timedOut === true;
      const parts = [
        command ? `$ ${command}` : undefined,
        typeof exitCode === "number" || exitCode === null ? `exitCode: ${String(exitCode)}` : undefined,
        timedOut ? "timedOut: true" : undefined,
        stdout ? `stdout:\n${stdout}` : undefined,
        stderr ? `stderr:\n${stderr}` : undefined,
      ].filter((item): item is string => Boolean(item));
      content.push({ type: "text", text: parts.length > 0 ? parts.join("\n\n") : input.result });
    } else if (input.result && input.status !== "running") {
      content.push({ type: "text", text: input.result });
      if (primaryPath) locations.push({ path: primaryPath });
    }

    return {
      callId: input.id,
      title,
      status: input.status,
      kind: profileToolKind(input.name),
      ...(content.length > 0 ? { content } : {}),
      ...(locations.length > 0 ? { locations } : {}),
      meta: {
        rawType: "profileToolCall",
        tool: input.name,
        args: input.args,
        ...(input.error ? { error: input.error } : {}),
      },
      ...(input.result ? { result: input.result } : {}),
      rawType: "profileToolCall",
    };
  }

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
        return profileToolOk({ path: dirPath, entries: payload });
      }

      case "read_text_file": {
        const filePath = normalizeProfileToolPath(String(args.path ?? ""));
        if (!isProfileTextPath(filePath)) {
          throw new Error(`Only text-like files are supported: ${filePath}`);
        }
        const content = await readFile(filePath, "utf-8");
        return profileToolOk({ path: filePath, content });
      }

      case "search_text_files": {
        const query = String(args.query ?? "").trim();
        if (!query) {
          throw new Error("query is required");
        }
        const rootPath = normalizeProfileToolPath(String(args.path ?? "INKOS_PROJECT_ROOT"));
        const requestedMax = Number(args.maxResults ?? 20);
        const maxResults = Math.min(Math.max(Number.isFinite(requestedMax) ? Math.trunc(requestedMax) : 20, 1), 50);
        const results: Array<{ readonly path: string; readonly line: number; readonly text: string }> = [];
        let scannedFiles = 0;
        let skippedFiles = 0;
        let truncated = false;

        async function walk(dirPath: string): Promise<void> {
          if (results.length >= maxResults || scannedFiles >= 1000) {
            truncated = true;
            return;
          }
          const entries = await readdir(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= maxResults || scannedFiles >= 1000) {
              truncated = true;
              return;
            }
            if (entry.name.startsWith(".") && entry.name !== ".env") continue;
            const fullPath = join(dirPath, entry.name);
            if (entry.isDirectory()) {
              if (!PROFILE_SEARCH_SKIP_DIRS.has(entry.name)) {
                await walk(fullPath);
              }
              continue;
            }
            if (!entry.isFile() || !isProfileTextPath(fullPath)) {
              skippedFiles += 1;
              continue;
            }
            const info = await stat(fullPath);
            if (info.size > 1024 * 1024) {
              skippedFiles += 1;
              continue;
            }
            scannedFiles += 1;
            const content = await readFile(fullPath, "utf-8");
            const lines = content.split(/\r?\n/);
            for (let index = 0; index < lines.length; index += 1) {
              const text = lines[index] ?? "";
              if (!text.includes(query)) continue;
              results.push({
                path: fullPath,
                line: index + 1,
                text: text.length > 300 ? `${text.slice(0, 300)}…` : text,
              });
              if (results.length >= maxResults) {
                truncated = true;
                return;
              }
            }
          }
        }

        const rootInfo = await stat(rootPath);
        if (rootInfo.isFile()) {
          if (!isProfileTextPath(rootPath)) {
            throw new Error(`Only text-like files are supported: ${rootPath}`);
          }
          const content = await readFile(rootPath, "utf-8");
          const lines = content.split(/\r?\n/);
          scannedFiles = 1;
          for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
            const text = lines[index] ?? "";
            if (!text.includes(query)) continue;
            results.push({
              path: rootPath,
              line: index + 1,
              text: text.length > 300 ? `${text.slice(0, 300)}…` : text,
            });
          }
        } else if (rootInfo.isDirectory()) {
          await walk(rootPath);
        } else {
          throw new Error(`Path is neither file nor directory: ${rootPath}`);
        }

        return profileToolOk({
          path: rootPath,
          query,
          maxResults,
          results,
          scannedFiles,
          skippedFiles,
          truncated,
        });
      }

      case "write_text_file": {
        const filePath = normalizeProfileToolPath(String(args.path ?? ""));
        const content = String(args.content ?? "");
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, content, "utf-8");
        return profileToolOk({ path: filePath, size: content.length });
      }

      case "make_directory": {
        const dirPath = normalizeProfileToolPath(String(args.path ?? ""));
        await mkdir(dirPath, { recursive: true });
        return profileToolOk({ path: dirPath });
      }

      case "move_path": {
        const fromPath = normalizeProfileToolPath(String(args.from ?? ""));
        const toPath = normalizeProfileToolPath(String(args.to ?? ""));
        await mkdir(dirname(toPath), { recursive: true });
        await rename(fromPath, toPath);
        return profileToolOk({ from: fromPath, to: toPath });
      }

      case "delete_path": {
        return profileToolError(name, new Error("delete_path is disabled in model profile tests."));
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
        return profileToolOk({ books: summaries });
      }

      case "list_llm_profiles": {
        const db = openProfilesDb();
        try {
          const rows = db.prepare("SELECT * FROM llm_profiles WHERE provider = 'openai' ORDER BY is_active DESC, updated_at DESC").all() as unknown as LlmProfileRow[];
          return profileToolOk({ profiles: rows.map((row) => mapProfileRow(row)) });
        } finally {
          db.close();
        }
      }

      case "activate_llm_profile": {
        const profileId = String(args.profileId ?? "");
        const profile = await activateLlmProfile(profileId);
        return profileToolOk({ profile });
      }

      case "curl": {
        return await executeSafeCurl(args);
      }

      case "run_shell_command": {
        return await executeShellCommand(args);
      }

      default:
        return profileToolError(name, new Error(`Unknown tool: ${name}`));
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
      readonly onToolStart?: (toolCall: ProfileToolCall) => void;
      readonly onToolEnd?: (toolCall: ProfileToolCall) => void;
      readonly abortSignal?: AbortSignal;
    },
  ): Promise<{
    readonly content: string;
    readonly reasoning?: string;
    readonly toolTrace: ReadonlyArray<ToolTraceItem>;
  }> {
    return runToolEnabledConversation(client, model, messages, {
      maxTurns: 8,
      useStream: options?.useStream,
      includeReasoning: options?.includeReasoning,
      onTextDelta: options?.onTextDelta,
      onReasoningDelta: options?.onReasoningDelta,
      onToolStart: options?.onToolStart,
      onToolEnd: options?.onToolEnd,
      abortSignal: options?.abortSignal,
      contextMode: "profile",
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
      readonly onToolStart?: (toolCall: ProfileToolCall) => void;
      readonly onToolEnd?: (toolCall: ProfileToolCall) => void;
      readonly abortSignal?: AbortSignal;
      readonly logToolCall?: (name: string, args: Record<string, unknown>) => void;
      readonly tools?: ReadonlyArray<ToolDefinition>;
      readonly executeTool?: (name: string, args: Record<string, unknown>) => Promise<string>;
      readonly contextMode?: ChatContextMode;
    },
  ): Promise<{
    readonly content: string;
    readonly reasoning?: string;
    readonly toolTrace: ReadonlyArray<ToolTraceItem>;
  }> {
    const tools = options?.tools ?? PROFILE_CHAT_TOOLS;
    const executeTool = options?.executeTool ?? executeProfileChatTool;
    const contextMode = options?.contextMode ?? "chapter";
    const policy = resolveContextPolicy(contextMode);
    const toolTrace: ToolTraceItem[] = [];
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
        let args: Record<string, unknown> = {};
        let toolResult = "";
        try {
          args = parseToolArguments(toolCall.arguments);
          options?.onToolStart?.(buildProfileToolCall({
            id: toolCall.id,
            name: toolCall.name,
            args,
            status: "running",
          }));
          options?.logToolCall?.(toolCall.name, args);
          toolResult = await executeTool(toolCall.name, args);
        } catch (error) {
          if (options?.abortSignal?.aborted) throw error;
          if (Object.keys(args).length === 0) {
            options?.onToolStart?.(buildProfileToolCall({
              id: toolCall.id,
              name: toolCall.name,
              args,
              status: "running",
            }));
          }
          toolResult = profileToolError(toolCall.name, error);
        }
        throwIfAborted();
        const ok = parseToolResultOk(toolResult);
        const error = ok ? undefined : parseToolResultError(toolResult);
        options?.onToolEnd?.(buildProfileToolCall({
          id: toolCall.id,
          name: toolCall.name,
          args,
          status: ok ? "complete" : "error",
          result: toolResult,
          ...(error ? { error } : {}),
        }));
        toolTrace.push({ name: toolCall.name, args, ok, ...(error ? { error } : {}) });
        conversation.push({ role: "tool", toolCallId: toolCall.id, content: toolResult });
      }

      if (!policy.loopCompressDisabled) {
        const compressed = await maybeCompressConversation({
          messages: conversation,
          policy,
          summarizeMiddle: async (middlePlaintext) => {
            const response = await chatCompletion(client, model, [
              {
                role: "system",
                content: [
                  "你是对话压缩器。根据中间轮次材料输出结构化中文摘要，保留：已确认设定、关键改动、未决问题、硬约束、关键路径。",
                  "不要续写小说，不要调用工具，不要道歉。",
                ].join(""),
              },
              { role: "user", content: middlePlaintext.slice(0, 20000) },
            ], { maxTokens: 1200, temperature: 0.2, abortSignal: options?.abortSignal });
            return response.content.trim();
          },
        });
        conversation.splice(0, conversation.length, ...compressed.messages);
        if (compressed.stats.triggered !== "none" || compressed.stats.summaryUpdated) {
          logInfo(`${contextMode}.chat.compress`, {
            mode: contextMode,
            ...compressed.stats,
          });
        }
      }

      if (turn === maxTurns - 1) {
        reachedMaxTurns = true;
      }
    }

    lastAssistantMessage = finalizeAssistantReply({
      reply: lastAssistantMessage,
      toolTrace,
      reachedMaxTurns,
    });

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
                   temperature = ?, max_tokens = ?, thinking_budget = ?, reasoning_effort = ?, api_format = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            payload.name,
            payload.provider,
            payload.baseUrl,
            payload.apiKey,
            payload.model,
            payload.temperature ?? 0.7,
            payload.maxTokens ?? 16000,
            payload.thinkingBudget ?? 0,
            payload.reasoningEffort ?? null,
            payload.apiFormat ?? "chat",
            now,
            active.id,
          );
        return;
      }

      db
        .prepare(
          `INSERT INTO llm_profiles
            (id, name, provider, base_url, api_key, model, temperature, max_tokens, thinking_budget, reasoning_effort, api_format, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          randomUUID(),
          payload.name,
          payload.provider,
          payload.baseUrl,
          payload.apiKey,
          payload.model,
          payload.temperature ?? 0.7,
          payload.maxTokens ?? 16000,
          payload.thinkingBudget ?? 0,
          payload.reasoningEffort ?? null,
          payload.apiFormat ?? "chat",
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
    readonly onTextDelta?: (delta: string) => void;
    readonly onReasoningDelta?: (delta: string) => void;
    readonly onToolStart?: (toolCall: ProfileToolCall) => void;
    readonly onToolEnd?: (toolCall: ProfileToolCall) => void;
  }): Promise<{ reply: string; brief: string; reasoning?: string; model: string; profileId?: string; toolTrace: ReadonlyArray<ToolTraceItem> }> {
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

    const response = await runToolEnabledConversation(llm.client, llm.model, messages, {
      maxTurns: 8,
      useStream: input.useStream,
      includeReasoning: input.includeReasoning,
      abortSignal: input.abortSignal,
      onTextDelta: input.onTextDelta,
      onReasoningDelta: input.onReasoningDelta,
      onToolStart: input.onToolStart,
      onToolEnd: input.onToolEnd,
      contextMode: "init",
      logToolCall: (name, args) => {
        logInfo("init_assistant.chat.tool", { tool: name, args: sanitizeForLog(args) as Record<string, unknown> });
      },
    });

    return {
      ...parseInitAssistantPayload(response.content, input.currentBrief),
      reasoning: response.reasoning,
      model: llm.model,
      profileId: llm.profileId,
      toolTrace: response.toolTrace,
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

  function buildChapterChatFallbackReply(toolTrace: ReadonlyArray<ToolTraceItem>): string {
    return buildHonestChapterFallback(toolTrace);
  }

  async function runChapterAssistant(input: {
    readonly bookId: string;
    readonly chapterNumber: number;
    readonly messages: ReadonlyArray<ChapterAssistantMessage>;
    readonly useStream?: boolean;
    readonly includeReasoning?: boolean;
    readonly profileId?: string;
    readonly abortSignal?: AbortSignal;
    readonly onTextDelta?: (delta: string) => void;
    readonly onReasoningDelta?: (delta: string) => void;
    readonly onToolStart?: (toolCall: ProfileToolCall) => void;
    readonly onToolEnd?: (toolCall: ProfileToolCall) => void;
  }): Promise<{ reply: string; reasoning?: string; model: string; profileId?: string; toolTrace: ReadonlyArray<ToolTraceItem> }> {
    const config = await loadProjectConfig(projectRoot);
    const state = new StateManager(projectRoot);
    const book = await state.loadBookConfig(input.bookId);
    const chapterMeta = (await state.loadChapterIndex(input.bookId)).find((item) => item.number === input.chapterNumber);
    const chapterFile = await bookService.findChapterFile(state.bookDir(input.bookId), input.chapterNumber, chapterMeta?.title);
    const bookDir = state.bookDir(input.bookId);
    const pathSnapshot = await hydrateChapterChatPathSnapshot(buildChapterChatPathSnapshot(input.bookId, bookDir));
    const policy = resolveContextPolicy("chapter");
    const authorBrief = await bookService.readAuthorBrief(input.bookId);
    const currentState = policyIncludes(policy, "story_state")
      ? await bookService.readStoryFile(input.bookId, "current_state.md")
      : "";
    let chapterContent = "";
    if (policyIncludes(policy, "chapter_body")) {
      const chapterRaw = await readFile(chapterFile, "utf-8");
      chapterContent = chapterRaw.split("\n").slice(2).join("\n").trim();
    }
    const pendingHooks = policyIncludes(policy, "story_longform")
      ? await bookService.readStoryFile(input.bookId, "pending_hooks.md")
      : "";
    const chapterSummaries = policyIncludes(policy, "story_longform")
      ? await bookService.readStoryFile(input.bookId, "chapter_summaries.md")
      : "";
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
      "## 路径提示",
      "详细路径与文件列表见首包「路径地图」；改文件前用 get_current_chapter_paths / read_text_file。",
      `- bookId：${input.bookId}`,
      `- 当前章节文件：${chapterFile}`,
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
      "首包上下文可能未包含章节正文或长篇 story 文件；修改章节前必须先用 read_text_file 读取真实文件内容，禁止仅凭记忆或空谈声称已改。",
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

    const auditText = [
      chapterMeta?.auditIssues?.length ? `审计问题：\n- ${chapterMeta.auditIssues.join("\n- ")}` : "审计问题：（暂无）",
      formatChapterAuditDetails(chapterMeta),
    ]
      .filter(Boolean)
      .join("\n");
    const contextPrompt = buildChapterContextPrompt(policy, {
      bookId: input.bookId,
      bookTitle: book.title,
      genre: book.genre,
      platform: book.platform,
      chapterNumber: input.chapterNumber,
      chapterTitle: chapterMeta?.title ?? "",
      status: chapterMeta?.status,
      auditText,
      bookDir,
      chaptersDir: pathSnapshot.chaptersDir,
      storyDir: pathSnapshot.storyDir,
      chapterFile,
      authorBriefPath: bookService.authorBriefPath(input.bookId),
      authorBrief,
      currentStatePath: bookService.storyFilePath(input.bookId, "current_state.md"),
      currentState,
      chapterFiles: pathSnapshot.chapterFiles,
      storyFiles: pathSnapshot.storyFiles,
      chapterContent,
      pendingHooksPath: bookService.storyFilePath(input.bookId, "pending_hooks.md"),
      pendingHooks,
      chapterSummariesPath: bookService.storyFilePath(input.bookId, "chapter_summaries.md"),
      chapterSummaries,
    });
    const prestuffDesc = describeChapterPrestuff(policy, {
      authorBriefPresent: Boolean(authorBrief.trim()),
    });
    logInfo("chapter.chat.prestuff", {
      bookId: input.bookId,
      chapterNumber: input.chapterNumber,
      includedBlocks: prestuffDesc.includedBlocks,
      omittedBlocks: prestuffDesc.omittedBlocks,
      contextChars: contextPrompt.length,
    });

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

    const response = await runToolEnabledConversation(
      llm.client,
      llm.model,
      messages,
      {
        maxTurns: 8,
        useStream: input.useStream,
        includeReasoning: input.includeReasoning,
        abortSignal: input.abortSignal,
        onTextDelta: input.onTextDelta,
        onReasoningDelta: input.onReasoningDelta,
        onToolStart: input.onToolStart,
        onToolEnd: input.onToolEnd,
        contextMode: "chapter",
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
      toolTrace: response.toolTrace,
    };
  }

  return {
    activateLlmProfile,
    buildProfileChatSystemPrompt,
    getProfileById,
    listLlmModels,
    mapProfileRow,
    openProfilesDb,
    readGlobalLlmEnv,
    resolveChatExecutionOptions,
    runChapterAssistant,
    runInitAssistant,
    runProfileChatWithTools,
    testLlmProfile,
    testLlmProfileConfig,
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
