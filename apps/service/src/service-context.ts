import type { Express } from "express";
import type { createChatSessionStore } from "./chat-session-store.js";
import type { createCliService } from "./cli-service.js";
import type { createBookService } from "./book-service.js";
import type { createLlmService } from "./llm-service.js";

export interface ServiceContext {
  readonly projectRoot: string;
  readonly repoRoot: string;
  readonly webCommandTimeoutMs: number;
  readonly chatSessions: ReturnType<typeof createChatSessionStore>;
  readonly cliService: ReturnType<typeof createCliService>;
  readonly bookService: ReturnType<typeof createBookService>;
  readonly llmService: ReturnType<typeof createLlmService>;
}

export type RouteRegistrar = (app: Express, context: ServiceContext) => void;
