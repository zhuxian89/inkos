import {
  StateManager,
  buildChapterFilename,
  countNovelWords,
  type ChapterMeta,
  writeCanonicalChapterFile,
} from "@actalk/inkos-core";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  createJob,
  failJob,
  finishJob,
  startJob,
  updateJobStep,
} from "./jobs.js";
import {
  createBookConfig,
  createPipeline,
  loadProjectConfig,
  resolveBookId,
} from "./runtime.js";
import type { RouteRegistrar } from "./service-context.js";
import {
  describeError,
  encodeRFC5987ValueChars,
  logError,
  logInfo,
  sanitizeFilename,
  sanitizeForLog,
} from "./service-logging.js";

export const registerBookRoutes: RouteRegistrar = (app, context) => {
  app.get("/api/books/:bookId/status", async (req, res) => {
    try {
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const book = await state.loadBookConfig(bookId);
      const chapters = await context.bookService.loadChapterIndexForStats(state, bookId);
      res.json({ ok: true, status: context.bookService.computeBookStatusFromIndex(book, bookId, chapters) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/books/:bookId/config", async (req, res) => {
    try {
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
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
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
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
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
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

      const result = await context.cliService.spawnCli(args, {
        expectJson: true,
        timeoutMs: context.webCommandTimeoutMs,
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
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const chapters = await context.bookService.loadChapterIndexForStats(state, bookId);
      res.json({ ok: true, analytics: context.bookService.computeAnalytics(bookId, chapters) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/books/:bookId/export", async (req, res) => {
    const querySchema = z.object({
      format: z.enum(["txt", "md"]).default("txt"),
      approvedOnly: z.union([z.literal("true"), z.literal("false")]).optional(),
    });

    try {
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const query = querySchema.parse(req.query);
      const format = query.format;
      const approvedOnly = query.approvedOnly === "true";

      const book = await state.loadBookConfig(bookId);
      const index = await state.loadChapterIndex(bookId);
      const chapters = approvedOnly
        ? index.filter((chapter) => chapter.status === "approved")
        : [...index];
      chapters.sort((a, b) => a.number - b.number);

      if (chapters.length === 0) {
        throw new Error(approvedOnly ? "没有可导出的已通过章节" : "没有可导出的章节");
      }

      const chaptersDir = join(state.bookDir(bookId), "chapters");
      const chapterFiles = await readdir(chaptersDir).catch(() => []);
      const parts: string[] = [];

      if (format === "md") {
        parts.push(`# ${book.title}\n`);
        parts.push("---\n");
      } else {
        parts.push(`${book.title}\n\n`);
      }

      let exportedCount = 0;
      for (const chapter of chapters) {
        const prefix = String(chapter.number).padStart(4, "0");
        const match = chapterFiles.find((fileName) => fileName.startsWith(prefix));
        if (!match) continue;
        const raw = await readFile(join(chaptersDir, match), "utf-8");
        parts.push(raw);
        parts.push("\n\n");
        exportedCount += 1;
      }

      if (exportedCount === 0) {
        throw new Error("未找到可导出的章节文件");
      }

      const fileName = `${sanitizeFilename(book.title || bookId) || bookId}_export.${format}`;
      const content = parts.join("\n");
      res.setHeader("Content-Type", format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="book_export.${format}"; filename*=UTF-8''${encodeRFC5987ValueChars(fileName)}`,
      );
      res.setHeader("Cache-Control", "no-store");
      logInfo("books.export.download", { bookId, format, approvedOnly, chapters: exportedCount, fileName });
      res.send(content);
    } catch (error) {
      logError("books.export.download.error", { bookId: req.params.bookId, error: describeError(error) });
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.get("/api/books/:bookId/chapters", async (req, res) => {
    try {
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const chapters = await context.bookService.loadChapterIndexForStats(state, bookId);
      const sorted = [...chapters].sort((a, b) => a.number - b.number);
      res.json({ ok: true, bookId, chapters: sorted });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/books/:bookId/chapters/:chapter", async (req, res) => {
    try {
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const chapterNumber = parseInt(req.params.chapter, 10);
      if (!Number.isFinite(chapterNumber) || chapterNumber < 1) {
        throw new Error(`Invalid chapter number: ${req.params.chapter}`);
      }
      const bookDir = state.bookDir(bookId);
      const chapterMeta = (await state.loadChapterIndex(bookId)).find((item) => item.number === chapterNumber);
      const chapterFile = await context.bookService.findChapterFile(bookDir, chapterNumber, chapterMeta?.title);
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
        rawContent: raw,
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
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
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
      const chapterFile = await context.bookService.findChapterFile(bookDir, chapterNumber, chapterMeta.title);

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
      const nextWordCount = countNovelWords(nextBody);

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
              wordCount: nextWordCount,
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
        wordCount: nextWordCount,
      });
      res.json({ ok: true, bookId, chapter: chapterNumber, filePath: writeResult.fullPath, title: nextTitle, wordCount: nextWordCount });
    } catch (error) {
      logError("chapter.replace.error", {
        bookId: req.params.bookId,
        chapter: req.params.chapter,
        error: describeError(error),
      });
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.delete("/api/books/:bookId/chapters/:chapter", async (req, res) => {
    try {
      const state = new StateManager(context.projectRoot);
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const chapterNumber = parseInt(req.params.chapter, 10);
      if (!Number.isFinite(chapterNumber) || chapterNumber < 1) {
        throw new Error(`Invalid chapter number: ${req.params.chapter}`);
      }

      const bookDir = state.bookDir(bookId);
      const chapterIndex = await state.loadChapterIndex(bookId);
      const target = chapterIndex.find((item) => item.number === chapterNumber);
      if (!target) {
        throw new Error(`Chapter ${chapterNumber} not found in index`);
      }

      const chapterFile = await context.bookService.findChapterFile(bookDir, chapterNumber, target.title);
      await rm(chapterFile, { force: true });

      const filtered = chapterIndex.filter((item) => item.number !== chapterNumber);
      const recalculated = await context.bookService.recalcChapterWordCounts(state, bookId, filtered);
      await state.saveChapterIndex(bookId, recalculated);
      await context.bookService.cleanupStoryFilesAfterChapterDelete(bookDir, chapterNumber, recalculated);

      logInfo("chapter.delete.done", {
        bookId,
        chapter: chapterNumber,
        removedFile: chapterFile,
        remaining: recalculated.length,
        totalWords: recalculated.reduce((sum, item) => sum + item.wordCount, 0),
      });

      res.json({
        ok: true,
        bookId,
        chapter: chapterNumber,
        removedFile: chapterFile,
        remainingChapters: recalculated.length,
        totalWords: recalculated.reduce((sum, item) => sum + item.wordCount, 0),
      });
    } catch (error) {
      logError("chapter.delete.error", {
        bookId: req.params.bookId,
        chapter: req.params.chapter,
        error: describeError(error),
      });
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.get("/api/review/pending", async (req, res) => {
    try {
      const state = new StateManager(context.projectRoot);
      const requestedBookId = typeof req.query.bookId === "string" ? req.query.bookId : undefined;
      const bookIds = requestedBookId ? [await resolveBookId(context.projectRoot, requestedBookId)] : await state.listBooks();
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
      const mergedBrief = context.bookService.mergeAuthorBrief(input.context, input.authorBrief);
      const initContext = context.bookService.composeInitContext(input.context, mergedBrief);
      logInfo("books.create.accepted", {
        bookId: book.id,
        title: book.title,
        genre: input.genre,
        platform: input.platform,
        initMode,
      });

      const job = createJob({
        type: "create-book",
        step: initMode === "fast" ? "快速初始化：准备中" : "初始化：准备中",
        bookId: book.id,
      });
      startJob(job, { title: book.title, initMode });

      res.json({ ok: true, jobId: job.id, bookId: book.id });

      void (async () => {
        try {
          const state = new StateManager(context.projectRoot);
          updateJobStep(job, "保存：书籍配置");
          await state.saveBookConfig(book.id, book);
          updateJobStep(job, "保存：章节索引");
          await state.saveChapterIndex(book.id, []);

          if (initMode === "fast") {
            updateJobStep(job, "快速初始化：生成骨架文件");
            await context.bookService.initializeBookSkeleton(book.id);
          } else {
            updateJobStep(job, "初始化：加载项目配置");
            const config = await loadProjectConfig(context.projectRoot);
            updateJobStep(job, "初始化：运行管线");
            const pipeline = createPipeline(context.projectRoot, config, initContext);
            await pipeline.initBook(book);
          }

          if (mergedBrief?.trim()) {
            updateJobStep(job, "保存：作者创作简报");
            await context.bookService.writeAuthorBrief(book.id, mergedBrief);
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
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const content = await context.bookService.readAuthorBrief(bookId);
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
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      const input = schema.parse(req.body ?? {});
      logInfo("books.init_brief.save.start", { bookId, contentLength: input.content.length });
      await context.bookService.writeAuthorBrief(bookId, input.content);
      logInfo("books.init_brief.save.done", { bookId, contentLength: input.content.length });
      res.json({ ok: true, bookId, content: input.content });
    } catch (error) {
      logError("books.init_brief.save.error", { bookId: req.params.bookId, error: describeError(error) });
      res.status(400).json({ ok: false, error: describeError(error) });
    }
  });

  app.delete("/api/books/:bookId", async (req, res) => {
    try {
      const bookId = await resolveBookId(context.projectRoot, req.params.bookId);
      logInfo("books.delete.start", { bookId });
      const state = new StateManager(context.projectRoot);
      await rm(state.bookDir(bookId), { recursive: true, force: true });
      logInfo("books.delete.done", { bookId });
      res.json({ ok: true, bookId });
    } catch (error) {
      logError("books.delete.error", { bookId: req.params.bookId, error: describeError(error) });
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
      const bookId = await resolveBookId(context.projectRoot, input.bookId);
      logInfo("review.approve.start", { bookId, chapter: input.chapter });
      const state = new StateManager(context.projectRoot);
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
      const bookId = await resolveBookId(context.projectRoot, input.bookId);
      logInfo("review.reject.start", { bookId, chapter: input.chapter });
      const state = new StateManager(context.projectRoot);
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
      const bookId = await resolveBookId(context.projectRoot, input.bookId);
      logInfo("review.approve_all.start", { bookId });
      const state = new StateManager(context.projectRoot);
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
};
