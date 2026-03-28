import type { LLMClient } from "../llm/provider.js";
import { chatCompletion } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { NotifyChannel } from "../models/project.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { ArchitectAgent } from "../agents/architect.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { ReviserAgent, type ReviseMode, type ReviseOutput } from "../agents/reviser.js";
import { RadarAgent } from "../agents/radar.js";
import type { RadarSource } from "../agents/radar-source.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { analyzeAITells } from "../agents/ai-tells.js";
import { analyzeSensitiveWords } from "../agents/sensitive-words.js";
import { StateManager } from "../state/manager.js";
import { dispatchNotification, dispatchWebhookEvent } from "../notify/dispatcher.js";
import type { WebhookEvent } from "../notify/webhook.js";
import type { AgentContext } from "../agents/base.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { RadarResult } from "../agents/radar.js";
import { buildChapterFilename, extractChapterBody, resolveChapterFile, writeCanonicalChapterFile } from "../utils/chapter-files.js";
import { countNovelWords } from "../utils/text-count.js";
import { readFile, readdir, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const WORDCOUNT_TOLERANCE = 0.1;

export interface PipelineConfig {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly notifyChannels?: ReadonlyArray<NotifyChannel>;
  readonly radarSources?: ReadonlyArray<RadarSource>;
  readonly externalContext?: string;
  readonly modelOverrides?: Record<string, string>;
  readonly logger?: (event: string, payload?: Record<string, unknown>) => void;
}

export interface ChapterPipelineResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly revised: boolean;
  readonly status: "approved" | "needs-review";
}

// Atomic operation results
export interface DraftResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly filePath: string;
}

export interface ReviseResult {
  readonly chapterNumber: number;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
}

export interface TruthFiles {
  readonly currentState: string;
  readonly particleLedger: string;
  readonly pendingHooks: string;
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRules: string;
}

export interface BookStatusInfo {
  readonly bookId: string;
  readonly title: string;
  readonly genre: string;
  readonly platform: string;
  readonly status: string;
  readonly chaptersWritten: number;
  readonly totalWords: number;
  readonly nextChapter: number;
  readonly chapters: ReadonlyArray<ChapterMeta>;
}

