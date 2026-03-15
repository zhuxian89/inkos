import {
  BookConfigSchema,
  PipelineRunner,
  ProjectConfigSchema,
  StateManager,
  createLLMClient,
  type BookConfig,
  type ProjectConfig,
} from "@actalk/inkos-core";
import { config as loadEnv } from "dotenv";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const GLOBAL_CONFIG_DIR = join(homedir(), ".inkos");
export const GLOBAL_ENV_PATH = join(GLOBAL_CONFIG_DIR, ".env");

export async function loadProjectConfig(projectRoot: string): Promise<ProjectConfig> {
  loadEnv({ path: GLOBAL_ENV_PATH });
  loadEnv({ path: join(projectRoot, ".env"), override: true });

  const configPath = join(projectRoot, "inkos.json");
  const raw = await readFile(configPath, "utf-8");
  const config = JSON.parse(raw) as Record<string, any>;
  const env = process.env;

  if (env.INKOS_LLM_PROVIDER) config.llm.provider = env.INKOS_LLM_PROVIDER;
  if (env.INKOS_LLM_BASE_URL) config.llm.baseUrl = env.INKOS_LLM_BASE_URL;
  if (env.INKOS_LLM_MODEL) config.llm.model = env.INKOS_LLM_MODEL;
  if (env.INKOS_LLM_TEMPERATURE) config.llm.temperature = parseFloat(env.INKOS_LLM_TEMPERATURE);
  if (env.INKOS_LLM_MAX_TOKENS) config.llm.maxTokens = parseInt(env.INKOS_LLM_MAX_TOKENS, 10);
  if (env.INKOS_LLM_THINKING_BUDGET) config.llm.thinkingBudget = parseInt(env.INKOS_LLM_THINKING_BUDGET, 10);
  if (env.INKOS_LLM_API_FORMAT) config.llm.apiFormat = env.INKOS_LLM_API_FORMAT;

  const apiKey = env.INKOS_LLM_API_KEY;
  if (!apiKey) {
    throw new Error("INKOS_LLM_API_KEY not set. Configure ~/.inkos/.env or project .env first.");
  }
  config.llm.apiKey = apiKey;

  return ProjectConfigSchema.parse(config);
}

export function createPipeline(projectRoot: string, config: ProjectConfig, externalContext?: string): PipelineRunner {
  return new PipelineRunner({
    client: createLLMClient(config.llm),
    model: config.llm.model,
    projectRoot,
    notifyChannels: config.notify,
    modelOverrides: config.modelOverrides,
    ...(externalContext ? { externalContext } : {}),
  });
}

export async function resolveBookId(projectRoot: string, bookIdArg?: string): Promise<string> {
  const state = new StateManager(projectRoot);
  const books = await state.listBooks();

  if (bookIdArg) {
    if (!books.includes(bookIdArg)) {
      throw new Error(`Book "${bookIdArg}" not found. Available: ${books.join(", ") || "(none)"}`);
    }
    return bookIdArg;
  }

  if (books.length === 0) {
    throw new Error("No books found. Create one first.");
  }
  if (books.length === 1) {
    return books[0]!;
  }
  throw new Error(`Multiple books found: ${books.join(", ")}. Please specify a book ID.`);
}

export async function createBookConfig(input: {
  readonly title: string;
  readonly genre: BookConfig["genre"];
  readonly platform: BookConfig["platform"];
  readonly targetChapters: number;
  readonly chapterWords: number;
}): Promise<BookConfig> {
  const now = new Date().toISOString();
  return BookConfigSchema.parse({
    id: input.title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 30),
    title: input.title,
    genre: input.genre,
    platform: input.platform,
    status: "outlining",
    targetChapters: input.targetChapters,
    chapterWordCount: input.chapterWords,
    createdAt: now,
    updatedAt: now,
  });
}
