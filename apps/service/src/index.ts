import cors from "cors";
import express from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBookService } from "./book-service.js";
import { createChatSessionStore } from "./chat-session-store.js";
import { createCliService } from "./cli-service.js";
import { registerBookRoutes } from "./books-routes.js";
import { registerCoreRoutes } from "./core-routes.js";
import { initializeJobCleanup } from "./jobs.js";
import { createLlmService } from "./llm-service.js";
import { registerLlmRoutes } from "./llm-routes.js";
import { registerOpsRoutes } from "./ops-routes.js";
import { REQUEST_LOG_SKIP_PREFIXES, logInfo } from "./service-logging.js";
import type { ServiceContext } from "./service-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const projectRoot = resolve(process.env.INKOS_PROJECT_ROOT ?? repoRoot);
const port = parseInt(process.env.PORT ?? "4010", 10);
const webCommandTimeoutMs = parseInt(process.env.INKOS_WEB_COMMAND_TIMEOUT_MS ?? "600000", 10);

const app = express();

initializeJobCleanup();

const bookService = createBookService(projectRoot);
const llmService = createLlmService(projectRoot, bookService);
const cliService = createCliService({
  projectRoot,
  repoRoot,
  readGlobalLlmEnv: llmService.readGlobalLlmEnv,
});

const context: ServiceContext = {
  projectRoot,
  repoRoot,
  webCommandTimeoutMs,
  chatSessions: createChatSessionStore(projectRoot),
  cliService,
  bookService,
  llmService,
};

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  if (REQUEST_LOG_SKIP_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
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

registerCoreRoutes(app, context);
registerBookRoutes(app, context);
registerLlmRoutes(app, context);
registerOpsRoutes(app, context);

app.listen(port, () => {
  process.stdout.write(`InkOS service listening on http://0.0.0.0:${port}\n`);
  process.stdout.write(`Project root: ${projectRoot}\n`);
});
