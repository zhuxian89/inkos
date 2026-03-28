import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { commandRegistry, getCommandDefinition } from "./command-registry.js";
import {
  cancelJob,
  createJob,
  failJob,
  finishJob,
  jobs,
  requestJobCancellation,
  startJob,
  updateJobStep,
} from "./jobs.js";
import { createPipeline, loadProjectConfig, resolveBookId } from "./runtime.js";
import type { RouteRegistrar } from "./service-context.js";
import { describeError, logError, logInfo, sanitizeForLog } from "./service-logging.js";

export const registerOpsRoutes: RouteRegistrar = (app, context) => {
  app.post("/api/writing/next", async (req, res) => {
    const schema = z.object({
      bookId: z.string().optional(),
      count: z.number().int().min(1).max(10).default(1),
      words: z.number().int().min(1000).optional(),
      context: z.string().optional(),
    });

    try {
      const input = schema.parse(req.body ?? {});
      const config = await loadProjectConfig(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, input.bookId);
      logInfo("writing.next.accepted", {
        bookId,
        count: input.count,
        words: input.words ?? null,
        hasContext: Boolean(input.context),
      });

      const job = createJob({
        type: "write-next",
        step: "开始",
        bookId,
      });
      startJob(job, {
        count: input.count,
        words: input.words ?? null,
        hasContext: Boolean(input.context),
      });

      res.json({ ok: true, jobId: job.id, bookId });

      const pipeline = createPipeline(context.projectRoot, config, input.context, (event, meta) => {
        logInfo(event, { bookId, jobId: job.id, ...(meta ?? {}) });
      });
      const results: unknown[] = [];
      void (async () => {
        try {
          for (let i = 0; i < input.count; i++) {
            if (job.status !== "running" || job.cancelRequested) {
              logInfo("writing.next.cancelled", { bookId, jobId: job.id, completedChapters: results.length, totalRequested: input.count });
              job.result = { ok: true, bookId, results, cancelled: true, completedCount: results.length };
              cancelJob(job, "用户取消续写");
              return;
            }
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
          if (results.length > 0) {
            job.result = { ok: false, bookId, results, completedCount: results.length, error: describeError(error) };
          }
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

  app.post("/api/jobs/:jobId/cancel", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ ok: false, error: "任务不存在" });
      return;
    }

    if (job.type !== "chapter-chat" && job.type !== "init-assistant-chat" && job.type !== "write-next") {
      res.status(400).json({
        ok: false,
        error: `当前任务类型不支持取消：${job.type}`,
        id: job.id,
        type: job.type,
        status: job.status,
      });
      return;
    }

    if (job.status !== "running") {
      res.json({
        ok: true,
        id: job.id,
        type: job.type,
        status: job.status,
        step: job.step,
        alreadyFinal: true,
      });
      return;
    }

    const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason.trim()
      : "用户取消";
    requestJobCancellation(job, reason);
    res.json({
      ok: true,
      id: job.id,
      type: job.type,
      status: job.status,
      step: job.step,
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
      const config = await loadProjectConfig(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, input.bookId);
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
            const pipeline = createPipeline(context.projectRoot, config, undefined, (event, meta) => {
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
      const pipeline = createPipeline(context.projectRoot, config, undefined, (event, meta) => {
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
      const config = await loadProjectConfig(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, input.bookId);
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
            const pipeline = createPipeline(context.projectRoot, config, undefined, (event, meta) => {
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
      const pipeline = createPipeline(context.projectRoot, config, undefined, (event, meta) => {
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

  app.get("/api/radar/history", async (_req, res) => {
    try {
      const radarDir = join(context.projectRoot, "radar");
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
      const filePath = join(context.projectRoot, "radar", fileName);
      const raw = await readFile(filePath, "utf-8");
      res.json({ ok: true, id: fileName, data: JSON.parse(raw) });
    } catch (error) {
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.delete("/api/radar/history/:id", async (req, res) => {
    try {
      const fileName = basename(req.params.id);
      const filePath = join(context.projectRoot, "radar", fileName);
      await rm(filePath, { force: true });
      res.json({ ok: true, id: fileName });
    } catch (error) {
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.get("/api/commands", async (_req, res) => {
    res.json({
      commands: commandRegistry,
      daemon: await context.cliService.daemonStatus(),
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
        const status = await context.cliService.daemonStatus();
        if (status.running) {
          logInfo("command.run.skip", { command: command.id, reason: "daemon-already-running", daemon: status });
          res.json({ ok: true, message: "Daemon already running.", daemon: status });
          return;
        }
        await context.cliService.spawnCli(command.buildArgs(values), { detached: true });
        logInfo("command.run.done", { command: command.id, detached: true });
        res.json({ ok: true, message: "Daemon start requested.", daemon: await context.cliService.daemonStatus() });
        return;
      }

      if (command.specialHandler === "daemon-down") {
        await context.cliService.spawnCli(command.buildArgs(values));
        logInfo("command.run.done", { command: command.id });
        res.json({ ok: true, message: "Daemon stop requested.", daemon: await context.cliService.daemonStatus() });
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
            const result = await context.cliService.spawnCli(args, { expectJson: command.supportsJson, timeoutMs: context.webCommandTimeoutMs });
            if (result.code !== 0) {
              const timeoutError = result.code === 124 ? `Command timed out after ${context.webCommandTimeoutMs}ms.` : undefined;
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
      const result = await context.cliService.spawnCli(args, { expectJson: command.supportsJson, timeoutMs: context.webCommandTimeoutMs });

      if (result.code !== 0) {
        const status = result.code === 124 ? 504 : 400;
        const timeoutError =
          result.code === 124 ? `Command timed out after ${context.webCommandTimeoutMs}ms.` : undefined;

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
        daemon: command.id === "up" || command.id === "down" ? await context.cliService.daemonStatus() : undefined,
      });
    } catch (error) {
      logError("command.run.error", { command: req.params.id, error: describeError(error) });
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
