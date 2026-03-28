import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadProjectSummary } from "./project.js";
import type { RouteRegistrar } from "./service-context.js";
import {
  LOG_BUFFER_LIMIT,
  describeError,
  logError,
  logInfo,
  serviceLogs,
} from "./service-logging.js";


export const registerCoreRoutes: RouteRegistrar = (app, context) => {
  const chatSessionScopeSchema = z.enum(["chapter-chat", "book-chat", "profile-chat"]);
  const chatSessionParamsSchema = z.object({
    scope: chatSessionScopeSchema,
    sessionKey: z.string().min(1),
  });
  const chatSessionBodySchema = z.object({
    bookId: z.string().optional(),
    chapterNumber: z.number().int().optional(),
    profileId: z.string().optional(),
    title: z.string().optional(),
    messages: z.array(z.unknown()).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  });
  app.get("/api/health", async (_req, res) => {
    res.json({
      ok: true,
      service: "inkos-service",
      projectRoot: context.projectRoot,
      daemon: await context.cliService.daemonStatus(),
    });
  });

  app.get("/api/logs", async (req, res) => {
    const querySchema = z.object({
      limit: z.coerce.number().int().min(1).max(1000).default(200),
      sinceId: z.coerce.number().int().min(0).default(0),
      level: z.enum(["INFO", "ERROR", ""]).default(""),
      eventIncludes: z.string().default(""),
    });
    const query = querySchema.parse({
      limit: req.query.limit,
      sinceId: req.query.sinceId,
      level: typeof req.query.level === "string" ? req.query.level.toUpperCase() : "",
      eventIncludes: typeof req.query.eventIncludes === "string" ? req.query.eventIncludes.trim().toLowerCase() : "",
    });

    let rows = serviceLogs.slice();
    if (query.sinceId > 0) {
      rows = rows.filter((item) => item.id > query.sinceId);
    }
    if (query.level === "INFO" || query.level === "ERROR") {
      rows = rows.filter((item) => item.level === query.level);
    }
    if (query.eventIncludes) {
      rows = rows.filter((item) => item.event.toLowerCase().includes(query.eventIncludes));
    }
    if (rows.length > query.limit) {
      rows = rows.slice(-query.limit);
    }

    res.json({
      ok: true,
      logs: rows,
      lastId: rows.length > 0 ? rows[rows.length - 1]!.id : query.sinceId,
      buffered: serviceLogs.length,
      bufferLimit: LOG_BUFFER_LIMIT,
    });
  });

  app.get("/api/project/summary", async (_req, res) => {
    res.json(await loadProjectSummary(context.projectRoot));
  });

  app.get("/api/project/config", async (_req, res) => {
    try {
      const raw = await readFile(join(context.projectRoot, "inkos.json"), "utf-8");
      res.json({ ok: true, config: JSON.parse(raw) });
    } catch (error) {
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.get("/api/chat-sessions/:scope/:sessionKey", async (req, res) => {
    try {
      const { scope, sessionKey } = chatSessionParamsSchema.parse(req.params);
      const session = await context.chatSessions.loadChatSession(scope, sessionKey);
      res.json({ ok: true, session: session ?? null });
    } catch (error) {
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.put("/api/chat-sessions/:scope/:sessionKey", async (req, res) => {
    try {
      const { scope, sessionKey } = chatSessionParamsSchema.parse(req.params);
      const body = chatSessionBodySchema.parse(req.body ?? {});
      await context.chatSessions.saveChatSession({
        scope,
        sessionKey,
        bookId: body.bookId,
        chapterNumber: body.chapterNumber,
        profileId: body.profileId,
        title: body.title,
        messages: body.messages ?? [],
        meta: body.meta ?? {},
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.delete("/api/chat-sessions/:scope/:sessionKey", async (req, res) => {
    try {
      const { scope, sessionKey } = chatSessionParamsSchema.parse(req.params);
      await context.chatSessions.deleteChatSession(scope, sessionKey);
      res.json({ ok: true });
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
      const config = await context.llmService.updateProjectModelOverrides({
        dialogue: input.modelOverrides?.dialogue,
      });
      logInfo("project.config.update.done", { hasDialogueOverride: Boolean((config.modelOverrides as Record<string, unknown> | undefined)?.dialogue) });
      res.json({ ok: true, config });
    } catch (error) {
      logError("project.config.update.error", { error: describeError(error) });
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });
};
