import { createLLMClient } from "@actalk/inkos-core";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  createJob,
  ensureJobAbortController,
  failJob,
  finishJob,
  isAbortLikeError,
  requestJobCancellation,
  startJob,
  updateJobStep,
} from "./jobs.js";
import type { LlmProfileRow } from "./llm-service.js";
import { resolveBookId } from "./runtime.js";
import type { RouteRegistrar } from "./service-context.js";
import { describeError, logError, logInfo } from "./service-logging.js";

function extractTaggedMarkdownDraft(raw: string, tag: string): string {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const startIndex = raw.indexOf(startTag);
  if (startIndex < 0) return "";
  const contentStart = startIndex + startTag.length;
  const endIndex = raw.indexOf(endTag, contentStart);
  const content = endIndex >= 0
    ? raw.slice(contentStart, endIndex)
    : raw.slice(contentStart);
  return content.replace(/^\r?\n/, "");
}

export const registerLlmRoutes: RouteRegistrar = (app, context) => {
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
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const chapterNumber = parseInt(req.params.chapter, 10);
      if (!Number.isFinite(chapterNumber) || chapterNumber < 1) {
        throw new Error(`Invalid chapter number: ${req.params.chapter}`);
      }
      const input = schema.parse(req.body ?? {});
      const execution = context.llmService.resolveChatExecutionOptions(input);
      logInfo("chapter.chat.start", {
        bookId,
        chapterNumber,
        messageCount: input.messages.length,
        useStream: execution.useStream,
        includeReasoning: execution.includeReasoning,
        profileId: input.profileId ?? null,
        async: input.async === true,
      });
      if (input.async) {
        const job = createJob({
          type: "chapter-chat",
          step: `ch${chapterNumber}:chat:queued`,
          bookId,
        });
        const abortController = ensureJobAbortController(job);
        startJob(job, { chapter: chapterNumber, profileId: input.profileId ?? null });
        void (async () => {
          try {
            updateJobStep(job, `ch${chapterNumber}:chat:start`, { chapter: chapterNumber, profileId: input.profileId ?? null });
            if (job.status !== "running") return;
            const result = await context.llmService.runChapterAssistant({
              bookId,
              chapterNumber,
              messages: input.messages,
              useStream: execution.useStream,
              includeReasoning: execution.includeReasoning,
              profileId: input.profileId,
              abortSignal: abortController.signal,
            });
            if (job.status !== "running") return;
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
            if (job.status === "cancelled" || isAbortLikeError(error)) {
              requestJobCancellation(job, "用户停止了章节对话");
              return;
            }
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
      const result = await context.llmService.runChapterAssistant({
        bookId,
        chapterNumber,
        messages: input.messages,
        useStream: execution.useStream,
        includeReasoning: execution.includeReasoning,
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

  app.post("/api/books/:bookId/chapters/:chapter/chat-stream", async (req, res) => {
    let streamOpened = false;
    let streamFinished = false;
    const abortController = new AbortController();
    const abortClientStream = (): void => {
      if (!streamFinished && !abortController.signal.aborted) {
        abortController.abort();
      }
    };
    req.on("aborted", abortClientStream);
    res.on("close", abortClientStream);

    const schema = z.object({
      messages: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      })).min(1),
      useStream: z.boolean().optional(),
      includeReasoning: z.boolean().optional(),
      profileId: z.string().optional(),
    });
    const sendEvent = (payload: Record<string, unknown>): void => {
      if (!streamOpened || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const chapterNumber = parseInt(req.params.chapter, 10);
      if (!Number.isFinite(chapterNumber) || chapterNumber < 1) {
        throw new Error(`Invalid chapter number: ${req.params.chapter}`);
      }
      const input = schema.parse(req.body ?? {});

      logInfo("chapter.chat_stream.start", {
        bookId,
        chapterNumber,
        messageCount: input.messages.length,
        profileId: input.profileId ?? null,
      });

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      streamOpened = true;
      sendEvent({ type: "start", ok: true, bookId, chapterNumber });

      const result = await context.llmService.runChapterAssistant({
        bookId,
        chapterNumber,
        messages: input.messages,
        useStream: true,
        includeReasoning: true,
        profileId: input.profileId,
        abortSignal: abortController.signal,
        onTextDelta: (delta) => {
          sendEvent({ type: "message_chunk", data: { content: delta } });
        },
        onReasoningDelta: (delta) => {
          sendEvent({ type: "thought_chunk", data: { content: delta } });
        },
        onToolStart: (toolCall) => {
          sendEvent({ type: "tool_call", data: toolCall });
        },
        onToolEnd: (toolCall) => {
          sendEvent({ type: "tool_call_update", data: toolCall });
        },
      });

      if (abortController.signal.aborted) {
        logInfo("chapter.chat_stream.cancelled", { bookId, chapterNumber });
        return;
      }

      sendEvent({
        type: "final",
        ok: true,
        content: result.reply,
        reasoning: result.reasoning,
        model: result.model,
        profileId: result.profileId ?? input.profileId ?? null,
        toolCalls: result.toolTrace.length,
      });
      sendEvent({ type: "done" });
      streamFinished = true;

      logInfo("chapter.chat_stream.done", {
        bookId,
        chapterNumber,
        profileId: result.profileId ?? input.profileId ?? null,
        model: result.model,
        toolCalls: result.toolTrace.length,
        contentLength: result.reply.length,
      });
    } catch (error) {
      if (abortController.signal.aborted || isAbortLikeError(error)) {
        logInfo("chapter.chat_stream.cancelled", {
          bookId: req.params.bookId,
          chapter: req.params.chapter,
        });
        return;
      }
      const message = describeError(error);
      streamFinished = true;
      if (streamOpened) {
        sendEvent({ type: "error", ok: false, error: message });
        logError("chapter.chat_stream.error", {
          bookId: req.params.bookId,
          chapter: req.params.chapter,
          error: message,
        });
      } else {
        logError("chapter.chat_stream.error", {
          bookId: req.params.bookId,
          chapter: req.params.chapter,
          error: message,
        });
        res.status(400).json({ ok: false, error: message });
        return;
      }
    } finally {
      req.off("aborted", abortClientStream);
      res.off("close", abortClientStream);
      if (streamOpened && !res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  });

  app.get("/api/llm-profiles", async (_req, res) => {
    try {
      const db = context.llmService.openProfilesDb();
      try {
        const rows = db
          .prepare("SELECT * FROM llm_profiles WHERE provider = 'openai' ORDER BY is_active DESC, updated_at DESC, created_at DESC")
          .all() as unknown as LlmProfileRow[];
        const profiles = rows.map((row) => context.llmService.mapProfileRow(row));
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

  async function resolveProfileDraftApiKey(input: {
    readonly profileId?: string;
    readonly apiKey?: string;
  }): Promise<string> {
    if (input.apiKey?.trim()) return input.apiKey.trim();
    if (input.profileId?.trim()) {
      const db = context.llmService.openProfilesDb();
      try {
        const existing = context.llmService.getProfileById(db, input.profileId.trim());
        if (existing?.api_key) return existing.api_key;
      } finally {
        db.close();
      }
    }
    const globalEnv = await context.llmService.readGlobalLlmEnv();
    if (globalEnv.apiKey?.trim()) return globalEnv.apiKey.trim();
    throw new Error("API Key is required for this operation.");
  }

  app.post("/api/llm-profiles/models", async (req, res) => {
    const schema = z.object({
      profileId: z.string().optional(),
      provider: z.literal("openai").default("openai"),
      baseUrl: z.string().url(),
      apiKey: z.string().trim().min(1).optional(),
    });

    try {
      const input = schema.parse(req.body ?? {});
      const apiKey = await resolveProfileDraftApiKey(input);
      logInfo("llm_profiles.models.start", {
        provider: input.provider,
        baseUrl: input.baseUrl,
        profileId: input.profileId ?? null,
        apiKeyConfigured: Boolean(apiKey),
      });
      const result = await context.llmService.listLlmModels({
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey,
      });
      logInfo("llm_profiles.models.done", {
        provider: result.provider,
        baseUrl: result.baseUrl,
        count: result.count,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      logError("llm_profiles.models.error", { error: describeError(error) });
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.post("/api/llm-profiles/test-config", async (req, res) => {
    const schema = z.object({
      profileId: z.string().optional(),
      name: z.string().trim().min(1).optional(),
      provider: z.literal("openai").default("openai"),
      baseUrl: z.string().url(),
      apiKey: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).optional(),
      thinkingBudget: z.number().int().min(0).optional(),
      reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
      apiFormat: z.enum(["chat", "responses"]).optional(),
    });

    try {
      const input = schema.parse(req.body ?? {});
      const apiKey = await resolveProfileDraftApiKey(input);
      logInfo("llm_profiles.test_config.start", {
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
        profileId: input.profileId ?? null,
      });
      const result = await context.llmService.testLlmProfileConfig({
        name: input.name ?? "draft-profile",
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey,
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        thinkingBudget: input.thinkingBudget,
        reasoningEffort: input.reasoningEffort,
        apiFormat: input.apiFormat,
      });
      logInfo("llm_profiles.test_config.done", {
        provider: result.provider,
        model: result.model,
        available: result.available,
        textOk: result.checks.text.ok,
        toolsOk: result.checks.tools.ok,
        thinkingOk: result.checks.thinking.ok,
      });
      res.json({ ok: result.available, ...result });
    } catch (error) {
      logError("llm_profiles.test_config.error", { error: describeError(error) });
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.post("/api/llm-profiles", async (req, res) => {
    const schema = z.object({
      name: z.string().trim().min(1),
      provider: z.literal("openai").default("openai"),
      baseUrl: z.string().url().default("https://api.openai.com/v1"),
      apiKey: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).default("gpt-4o"),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).optional(),
      thinkingBudget: z.number().int().min(0).optional(),
      reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
      apiFormat: z.enum(["chat", "responses"]).optional(),
      activate: z.boolean().default(false),
    });

    try {
      const input = schema.parse(req.body ?? {});
      const existingGlobal = await context.llmService.readGlobalLlmEnv();
      const finalApiKey = input.apiKey ?? existingGlobal.apiKey;
      if (!finalApiKey) {
        throw new Error("API Key is required for creating a profile.");
      }

      const now = Date.now();
      const id = randomUUID();
      const db = context.llmService.openProfilesDb();
      try {
        db
          .prepare(
            `INSERT INTO llm_profiles
              (id, name, provider, base_url, api_key, model, temperature, max_tokens, thinking_budget, reasoning_effort, api_format, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            id,
            input.name,
            input.provider,
            input.baseUrl,
            finalApiKey,
            input.model,
            input.temperature ?? 0.7,
            input.maxTokens ?? 16000,
            input.thinkingBudget ?? 0,
            input.reasoningEffort ?? null,
            input.apiFormat ?? "chat",
            now,
            now,
          );
      } finally {
        db.close();
      }

      const profile = input.activate
        ? await context.llmService.activateLlmProfile(id)
        : (() => {
            const db2 = context.llmService.openProfilesDb();
            try {
              const row = context.llmService.getProfileById(db2, id);
              if (!row) throw new Error(`LLM profile create verification failed: ${id}`);
              return context.llmService.mapProfileRow(row);
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
      provider: z.literal("openai").optional(),
      baseUrl: z.string().url().optional(),
      apiKey: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).optional(),
      thinkingBudget: z.number().int().min(0).optional(),
      reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
      apiFormat: z.enum(["chat", "responses"]).optional(),
      activate: z.boolean().optional(),
    });

    try {
      const input = schema.parse(req.body ?? {});
      const profileId = req.params.id;
      const db = context.llmService.openProfilesDb();
      try {
        const existing = context.llmService.getProfileById(db, profileId);
        if (!existing) {
          throw new Error(`LLM profile not found: ${profileId}`);
        }
        const now = Date.now();
        db
          .prepare(
            `UPDATE llm_profiles
               SET name = ?, provider = ?, base_url = ?, api_key = ?, model = ?,
                   temperature = ?, max_tokens = ?, thinking_budget = ?, reasoning_effort = ?, api_format = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.name ?? existing.name,
            input.provider ?? "openai",
            input.baseUrl ?? existing.base_url,
            input.apiKey ?? existing.api_key,
            input.model ?? existing.model,
            input.temperature ?? existing.temperature ?? 0.7,
            input.maxTokens ?? existing.max_tokens ?? 16000,
            input.thinkingBudget ?? existing.thinking_budget ?? 0,
            input.reasoningEffort !== undefined ? input.reasoningEffort : existing.reasoning_effort ?? null,
            input.apiFormat ?? existing.api_format ?? "chat",
            now,
            profileId,
          );
      } finally {
        db.close();
      }

      const profile = input.activate ? await context.llmService.activateLlmProfile(profileId) : (() => {
        const db2 = context.llmService.openProfilesDb();
        try {
          const updated = context.llmService.getProfileById(db2, profileId);
          if (!updated) throw new Error(`LLM profile update verification failed: ${profileId}`);
          return context.llmService.mapProfileRow(updated);
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
      const { id: profileId } = z.object({ id: z.string().min(1) }).parse(req.params);
      const profile = await context.llmService.activateLlmProfile(profileId);
      logInfo("llm_profiles.activate.done", { profileId });
      res.json({ ok: true, profile, activeProfileId: profileId });
    } catch (error) {
      logError("llm_profiles.activate.error", { profileId: req.params.id, error: describeError(error) });
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.post("/api/llm-profiles/:id/test", async (req, res) => {
    try {
      const { id: profileId } = z.object({ id: z.string().min(1) }).parse(req.params);
      logInfo("llm_profiles.test.start", { profileId });
      const result = await context.llmService.testLlmProfile(profileId);
      logInfo("llm_profiles.test.done", {
        profileId,
        provider: result.provider,
        model: result.model,
        available: result.available,
      });
      res.json({ ok: result.available, ...result });
    } catch (error) {
      logError("llm_profiles.test.error", { profileId: req.params.id, error: describeError(error) });
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.post("/api/llm-profiles/:id/chat", async (req, res) => {
    const paramsSchema = z.object({
      id: z.string().min(1),
    });
    const bodySchema = z.object({
      messages: z.array(z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1),
      })).min(1),
      genre: z.string().optional(),
      platform: z.string().optional(),
      useStream: z.boolean().optional(),
      includeReasoning: z.boolean().optional(),
    });

    try {
      const { id: profileId } = paramsSchema.parse(req.params);
      const input = bodySchema.parse(req.body ?? {});
      const messages = input.messages;

      const genre = input.genre;
      const platform = input.platform;
      const useStream = input.useStream !== false;
      const includeReasoning = input.includeReasoning === true;
      const db = context.llmService.openProfilesDb();
      let profile = null;
      try {
        profile = context.llmService.getProfileById(db, profileId);
      } finally {
        db.close();
      }
      const systemPrompt = await context.llmService.buildProfileChatSystemPrompt({
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
      if (profile.provider !== "openai") {
        throw new Error("Only openai-compatible LLM profiles are supported.");
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
        ...(profile.reasoning_effort ? { reasoningEffort: profile.reasoning_effort } : {}),
        apiFormat: profile.api_format ?? "chat",
      });
      const result = await context.llmService.runProfileChatWithTools(profileId, client, profile.model, normalizedMessages, {
        useStream,
        includeReasoning,
      });
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

  app.post("/api/llm-profiles/:id/chat-stream", async (req, res) => {
    let streamOpened = false;
    let streamFinished = false;
    const abortController = new AbortController();
    const abortClientStream = (): void => {
      if (!streamFinished && !abortController.signal.aborted) {
        abortController.abort();
      }
    };
    // `req.close` can fire after the POST body is read; only abort on true request abort or SSE response close.
    req.on("aborted", abortClientStream);
    res.on("close", abortClientStream);
    const paramsSchema = z.object({
      id: z.string().min(1),
    });
    const bodySchema = z.object({
      messages: z.array(z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1),
      })).min(1),
      genre: z.string().optional(),
      platform: z.string().optional(),
      // Accepted for backward compatibility; profile chat-stream always streams with reasoning.
      includeReasoning: z.boolean().optional(),
    });
    const sendEvent = (payload: Record<string, unknown>): void => {
      if (!streamOpened || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const { id: profileId } = paramsSchema.parse(req.params);
      const input = bodySchema.parse(req.body ?? {});
      const messages = input.messages;

      const genre = input.genre;
      const platform = input.platform;
      const db = context.llmService.openProfilesDb();
      let profile = null;
      try {
        profile = context.llmService.getProfileById(db, profileId);
      } finally {
        db.close();
      }

      const systemPrompt = await context.llmService.buildProfileChatSystemPrompt({
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
      if (profile.provider !== "openai") {
        throw new Error("Only openai-compatible LLM profiles are supported.");
      }

      logInfo("llm_profiles.chat_stream.start", {
        profileId,
        messageCount: normalizedMessages.length,
        genre,
        platform,
        provider: profile.provider,
        model: profile.model,
        includeReasoning: true,
      });

      const client = createLLMClient({
        provider: profile.provider,
        baseUrl: profile.base_url,
        apiKey: profile.api_key,
        model: profile.model,
        temperature: profile.temperature ?? 0.7,
        maxTokens: profile.max_tokens ?? 16000,
        thinkingBudget: profile.thinking_budget ?? 0,
        ...(profile.reasoning_effort ? { reasoningEffort: profile.reasoning_effort } : {}),
        apiFormat: profile.api_format ?? "chat",
      });

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      streamOpened = true;
      sendEvent({ type: "start", ok: true, profileId, model: profile.model });

      const result = await context.llmService.runProfileChatWithTools(profileId, client, profile.model, normalizedMessages, {
        useStream: true,
        includeReasoning: true,
        abortSignal: abortController.signal,
        onTextDelta: (delta) => {
          sendEvent({ type: "message_chunk", data: { content: delta } });
        },
        onReasoningDelta: (delta) => {
          sendEvent({ type: "thought_chunk", data: { content: delta } });
        },
        onToolStart: (toolCall) => {
          sendEvent({
            type: "tool_call",
            data: toolCall,
          });
        },
        onToolEnd: (toolCall) => {
          sendEvent({
            type: "tool_call_update",
            data: toolCall,
          });
        },
      });

      if (abortController.signal.aborted) {
        logInfo("llm_profiles.chat_stream.cancelled", {
          profileId,
          provider: profile.provider,
          model: profile.model,
        });
        return;
      }

      sendEvent({
        type: "final",
        ok: true,
        content: result.content,
        reasoning: result.reasoning,
        toolCalls: result.toolTrace.length,
      });
      sendEvent({ type: "done" });
      streamFinished = true;

      logInfo("llm_profiles.chat_stream.done", {
        profileId,
        provider: profile.provider,
        model: profile.model,
        toolCalls: result.toolTrace.length,
        contentLength: result.content.length,
      });
    } catch (error) {
      if (abortController.signal.aborted || isAbortLikeError(error)) {
        logInfo("llm_profiles.chat_stream.cancelled", { profileId: req.params.id });
        return;
      }
      const message = describeError(error);
      if (streamOpened) {
        sendEvent({ type: "error", ok: false, error: message });
        streamFinished = true;
        logError("llm_profiles.chat_stream.error", { profileId: req.params.id, error: message });
      } else {
        streamFinished = true;
        logError("llm_profiles.chat_stream.error", { profileId: req.params.id, error: message });
        res.status(400).json({ ok: false, error: message });
        return;
      }
    } finally {
      req.off("aborted", abortClientStream);
      res.off("close", abortClientStream);
      if (streamOpened && !res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  });

  app.delete("/api/llm-profiles/:id", async (req, res) => {
    try {
      const { id: profileId } = z.object({ id: z.string().min(1) }).parse(req.params);
      const db = context.llmService.openProfilesDb();
      try {
        const existing = context.llmService.getProfileById(db, profileId);
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
      provider: z.literal("openai").default("openai"),
      baseUrl: z.string().url().default("https://api.openai.com/v1"),
      apiKey: z.string().min(1).optional(),
      model: z.string().min(1).default("gpt-4o"),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).optional(),
      thinkingBudget: z.number().int().min(0).optional(),
      reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
      apiFormat: z.enum(["chat", "responses"]).optional(),
    });

    try {
      const input = schema.parse(req.body ?? {});
      logInfo("project.init.start", {
        name: input.name ?? basename(context.projectRoot),
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl,
      });
      const existingGlobal = await context.llmService.readGlobalLlmEnv();
      const finalApiKey = input.apiKey ?? existingGlobal.apiKey;
      if (!finalApiKey) {
        throw new Error("API Key is required for first-time setup.");
      }
      await mkdir(context.projectRoot, { recursive: true });
      await mkdir(join(context.projectRoot, "books"), { recursive: true });
      await mkdir(join(context.projectRoot, "radar"), { recursive: true });
      await mkdir(join(process.env.INKOS_HOME?.trim() || join(process.env.HOME ?? "/root", ".inkos")), { recursive: true });

      const config = {
        name: input.name ?? basename(context.projectRoot),
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

      await writeFile(join(context.projectRoot, "inkos.json"), JSON.stringify(config, null, 2), "utf-8");
      await writeFile(
        join(context.projectRoot, ".env"),
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
      await context.llmService.writeGlobalLlmEnv({
        name: input.name ?? basename(context.projectRoot),
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey: finalApiKey,
        model: input.model,
        temperature: input.temperature ?? 0.7,
        maxTokens: input.maxTokens ?? 16000,
        thinkingBudget: input.thinkingBudget ?? 0,
        reasoningEffort: input.reasoningEffort,
        apiFormat: input.apiFormat ?? "chat",
      });
      await context.llmService.upsertActiveLlmProfileFromInit({
        name: input.name ?? basename(context.projectRoot),
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey: finalApiKey,
        model: input.model,
        temperature: input.temperature ?? 0.7,
        maxTokens: input.maxTokens ?? 16000,
        thinkingBudget: input.thinkingBudget ?? 0,
        reasoningEffort: input.reasoningEffort,
        apiFormat: input.apiFormat ?? "chat",
      });

      logInfo("project.init.done", {
        name: config.name,
        projectRoot: context.projectRoot,
        provider: input.provider,
        model: input.model,
      });
      res.json({ ok: true, projectRoot: context.projectRoot, name: config.name });
    } catch (error) {
      logError("project.init.error", { error: describeError(error) });
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
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
      const execution = context.llmService.resolveChatExecutionOptions(input);
      logInfo("init_assistant.chat.start", {
        bookId: input.bookId ?? null,
        title: input.title,
        genre: input.genre,
        platform: input.platform,
        messageCount: input.messages.length,
        useStream: execution.useStream,
        includeReasoning: execution.includeReasoning,
        profileId: input.profileId ?? null,
        async: input.async === true,
      });
      if (input.async) {
        const job = createJob({
          type: "init-assistant-chat",
          step: "init-assistant:queued",
          bookId: input.bookId,
        });
        const abortController = ensureJobAbortController(job);
        startJob(job, { title: input.title, profileId: input.profileId ?? null });
        void (async () => {
          try {
            updateJobStep(job, "init-assistant:start", { title: input.title, profileId: input.profileId ?? null });
            if (job.status !== "running") return;
            const result = await context.llmService.runInitAssistant({
              ...input,
              useStream: execution.useStream,
              includeReasoning: execution.includeReasoning,
              abortSignal: abortController.signal,
            });
            if (job.status !== "running") return;
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
            if (job.status === "cancelled" || isAbortLikeError(error)) {
              requestJobCancellation(job, "用户停止了智能初始化对话");
              return;
            }
            failJob(job, error);
            logError("init_assistant.chat.error", { jobId: job.id, error: describeError(error) });
          }
        })();
        res.json({ ok: true, jobId: job.id, queued: true });
        return;
      }
      const result = await context.llmService.runInitAssistant({
        ...input,
        useStream: execution.useStream,
        includeReasoning: execution.includeReasoning,
      });
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

  app.post("/api/init-assistant/chat-stream", async (req, res) => {
    let streamOpened = false;
    let streamFinished = false;
    let rawAssistantText = "";
    let sentReplyLength = 0;
    const abortController = new AbortController();
    const abortClientStream = (): void => {
      if (!streamFinished && !abortController.signal.aborted) {
        abortController.abort();
      }
    };
    req.on("aborted", abortClientStream);
    res.on("close", abortClientStream);

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
      messages: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      })).min(1),
    });
    const sendEvent = (payload: Record<string, unknown>): void => {
      if (!streamOpened || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const sendVisibleReplyDelta = (delta: string): void => {
      rawAssistantText += delta;
      const visibleReply = extractTaggedMarkdownDraft(rawAssistantText, "reply_md");
      if (visibleReply.length <= sentReplyLength) return;
      const chunk = visibleReply.slice(sentReplyLength);
      sentReplyLength = visibleReply.length;
      sendEvent({ type: "message_chunk", data: { content: chunk } });
    };

    try {
      const input = schema.parse(req.body ?? {});
      logInfo("init_assistant.chat_stream.start", {
        bookId: input.bookId ?? null,
        title: input.title,
        genre: input.genre,
        platform: input.platform,
        messageCount: input.messages.length,
        profileId: input.profileId ?? null,
      });

      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      streamOpened = true;
      sendEvent({ type: "start", ok: true, bookId: input.bookId ?? null });

      const result = await context.llmService.runInitAssistant({
        ...input,
        useStream: true,
        includeReasoning: true,
        abortSignal: abortController.signal,
        onTextDelta: sendVisibleReplyDelta,
        onReasoningDelta: (delta) => {
          sendEvent({ type: "thought_chunk", data: { content: delta } });
        },
        onToolStart: (toolCall) => {
          sendEvent({ type: "tool_call", data: toolCall });
        },
        onToolEnd: (toolCall) => {
          sendEvent({ type: "tool_call_update", data: toolCall });
        },
      });

      if (abortController.signal.aborted) {
        logInfo("init_assistant.chat_stream.cancelled", { bookId: input.bookId ?? null });
        return;
      }

      sendEvent({
        type: "final",
        ok: true,
        content: result.reply,
        brief: result.brief,
        reasoning: result.reasoning,
        model: result.model,
        profileId: result.profileId ?? input.profileId ?? null,
        toolCalls: result.toolTrace.length,
      });
      sendEvent({ type: "done" });
      streamFinished = true;

      logInfo("init_assistant.chat_stream.done", {
        bookId: input.bookId ?? null,
        title: input.title,
        genre: input.genre,
        briefLength: result.brief.length,
        profileId: result.profileId ?? input.profileId ?? null,
        model: result.model,
        toolCalls: result.toolTrace.length,
        contentLength: result.reply.length,
      });
    } catch (error) {
      if (abortController.signal.aborted || isAbortLikeError(error)) {
        logInfo("init_assistant.chat_stream.cancelled", { bookId: req.body?.bookId ?? null });
        return;
      }
      const message = describeError(error);
      streamFinished = true;
      if (streamOpened) {
        sendEvent({ type: "error", ok: false, error: message });
        logError("init_assistant.chat_stream.error", { error: message });
      } else {
        logError("init_assistant.chat_stream.error", { error: message });
        res.status(400).json({ ok: false, error: message });
        return;
      }
    } finally {
      req.off("aborted", abortClientStream);
      res.off("close", abortClientStream);
      if (streamOpened && !res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  });
};