export class PipelineRunner {
  private readonly state: StateManager;
  private readonly config: PipelineConfig;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.state = new StateManager(config.projectRoot);
  }

  private agentCtx(bookId?: string): AgentContext {
    return {
      client: this.config.client,
      model: this.config.model,
      projectRoot: this.config.projectRoot,
      bookId,
    };
  }

  private modelFor(agentName: string): string {
    return this.config.modelOverrides?.[agentName] ?? this.config.model;
  }

  private agentCtxFor(agent: string, bookId?: string): AgentContext {
    return {
      client: this.config.client,
      model: this.modelFor(agent),
      projectRoot: this.config.projectRoot,
      bookId,
    };
  }

  private async loadGenreProfile(genre: string): Promise<{ profile: GenreProfile }> {
    const parsed = await readGenreProfile(this.config.projectRoot, genre);
    return { profile: parsed.profile };
  }

  private debug(event: string, payload: Record<string, unknown>): void {
    this.config.logger?.(`pipeline.${event}`, payload);
  }

  private formatIndexedAuditIssue(issue: AuditIssue): string {
    const category = issue.category.trim();
    const description = issue.description.trim();
    return category.length > 0
      ? `[${issue.severity}] ${category}: ${description}`
      : `[${issue.severity}] ${description}`;
  }

  private resolveReviseTargetWordCount(
    mode: ReviseMode,
    currentWordCount: number,
    defaultWordCount: number,
  ): number {
    if (mode === "polish" || mode === "spot-fix" || mode === "anti-detect") {
      return Math.max(1, currentWordCount);
    }
    return defaultWordCount;
  }

  // ---------------------------------------------------------------------------
  // Atomic operations (composable by OpenClaw or agent mode)
  // ---------------------------------------------------------------------------

  async runRadar(): Promise<RadarResult> {
    const radar = new RadarAgent(this.agentCtxFor("radar"), this.config.radarSources);
    return radar.scan();
  }

  async initBook(book: BookConfig): Promise<void> {
    const architect = new ArchitectAgent(this.agentCtxFor("architect", book.id));
    const bookDir = this.state.bookDir(book.id);

    await this.state.saveBookConfig(book.id, book);

    const { profile: gp } = await this.loadGenreProfile(book.genre);
    const foundation = await architect.generateFoundation(book, this.config.externalContext);
    await architect.writeFoundationFiles(bookDir, foundation, gp.numericalSystem);
    await this.state.saveChapterIndex(book.id, []);
  }

  /** Write a single draft chapter. Saves chapter file + truth files + index + snapshot. */
  async writeDraft(bookId: string, context?: string, wordCount?: number): Promise<DraftResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      this.debug("draft.start", { projectRoot: this.config.projectRoot, bookId, hasContext: Boolean(context?.trim()), wordCountOverride: wordCount ?? null });
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const chapterNumber = await this.state.getNextChapterNumber(bookId);
      this.debug("draft.book.loaded", { bookId, chapterNumber, genre: book.genre, platform: book.platform, targetWordCount: wordCount ?? book.chapterWordCount });

      const { profile: gp } = await this.loadGenreProfile(book.genre);
      this.debug("draft.genre.loaded", { bookId, chapterNumber, numericalSystem: gp.numericalSystem, pacingRule: gp.pacingRule });

      const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
      this.debug("draft.writer.start", { bookId, chapterNumber });
      const output = await writer.writeChapter({
        book,
        bookDir,
        chapterNumber,
        externalContext: context ?? this.config.externalContext,
        ...(wordCount ? { wordCountOverride: wordCount } : {}),
      });
      this.debug("draft.writer.done", {
        bookId,
        chapterNumber,
        title: output.title,
        wordCount: output.wordCount,
        postWriteErrors: output.postWriteErrors.length,
        postWriteWarnings: output.postWriteWarnings.length,
      });

      // Save chapter file
      const chaptersDir = join(bookDir, "chapters");
      const paddedNum = String(chapterNumber).padStart(4, "0");
      const sanitized = output.title.replace(/[/\\?%*:|"<>]/g, "").replace(/\s+/g, "_").slice(0, 50);
      const filename = `${paddedNum}_${sanitized}.md`;
      const filePath = join(chaptersDir, filename);

      const existingChapterFiles = (await readdir(chaptersDir))
        .filter((file) => file.startsWith(`${paddedNum}_`) && file.endsWith(".md"));
      if (existingChapterFiles.length > 0) {
        this.debug("draft.chapter.cleanup.start", {
          bookId,
          chapterNumber,
          existingFiles: existingChapterFiles,
        });
        await Promise.all(
          existingChapterFiles.map((file) => rm(join(chaptersDir, file), { force: true })),
        );
        this.debug("draft.chapter.cleanup.done", {
          bookId,
          chapterNumber,
          removedFiles: existingChapterFiles,
        });
      }

      this.debug("draft.chapter.write.start", { bookId, chapterNumber, filePath });
      await writeFile(filePath, `# 第${chapterNumber}章 ${output.title}\n\n${output.content}`, "utf-8");
      this.debug("draft.chapter.write.done", { bookId, chapterNumber, filePath, contentLength: output.content.length });

      // Save truth files
      this.debug("draft.truth_files.start", { bookId, chapterNumber });
      await writer.saveChapter(bookDir, output, gp.numericalSystem);
      await writer.saveNewTruthFiles(bookDir, output);
      this.debug("draft.truth_files.done", { bookId, chapterNumber });

      // Update index
      const existingIndex = await this.state.loadChapterIndex(bookId);
      const now = new Date().toISOString();
      const newEntry: ChapterMeta = {
        number: chapterNumber,
        title: output.title,
        status: "drafted",
        wordCount: output.wordCount,
        createdAt: now,
        updatedAt: now,
        auditIssues: [],
        auditDetails: [],
      };
      this.debug("draft.index.save.start", { bookId, chapterNumber, existingChapters: existingIndex.length });
      await this.state.saveChapterIndex(bookId, [...existingIndex, newEntry]);
      this.debug("draft.index.save.done", { bookId, chapterNumber, totalChapters: existingIndex.length + 1 });

      // Snapshot
      this.debug("draft.snapshot.start", { bookId, chapterNumber });
      await this.state.snapshotState(bookId, chapterNumber);
      this.debug("draft.snapshot.done", { bookId, chapterNumber });

      await this.emitWebhook("chapter-complete", bookId, chapterNumber, {
        title: output.title,
        wordCount: output.wordCount,
      });
      this.debug("draft.done", { bookId, chapterNumber, title: output.title, wordCount: output.wordCount, filePath });

      return { chapterNumber, title: output.title, wordCount: output.wordCount, filePath };
    } finally {
      await releaseLock();
    }
  }

  /** Audit the latest (or specified) chapter. Lock index-write section to avoid concurrent overwrite. */
  async auditDraft(bookId: string, chapterNumber?: number): Promise<AuditResult & { readonly chapterNumber: number }> {
    this.debug("audit.start", { projectRoot: this.config.projectRoot, bookId, chapterNumber: chapterNumber ?? null });
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
    if (targetChapter < 1) {
      throw new Error(`No chapters to audit for "${bookId}"`);
    }
    this.debug("audit.book.loaded", { bookId, targetChapter, genre: book.genre, platform: book.platform });

    this.debug("audit.chapter.read.start", { bookId, targetChapter });
      const chapterMeta = (await this.state.loadChapterIndex(bookId)).find((item) => item.number === targetChapter);
      const content = await this.readChapterContent(bookDir, targetChapter, chapterMeta?.title);
      this.debug("audit.chapter.read.done", { bookId, targetChapter, contentLength: content.length });
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    this.debug("audit.auditor.start", { bookId, targetChapter });
    const llmResult = await auditor.auditChapter(bookDir, content, targetChapter, book.genre);
    this.debug("audit.auditor.done", {
      bookId,
      targetChapter,
      passed: llmResult.passed,
      issueCount: llmResult.issues.length,
      summary: llmResult.summary,
    });

    // Merge rule-based AI-tell detection
    this.debug("audit.ai_tells.start", { bookId, targetChapter });
    const aiTells = analyzeAITells(content);
    this.debug("audit.ai_tells.done", { bookId, targetChapter, issueCount: aiTells.issues.length });
    // Merge sensitive word detection
    this.debug("audit.sensitive_words.start", { bookId, targetChapter });
    const sensitiveResult = analyzeSensitiveWords(content);
    this.debug("audit.sensitive_words.done", {
      bookId,
      targetChapter,
      issueCount: sensitiveResult.issues.length,
      blockedCount: sensitiveResult.found.filter((f) => f.severity === "block").length,
    });
    const hasBlockedWords = sensitiveResult.found.some((f) => f.severity === "block");
    const mergedIssues: ReadonlyArray<AuditIssue> = [
      ...llmResult.issues,
      ...aiTells.issues,
      ...sensitiveResult.issues,
    ];
    const result: AuditResult = {
      passed: hasBlockedWords ? false : llmResult.passed,
      issues: mergedIssues,
      summary: llmResult.summary,
    };
    this.debug("audit.result.merged", {
      bookId,
      targetChapter,
      passed: result.passed,
      totalIssues: result.issues.length,
    });

    // Update index with audit result
    this.debug("audit.index.save.lock.start", { bookId, targetChapter });
    const releaseLock = await this.state.acquireBookLock(bookId);
    this.debug("audit.index.save.lock.done", { bookId, targetChapter });
    try {
      this.debug("audit.index.save.start", { bookId, targetChapter });
      const index = await this.state.loadChapterIndex(bookId);
      const updated = index.map((ch) =>
        ch.number === targetChapter
          ? {
              ...ch,
              status: (result.passed ? "ready-for-review" : "audit-failed") as ChapterMeta["status"],
              updatedAt: new Date().toISOString(),
              auditIssues: result.issues.map((issue) => this.formatIndexedAuditIssue(issue)),
              auditDetails: result.issues.map((issue) => ({ ...issue })),
            }
          : ch,
      );
      await this.state.saveChapterIndex(bookId, updated);
      this.debug("audit.index.save.done", {
        bookId,
        targetChapter,
        status: updated.find((ch) => ch.number === targetChapter)?.status ?? null,
        issueCount: updated.find((ch) => ch.number === targetChapter)?.auditIssues.length ?? 0,
      });
    } finally {
      await releaseLock();
      this.debug("audit.index.save.lock.release", { bookId, targetChapter });
    }

    await this.emitWebhook(
      result.passed ? "audit-passed" : "audit-failed",
      bookId,
      targetChapter,
      { summary: result.summary, issueCount: result.issues.length },
    );
    this.debug("audit.done", {
      bookId,
      targetChapter,
      passed: result.passed,
      issueCount: result.issues.length,
    });

    return { ...result, chapterNumber: targetChapter };
  }

  /** Revise the latest (or specified) chapter based on audit issues. */
  async reviseDraft(bookId: string, chapterNumber?: number, mode: ReviseMode = "rewrite", instruction?: string): Promise<ReviseResult> {
    const releaseLock = await this.state.acquireBookLock(bookId);
    try {
      this.debug("revise.start", {
        projectRoot: this.config.projectRoot,
        bookId,
        chapterNumber: chapterNumber ?? null,
        mode,
        hasInstruction: Boolean(instruction?.trim()),
      });
      const book = await this.state.loadBookConfig(bookId);
      const bookDir = this.state.bookDir(bookId);
      const targetChapter = chapterNumber ?? (await this.state.getNextChapterNumber(bookId)) - 1;
      if (targetChapter < 1) {
        throw new Error(`No chapters to revise for "${bookId}"`);
      }
      this.debug("revise.book.loaded", { bookId, targetChapter, genre: book.genre, platform: book.platform });

      // Read the current audit issues from index
      this.debug("revise.index.load.start", { bookId, targetChapter });
      const index = await this.state.loadChapterIndex(bookId);
      const chapterMeta = index.find((ch) => ch.number === targetChapter);
      if (!chapterMeta) {
        throw new Error(`Chapter ${targetChapter} not found in index`);
      }
      this.debug("revise.index.load.done", {
        bookId,
        targetChapter,
        status: chapterMeta.status,
        indexedIssueCount: chapterMeta.auditIssues.length,
      });

      // Prefer stored audit issues from index; only re-audit when there are no existing issues.
      this.debug("revise.chapter.read.start", { bookId, targetChapter });
      const content = await this.readChapterContent(bookDir, targetChapter, chapterMeta.title);
      const currentWordCount = countNovelWords(content);
      const reviseTargetWordCount = this.resolveReviseTargetWordCount(mode, currentWordCount, book.chapterWordCount);
      this.debug("revise.chapter.read.done", {
        bookId,
        targetChapter,
        contentLength: content.length,
        currentWordCount,
        reviseTargetWordCount,
      });
      let auditResult: AuditResult;
      if (chapterMeta.auditDetails?.length) {
        auditResult = {
          passed: chapterMeta.auditDetails.every((issue) => issue.severity !== "critical"),
          issues: chapterMeta.auditDetails.map((issue) => ({ ...issue })),
          summary: "使用已存在的完整审计结果直接修订",
        };
        this.debug("revise.audit.reuse_details", {
          bookId,
          targetChapter,
          issueCount: chapterMeta.auditDetails.length,
          status: chapterMeta.status,
        });
      } else {
        this.debug("revise.audit.refresh.start", {
          bookId,
          targetChapter,
          indexedIssueCount: chapterMeta.auditIssues.length,
          reason: chapterMeta.auditIssues.length > 0 ? "missing_audit_details" : "no_stored_audit",
        });
        const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
        const llmAudit = await auditor.auditChapter(bookDir, content, targetChapter, book.genre);
        const aiTells = analyzeAITells(content);
        const sensitiveResult = analyzeSensitiveWords(content);
        const hasBlockedWords = sensitiveResult.found.some((found) => found.severity === "block");
        auditResult = {
          passed: hasBlockedWords ? false : llmAudit.passed,
          issues: [...llmAudit.issues, ...aiTells.issues, ...sensitiveResult.issues],
          summary: llmAudit.summary,
        };
        this.debug("revise.audit.refresh.done", {
          bookId,
          targetChapter,
          passed: auditResult.passed,
          issueCount: auditResult.issues.length,
        });
      }

      if (auditResult.issues.length === 0 && !instruction?.trim()) {
        this.debug("revise.skip.no_issues", { bookId, targetChapter, mode });
        return { chapterNumber: targetChapter, wordCount: currentWordCount, fixedIssues: ["没有需要修复的问题"] };
      }

      const { profile: gp } = await this.loadGenreProfile(book.genre);
      this.debug("revise.genre.loaded", { bookId, targetChapter, numericalSystem: gp.numericalSystem });

      const reviser = new ReviserAgent(this.agentCtxFor("reviser", bookId));
      this.debug("revise.reviser.start", {
        bookId,
        targetChapter,
        mode,
        issueCount: auditResult.issues.length,
        hasInstruction: Boolean(instruction?.trim()),
        reviseTargetWordCount,
      });
      const reviseOutput = await reviser.reviseChapter(
        bookDir,
        content,
        targetChapter,
        auditResult.issues,
        mode,
        book.genre,
        instruction,
        reviseTargetWordCount,
      );

      this.debug("revise.output", {
        projectRoot: this.config.projectRoot,
        bookId,
        chapter: targetChapter,
        mode,
        revisedWordCount: reviseOutput.wordCount,
        revisedContentLength: reviseOutput.revisedContent.length,
        fixedIssuesCount: reviseOutput.fixedIssues.length,
        preview: reviseOutput.revisedContent.slice(0, 180),
      });

      if (reviseOutput.revisedContent.length === 0) {
        throw new Error("Reviser returned empty content");
      }

      // Save revised chapter file
      const chaptersDir = join(bookDir, "chapters");
      const resolvedChapter = await resolveChapterFile(chaptersDir, targetChapter, chapterMeta.title);
      const targetFilename = buildChapterFilename(targetChapter, chapterMeta.title);
      this.debug("revise.write.before", {
        bookId,
        chapter: targetChapter,
        selectedFile: resolvedChapter.selected.file,
        targetFile: targetFilename,
        candidateCount: resolvedChapter.candidates.length,
        duplicates: resolvedChapter.duplicates.map((item) => item.file),
      });
      const writeResult = await writeCanonicalChapterFile({
        chaptersDir,
        chapterNumber: targetChapter,
        title: chapterMeta.title,
        body: reviseOutput.revisedContent,
      });
      const afterStat = await stat(writeResult.fullPath);
      this.debug("revise.write.after", {
        bookId,
        chapter: targetChapter,
        file: writeResult.fullPath,
        size: afterStat.size,
        mtimeMs: afterStat.mtimeMs,
        removedDuplicates: writeResult.removedDuplicates,
      });

      // Update truth files
      const storyDir = join(bookDir, "story");
      this.debug("revise.truth_files.start", { bookId, chapter: targetChapter });
      if (reviseOutput.updatedState !== "(状态卡未更新)") {
        await writeFile(join(storyDir, "current_state.md"), reviseOutput.updatedState, "utf-8");
      }
      if (gp.numericalSystem && reviseOutput.updatedLedger && reviseOutput.updatedLedger !== "(账本未更新)") {
        await writeFile(join(storyDir, "particle_ledger.md"), reviseOutput.updatedLedger, "utf-8");
      }
      if (reviseOutput.updatedHooks !== "(伏笔池未更新)") {
        await writeFile(join(storyDir, "pending_hooks.md"), reviseOutput.updatedHooks, "utf-8");
      }
      if (reviseOutput.updatedChapterSummaries !== "(章节摘要未更新)") {
        await writeFile(join(storyDir, "chapter_summaries.md"), reviseOutput.updatedChapterSummaries, "utf-8");
      }
      if (reviseOutput.updatedSubplots !== "(支线进度板未更新)") {
        await writeFile(join(storyDir, "subplot_board.md"), reviseOutput.updatedSubplots, "utf-8");
      }
      if (reviseOutput.updatedEmotionalArcs !== "(情感弧线未更新)") {
        await writeFile(join(storyDir, "emotional_arcs.md"), reviseOutput.updatedEmotionalArcs, "utf-8");
      }
      if (reviseOutput.updatedCharacterMatrix !== "(角色交互矩阵未更新)") {
        await writeFile(join(storyDir, "character_matrix.md"), reviseOutput.updatedCharacterMatrix, "utf-8");
      }
      this.debug("revise.truth_files.done", { bookId, chapter: targetChapter });

      // Update index
      this.debug("revise.index.save.start", { bookId, chapter: targetChapter });
      const updatedIndex = index.map((ch) =>
        ch.number === targetChapter
          ? {
              ...ch,
              status: "ready-for-review" as ChapterMeta["status"],
              wordCount: reviseOutput.wordCount,
              updatedAt: new Date().toISOString(),
              auditIssues: [],
              auditDetails: [],
            }
          : ch,
      );
      await this.state.saveChapterIndex(bookId, updatedIndex);
      this.debug("revise.index.saved", {
        bookId,
        chapter: targetChapter,
        status: updatedIndex.find((ch) => ch.number === targetChapter)?.status ?? null,
        updatedAt: updatedIndex.find((ch) => ch.number === targetChapter)?.updatedAt ?? null,
      });

      // Re-snapshot
      this.debug("revise.snapshot.start", { bookId, chapter: targetChapter });
      await this.state.snapshotState(bookId, targetChapter);
      this.debug("revise.snapshot.done", { bookId, chapter: targetChapter });

      await this.emitWebhook("revision-complete", bookId, targetChapter, {
        wordCount: reviseOutput.wordCount,
        fixedCount: reviseOutput.fixedIssues.length,
      });
      this.debug("revise.done", {
        bookId,
        chapter: targetChapter,
        mode,
        wordCount: reviseOutput.wordCount,
        fixedIssuesCount: reviseOutput.fixedIssues.length,
      });

      return {
        chapterNumber: targetChapter,
        wordCount: reviseOutput.wordCount,
        fixedIssues: reviseOutput.fixedIssues,
      };
    } finally {
      await releaseLock();
    }
  }

  /** Read all truth files for a book. */
  async readTruthFiles(bookId: string): Promise<TruthFiles> {
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    const readSafe = async (path: string): Promise<string> => {
      try {
        return await readFile(path, "utf-8");
      } catch {
        return "(文件不存在)";
      }
    };

    const [currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules] =
      await Promise.all([
        readSafe(join(storyDir, "current_state.md")),
        readSafe(join(storyDir, "particle_ledger.md")),
        readSafe(join(storyDir, "pending_hooks.md")),
        readSafe(join(storyDir, "story_bible.md")),
        readSafe(join(storyDir, "volume_outline.md")),
        readSafe(join(storyDir, "book_rules.md")),
      ]);

    return { currentState, particleLedger, pendingHooks, storyBible, volumeOutline, bookRules };
  }

  /** Get book status overview. */
  async getBookStatus(bookId: string): Promise<BookStatusInfo> {
    const book = await this.state.loadBookConfig(bookId);
    const chapters = await this.state.loadChapterIndex(bookId);
    const nextChapter = await this.state.getNextChapterNumber(bookId);
    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);

    return {
      bookId,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      status: book.status,
      chaptersWritten: chapters.length,
      totalWords,
      nextChapter,
      chapters: [...chapters],
    };
  }

  // ---------------------------------------------------------------------------
  // Full pipeline (convenience — runs draft + audit + revise in one shot)
  // ---------------------------------------------------------------------------

  async writeNextChapter(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    onProgress?: (step: string) => void,
  ): Promise<ChapterPipelineResult> {
    this.debug("write_next.start", {
      projectRoot: this.config.projectRoot,
      bookId,
      wordCountOverride: wordCount ?? null,
      temperatureOverride: temperatureOverride ?? null,
    });
    const safeProgress = (step: string) => {
      try {
        onProgress?.(step);
      } catch {
        // ignore progress handler errors
      }
    };
    this.debug("write_next.lock.acquire.start", { bookId });
    const releaseLock = await this.state.acquireBookLock(bookId);
    safeProgress("lock-acquired");
    this.debug("write_next.lock.acquire.done", { bookId });
    try {
      const result = await this._writeNextChapterLocked(bookId, wordCount, temperatureOverride, safeProgress);
      this.debug("write_next.done", {
        bookId,
        chapterNumber: result.chapterNumber,
        title: result.title,
        wordCount: result.wordCount,
        revised: result.revised,
        passed: result.auditResult.passed,
        status: result.status,
      });
      return result;
    } finally {
      await releaseLock();
      safeProgress("lock-released");
      this.debug("write_next.lock.release.done", { bookId });
    }
  }

  private async _writeNextChapterLocked(
    bookId: string,
    wordCount?: number,
    temperatureOverride?: number,
    onProgress?: (step: string) => void,
  ): Promise<ChapterPipelineResult> {
    const book = await this.state.loadBookConfig(bookId);
    const bookDir = this.state.bookDir(bookId);
    const chapterNumber = await this.state.getNextChapterNumber(bookId);
    const { profile: gp } = await this.loadGenreProfile(book.genre);
    this.debug("write_next.book.loaded", {
      bookId,
      chapterNumber,
      genre: book.genre,
      platform: book.platform,
      targetWordCount: wordCount ?? book.chapterWordCount,
    });
    this.debug("write_next.genre.loaded", {
      bookId,
      chapterNumber,
      numericalSystem: gp.numericalSystem,
      pacingRule: gp.pacingRule,
    });
    const log = (step: string, msg: string) => {
      this.debug(`write_next.progress.${step}`, { bookId, chapterNumber, message: msg });
      try {
        onProgress?.(`ch${chapterNumber}:${step}:${msg}`);
      } catch {
        // ignore progress handler errors
      }
    };

    // 1. Write chapter
    log("write", "start");
    this.debug("write_next.writer.start", { bookId, chapterNumber });
    const writer = new WriterAgent(this.agentCtxFor("writer", bookId));
    const output = await writer.writeChapter({
      book,
      bookDir,
      chapterNumber,
      externalContext: this.config.externalContext,
      ...(wordCount ? { wordCountOverride: wordCount } : {}),
      ...(temperatureOverride ? { temperatureOverride } : {}),
    });
    log("write", `done — ${output.wordCount} words, title="${output.title}"`);
    this.debug("write_next.writer.done", {
      bookId,
      chapterNumber,
      title: output.title,
      wordCount: output.wordCount,
      postWriteErrors: output.postWriteErrors.length,
      postWriteWarnings: output.postWriteWarnings.length,
    });

    // 2a. Post-write error gate: if deterministic rules found errors, auto-fix before LLM audit
    let finalContent = output.content;
    let finalWordCount = output.wordCount;
    let revised = false;

    const targetWordCount = wordCount ?? book.chapterWordCount;
    const minWordCount = Math.max(1, Math.floor(targetWordCount * (1 - WORDCOUNT_TOLERANCE)));
    const maxWordCount = Math.max(minWordCount, Math.ceil(targetWordCount * (1 + WORDCOUNT_TOLERANCE)));

    if (output.postWriteErrors.length > 0) {
      log("spot-fix", `start — ${output.postWriteErrors.length} post-write errors`);
      this.debug("write_next.spot_fix.start", {
        bookId,
        chapterNumber,
        postWriteErrors: output.postWriteErrors.length,
      });
      const reviser = new ReviserAgent(this.agentCtxFor("reviser", bookId));
      const spotFixIssues = output.postWriteErrors.map((v) => ({
        severity: "critical" as const,
        category: v.rule,
        description: v.description,
        suggestion: v.suggestion,
      }));
      const fixResult = await reviser.reviseChapter(
        bookDir,
        finalContent,
        chapterNumber,
        spotFixIssues,
        "spot-fix",
        book.genre,
        undefined,
        targetWordCount,
      );
      if (fixResult.revisedContent.length > 0) {
        finalContent = fixResult.revisedContent;
        finalWordCount = fixResult.wordCount;
        revised = true;
        await this.saveTruthFilesFromRevision(bookDir, chapterNumber, gp.numericalSystem, fixResult, output);
      }
      log("spot-fix", "done");
      this.debug("write_next.spot_fix.done", {
        bookId,
        chapterNumber,
        wordCount: finalWordCount,
        revised,
      });
    }

    // 2b. LLM audit
    log("audit", "start");
    this.debug("write_next.audit.start", { bookId, chapterNumber });
    const auditor = new ContinuityAuditor(this.agentCtxFor("auditor", bookId));
    const llmAudit = await auditor.auditChapter(
      bookDir,
      finalContent,
      chapterNumber,
      book.genre,
    );
    const aiTellsResult = analyzeAITells(finalContent);
    const sensitiveWriteResult = analyzeSensitiveWords(finalContent);
    const hasBlockedWriteWords = sensitiveWriteResult.found.some((f) => f.severity === "block");
    let auditResult: AuditResult = {
      passed: hasBlockedWriteWords ? false : llmAudit.passed,
      issues: [...llmAudit.issues, ...aiTellsResult.issues, ...sensitiveWriteResult.issues],
      summary: llmAudit.summary,
    };
    log("audit", `done — passed=${auditResult.passed}, issues=${auditResult.issues.length}`);
    this.debug("write_next.audit.done", {
      bookId,
      chapterNumber,
      passed: auditResult.passed,
      issueCount: auditResult.issues.length,
      blockedWords: hasBlockedWriteWords,
    });

    // 3. If audit fails, try auto-revise once
    if (!auditResult.passed) {
      const criticalIssues = auditResult.issues.filter(
        (i) => i.severity === "critical",
      );
      if (criticalIssues.length > 0) {
        log("revise", `start — ${criticalIssues.length} critical issues`);
        this.debug("write_next.revise.start", {
          bookId,
          chapterNumber,
          criticalIssues: criticalIssues.length,
          totalIssues: auditResult.issues.length,
        });
        const reviser = new ReviserAgent(this.agentCtxFor("reviser", bookId));
        const reviseOutput = await reviser.reviseChapter(
          bookDir,
          finalContent,
          chapterNumber,
          auditResult.issues,
          "spot-fix",
          book.genre,
          undefined,
          targetWordCount,
        );

        if (reviseOutput.revisedContent.length > 0) {
          // Guard: reject revision if AI markers increased
          const preMarkers = analyzeAITells(finalContent);
          const postMarkers = analyzeAITells(reviseOutput.revisedContent);
          const preCount = preMarkers.issues.length;
          const postCount = postMarkers.issues.length;

          if (postCount > preCount) {
            log("revise", "discarded — AI markers increased");
            this.debug("write_next.revise.discarded", {
              bookId,
              chapterNumber,
              preAiMarkers: preCount,
              postAiMarkers: postCount,
            });
          } else {
            finalContent = reviseOutput.revisedContent;
            finalWordCount = reviseOutput.wordCount;
            revised = true;

            await this.saveTruthFilesFromRevision(bookDir, chapterNumber, gp.numericalSystem, reviseOutput, output);
          }

          // Re-audit the (possibly revised) content
          log("re-audit", "start");
          this.debug("write_next.reaudit.start", { bookId, chapterNumber });
          const reAudit = await auditor.auditChapter(
            bookDir,
            finalContent,
            chapterNumber,
            book.genre,
            { temperature: 0 },
          );
          const reAITells = analyzeAITells(finalContent);
          const reSensitive = analyzeSensitiveWords(finalContent);
          const reHasBlocked = reSensitive.found.some((f) => f.severity === "block");
          auditResult = {
            passed: reHasBlocked ? false : reAudit.passed,
            issues: [...reAudit.issues, ...reAITells.issues, ...reSensitive.issues],
            summary: reAudit.summary,
          };
          log("re-audit", `done — passed=${auditResult.passed}, issues=${auditResult.issues.length}`);
          this.debug("write_next.reaudit.done", {
            bookId,
            chapterNumber,
            passed: auditResult.passed,
            issueCount: auditResult.issues.length,
            blockedWords: reHasBlocked,
          });
        }
        log("revise", "done");
        this.debug("write_next.revise.done", {
          bookId,
          chapterNumber,
          revised,
          finalWordCount,
        });
      }
    }

    // 3.5 Word-count guard: preserve visibility, but do not block chapter persistence.
    if (finalWordCount < minWordCount || finalWordCount > maxWordCount) {
      const rangeLabel = `${minWordCount}-${maxWordCount}`;
      const wordCountIssue: AuditIssue = {
        severity: "warning",
        category: "字数约束",
        description: `正文长度 ${finalWordCount}，未落在目标区间 ${rangeLabel}（目标 ${targetWordCount}）内`,
        suggestion: finalWordCount < minWordCount
          ? "补充有效情节推进、人物动作或信息增量，再做一次修订"
          : "压缩重复描写、冗余内心独白或低价值过渡段落后再做一次修订",
      };
      log("wordcount", `warning — out of range ${finalWordCount} not in ${rangeLabel}, continue to save`);
      this.debug("write_next.wordcount.warning", {
        bookId,
        chapterNumber,
        wordCount: finalWordCount,
        minWordCount,
        maxWordCount,
        targetWordCount,
      });
      auditResult = {
        ...auditResult,
        issues: [...auditResult.issues, wordCountIssue],
      };
    }

    // 4. Save chapter (original or revised)
    log("save", "start");
    this.debug("write_next.save.start", { bookId, chapterNumber });
    const chaptersDir = join(bookDir, "chapters");
    const writeResult = await writeCanonicalChapterFile({
      chaptersDir,
      chapterNumber,
      title: output.title,
      body: finalContent,
    });
    this.debug("write_next.chapter.write.done", {
      bookId,
      chapterNumber,
      filePath: writeResult.fullPath,
      removedDuplicates: writeResult.removedDuplicates,
      contentLength: finalContent.length,
    });

    // Save original state files if not revised
    if (!revised) {
      this.debug("write_next.truth_files_from_writer.start", { bookId, chapterNumber });
      await writer.saveChapter(bookDir, output, gp.numericalSystem);
      this.debug("write_next.truth_files_from_writer.done", { bookId, chapterNumber });
    }

    // Save new truth files (summaries, subplots, emotional arcs, character matrix)
    // When revised, the reviser already saved updated versions above
    if (!revised) {
      this.debug("write_next.new_truth_files.start", { bookId, chapterNumber });
      await writer.saveNewTruthFiles(bookDir, output);
      this.debug("write_next.new_truth_files.done", { bookId, chapterNumber });
    }

    // 5. Update chapter index
    this.debug("write_next.index.save.start", { bookId, chapterNumber });
    const existingIndex = await this.state.loadChapterIndex(bookId);
    const now = new Date().toISOString();
    const newEntry: ChapterMeta = {
      number: chapterNumber,
      title: output.title,
      status: auditResult.passed ? "ready-for-review" : "audit-failed",
      wordCount: finalWordCount,
      createdAt: now,
      updatedAt: now,
      auditIssues: auditResult.issues.map((issue) => this.formatIndexedAuditIssue(issue)),
      auditDetails: auditResult.issues.map((issue) => ({ ...issue })),
    };
    await this.state.saveChapterIndex(bookId, [...existingIndex, newEntry]);
    this.debug("write_next.index.save.done", {
      bookId,
      chapterNumber,
      totalChapters: existingIndex.length + 1,
      status: newEntry.status,
      issueCount: newEntry.auditIssues.length,
    });

    // 5.5 Snapshot state for rollback support
    this.debug("write_next.snapshot.start", { bookId, chapterNumber });
    await this.state.snapshotState(bookId, chapterNumber);
    this.debug("write_next.snapshot.done", { bookId, chapterNumber });
    log("save", "done");

    // 6. Send notification (non-fatal — chapter is already saved)
    try {
      if (this.config.notifyChannels && this.config.notifyChannels.length > 0) {
        const statusEmoji = auditResult.passed ? "✅" : "⚠️";
        await dispatchNotification(this.config.notifyChannels, {
          title: `${statusEmoji} ${book.title} 第${chapterNumber}章`,
          body: [
            `**${output.title}** | ${finalWordCount}字`,
            revised ? "📝 已自动修正" : "",
            `审稿: ${auditResult.passed ? "通过" : "需人工审核"}`,
            ...auditResult.issues
              .filter((i) => i.severity !== "info")
              .map((i) => `- [${i.severity}] ${i.description}`),
          ]
            .filter(Boolean)
            .join("\n"),
        });
      }

      await this.emitWebhook("pipeline-complete", bookId, chapterNumber, {
        title: output.title,
        wordCount: finalWordCount,
        passed: auditResult.passed,
        revised,
      });
    } catch (notifyError) {
      this.debug("write_next.notify.error", {
        bookId,
        chapterNumber,
        error: notifyError instanceof Error ? notifyError.message : String(notifyError),
      });
    }

    return {
      chapterNumber,
      title: output.title,
      wordCount: finalWordCount,
      auditResult,
      revised,
      status: auditResult.passed ? "approved" : "needs-review",
    };
  }

  // ---------------------------------------------------------------------------
  // Import operations (style imitation + canon for spinoff)
  // ---------------------------------------------------------------------------

  /**
   * Generate a qualitative style guide from reference text via LLM.
   * Also saves the statistical style_profile.json.
   */
  async generateStyleGuide(bookId: string, referenceText: string, sourceName?: string): Promise<string> {
    if (referenceText.length < 500) {
      throw new Error(`Reference text too short (${referenceText.length} chars, minimum 500). Provide at least 2000 chars for reliable style extraction.`);
    }

    const { analyzeStyle } = await import("../agents/style-analyzer.js");
    const bookDir = this.state.bookDir(bookId);
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    // Statistical fingerprint
    const profile = analyzeStyle(referenceText, sourceName);
    await writeFile(join(storyDir, "style_profile.json"), JSON.stringify(profile, null, 2), "utf-8");

    // LLM qualitative extraction
    const response = await chatCompletion(this.config.client, this.config.model, [
      {
        role: "system",
        content: `你是一位文学风格分析专家。分析参考文本的写作风格，提取可供模仿的定性特征。

输出格式（Markdown）：
## 叙事声音与语气
（冷峻/热烈/讽刺/温情/...，附1-2个原文例句）

## 对话风格
（角色说话的共性特征：句子长短、口头禅倾向、方言痕迹、对话节奏）

## 场景描写特征
（五感偏好、意象选择、描写密度、环境与情绪的关联方式）

## 转折与衔接手法
（场景如何切换、时间跳跃的处理方式、段落间的过渡特征）

## 节奏特征
（长短句分布、段落长度偏好、高潮/舒缓的交替方式）

## 词汇偏好
（高频特色用词、比喻/修辞倾向、口语化程度）

## 情绪表达方式
（直白抒情 vs 动作外化、内心独白的频率和风格）

## 独特习惯
（任何值得模仿的个人写作习惯）

分析必须基于原文实际特征，不要泛泛而谈。每个部分用1-2个原文例句佐证。`,
      },
      {
        role: "user",
        content: `分析以下参考文本的写作风格：\n\n${referenceText.slice(0, 20000)}`,
      },
    ], { temperature: 0.3, maxTokens: 16000 });

    await writeFile(join(storyDir, "style_guide.md"), response.content, "utf-8");
    return response.content;
  }

  /**
   * Import canon from parent book for spinoff writing.
   * Reads parent's truth files, uses LLM to generate parent_canon.md in target book.
   */
  async importCanon(targetBookId: string, parentBookId: string): Promise<string> {
    // Validate both books exist
    const bookIds = await this.state.listBooks();
    if (!bookIds.includes(parentBookId)) {
      throw new Error(`Parent book "${parentBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }
    if (!bookIds.includes(targetBookId)) {
      throw new Error(`Target book "${targetBookId}" not found. Available: ${bookIds.join(", ") || "(none)"}`);
    }

    const parentDir = this.state.bookDir(parentBookId);
    const targetDir = this.state.bookDir(targetBookId);
    const storyDir = join(targetDir, "story");
    await mkdir(storyDir, { recursive: true });

    const readSafe = async (path: string): Promise<string> => {
      try { return await readFile(path, "utf-8"); } catch { return "(无)"; }
    };

    const parentBook = await this.state.loadBookConfig(parentBookId);

    const [storyBible, currentState, ledger, hooks, summaries, subplots, emotions, matrix] =
      await Promise.all([
        readSafe(join(parentDir, "story/story_bible.md")),
        readSafe(join(parentDir, "story/current_state.md")),
        readSafe(join(parentDir, "story/particle_ledger.md")),
        readSafe(join(parentDir, "story/pending_hooks.md")),
        readSafe(join(parentDir, "story/chapter_summaries.md")),
        readSafe(join(parentDir, "story/subplot_board.md")),
        readSafe(join(parentDir, "story/emotional_arcs.md")),
        readSafe(join(parentDir, "story/character_matrix.md")),
      ]);

    const response = await chatCompletion(this.config.client, this.config.model, [
      {
        role: "system",
        content: `你是一位网络小说架构师。基于正传的全部设定和状态文件，生成一份完整的"正传正典参照"文档，供番外写作和审计使用。

输出格式（Markdown）：
# 正传正典（《{正传书名}》）

## 世界规则（完整，来自正传设定）
（力量体系、地理设定、阵营关系、核心规则——完整复制，不压缩）

## 正典约束（不可违反的事实）
| 约束ID | 类型 | 约束内容 | 严重性 |
|---|---|---|---|
| C01 | 人物存亡 | ... | critical |
（列出所有硬性约束：谁活着、谁死了、什么事件已经发生、什么规则不可违反）

## 角色快照
| 角色 | 当前状态 | 性格底色 | 对话特征 | 已知信息 | 未知信息 |
|---|---|---|---|---|---|
（从状态卡和角色矩阵中提取每个重要角色的完整快照）

## 角色双态处理原则
- 未来会变强的角色：写潜力暗示
- 未来会黑化的角色：写微小裂痕
- 未来会死的角色：写导致死亡的性格底色

## 关键事件时间线
| 章节 | 事件 | 涉及角色 | 对番外的约束 |
|---|---|---|---|
（从章节摘要中提取关键事件）

## 伏笔状态
| Hook ID | 类型 | 状态 | 内容 | 预期回收 |
|---|---|---|---|---|

## 资源账本快照
（当前资源状态）

---
meta:
  parentBookId: "{parentBookId}"
  parentTitle: "{正传书名}"
  generatedAt: "{ISO timestamp}"

要求：
1. 世界规则完整复制，不压缩——准确性优先
2. 正典约束必须穷尽，遗漏会导致番外与正传矛盾
3. 角色快照必须包含信息边界（已知/未知），防止番外中角色引用不该知道的信息`,
      },
      {
        role: "user",
        content: `正传书名：${parentBook.title}
正传ID：${parentBookId}

## 正传世界设定
${storyBible}

## 正传当前状态卡
${currentState}

## 正传资源账本
${ledger}

## 正传伏笔池
${hooks}

## 正传章节摘要
${summaries}

## 正传支线进度
${subplots}

## 正传情感弧线
${emotions}

## 正传角色矩阵
${matrix}`,
      },
    ], { temperature: 0.3, maxTokens: 16000 });

    // Append deterministic meta block (LLM may hallucinate timestamps)
    const metaBlock = [
      "",
      "---",
      "meta:",
      `  parentBookId: "${parentBookId}"`,
      `  parentTitle: "${parentBook.title}"`,
      `  generatedAt: "${new Date().toISOString()}"`,
    ].join("\n");
    const canon = response.content + metaBlock;

    await writeFile(join(storyDir, "parent_canon.md"), canon, "utf-8");
    return canon;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async emitWebhook(
    event: WebhookEvent,
    bookId: string,
    chapterNumber?: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.notifyChannels || this.config.notifyChannels.length === 0) return;
    await dispatchWebhookEvent(this.config.notifyChannels, {
      event,
      bookId,
      chapterNumber,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  private async saveTruthFilesFromRevision(
    bookDir: string,
    chapterNumber: number,
    numericalSystem: boolean,
    output: ReviseOutput,
    fallback?: WriteChapterOutput,
  ): Promise<void> {
    const isMeaningful = (value: string | undefined): value is string =>
      Boolean(value) && !value?.startsWith("(");
    const storyDir = join(bookDir, "story");
    this.debug("write_next.truth_files_from_revise.start", { chapterNumber });

    const updatedState = isMeaningful(output.updatedState)
      ? output.updatedState
      : (isMeaningful(fallback?.updatedState) ? fallback.updatedState : "");
    if (updatedState) {
      await writeFile(join(storyDir, "current_state.md"), updatedState, "utf-8");
    }

    const updatedLedger = isMeaningful(output.updatedLedger)
      ? output.updatedLedger
      : (isMeaningful(fallback?.updatedLedger) ? fallback.updatedLedger : "");
    if (numericalSystem && updatedLedger) {
      await writeFile(join(storyDir, "particle_ledger.md"), updatedLedger, "utf-8");
    }

    const updatedHooks = isMeaningful(output.updatedHooks)
      ? output.updatedHooks
      : (isMeaningful(fallback?.updatedHooks) ? fallback.updatedHooks : "");
    if (updatedHooks) {
      await writeFile(join(storyDir, "pending_hooks.md"), updatedHooks, "utf-8");
    }

    if (isMeaningful(output.updatedChapterSummaries)) {
      await writeFile(join(storyDir, "chapter_summaries.md"), output.updatedChapterSummaries, "utf-8");
    } else if (isMeaningful(fallback?.chapterSummary)) {
      await this.appendChapterSummaryRowsIfMissing(storyDir, fallback.chapterSummary);
    }

    const updatedSubplots = isMeaningful(output.updatedSubplots)
      ? output.updatedSubplots
      : (isMeaningful(fallback?.updatedSubplots) ? fallback.updatedSubplots : "");
    if (updatedSubplots) {
      await writeFile(join(storyDir, "subplot_board.md"), updatedSubplots, "utf-8");
    }

    const updatedEmotionalArcs = isMeaningful(output.updatedEmotionalArcs)
      ? output.updatedEmotionalArcs
      : (isMeaningful(fallback?.updatedEmotionalArcs) ? fallback.updatedEmotionalArcs : "");
    if (updatedEmotionalArcs) {
      await writeFile(join(storyDir, "emotional_arcs.md"), updatedEmotionalArcs, "utf-8");
    }

    const updatedCharacterMatrix = isMeaningful(output.updatedCharacterMatrix)
      ? output.updatedCharacterMatrix
      : (isMeaningful(fallback?.updatedCharacterMatrix) ? fallback.updatedCharacterMatrix : "");
    if (updatedCharacterMatrix) {
      await writeFile(join(storyDir, "character_matrix.md"), updatedCharacterMatrix, "utf-8");
    }

    this.debug("write_next.truth_files_from_revise.done", { chapterNumber });
  }

  private async appendChapterSummaryRowsIfMissing(storyDir: string, summary: string): Promise<void> {
    const summaryPath = join(storyDir, "chapter_summaries.md");
    let existing = "";
    try {
      existing = await readFile(summaryPath, "utf-8");
    } catch {
      existing = "# 章节摘要\n\n| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |\n|------|------|----------|----------|----------|----------|----------|----------|\n";
    }

    const extractDataRows = (text: string): string[] =>
      text
        .split("\n")
        .filter((line) => line.startsWith("|") && !line.startsWith("| 章节") && !line.startsWith("|--"));

    const existingRows = new Set(extractDataRows(existing));
    const incomingRows = extractDataRows(summary).filter((line) => !existingRows.has(line));
    if (incomingRows.length === 0) return;

    await writeFile(summaryPath, `${existing.trimEnd()}\n${incomingRows.join("\n")}\n`, "utf-8");
  }

  private async readChapterContent(bookDir: string, chapterNumber: number, preferredTitle?: string): Promise<string> {
    const chaptersDir = join(bookDir, "chapters");
    const resolved = await resolveChapterFile(chaptersDir, chapterNumber, preferredTitle);
    if (resolved.duplicates.length > 0) {
      this.debug("chapter.file.multiple_matches", {
        bookDir,
        chapterNumber,
        preferredTitle: preferredTitle ?? null,
        selected: resolved.selected.file,
        candidates: resolved.candidates.map((item) => ({
          file: item.file,
          size: item.size,
          mtimeMs: item.mtimeMs,
          headingTitle: item.headingTitle,
        })),
      });
    }
    const raw = await readFile(resolved.selected.fullPath, "utf-8");
    return extractChapterBody(raw);
  }
}
