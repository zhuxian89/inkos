import {
  StateManager,
  countNovelWords,
  resolveChapterFile,
  type ChapterMeta,
} from "@actalk/inkos-core";
import { dirname, join } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { logInfo } from "./service-logging.js";

export function createBookService(projectRoot: string) {
  function computeAnalytics(
    bookId: string,
    chapters: ReadonlyArray<Pick<ChapterMeta, "number" | "status" | "wordCount" | "auditIssues">>,
  ): {
    readonly bookId: string;
    readonly totalChapters: number;
    readonly totalWords: number;
    readonly avgWordsPerChapter: number;
    readonly auditPassRate: number;
    readonly topIssueCategories: ReadonlyArray<{ readonly category: string; readonly count: number }>;
    readonly chaptersWithMostIssues: ReadonlyArray<{ readonly chapter: number; readonly issueCount: number }>;
    readonly statusDistribution: Record<string, number>;
  } {
    const totalChapters = chapters.length;
    const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);
    const avgWordsPerChapter = totalChapters > 0 ? Math.round(totalWords / totalChapters) : 0;
    const passedStatuses = new Set(["ready-for-review", "approved", "published"]);
    const audited = chapters.filter((chapter) => !["drafted", "drafting", "card-generated"].includes(chapter.status));
    const passed = audited.filter((chapter) => passedStatuses.has(chapter.status));
    const auditPassRate = audited.length > 0 ? Math.round((passed.length / audited.length) * 100) : 100;

    const categoryCounts = new Map<string, number>();
    for (const chapter of chapters) {
      for (const issue of chapter.auditIssues) {
        const match = issue.match(/\[(?:critical|warning|info)\]\s*(.+?)[:：]/);
        const category = match?.[1] ?? "未分类";
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      }
    }
    const topIssueCategories = [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([category, count]) => ({ category, count }));

    const chaptersWithMostIssues = [...chapters]
      .filter((chapter) => chapter.auditIssues.length > 0)
      .sort((a, b) => b.auditIssues.length - a.auditIssues.length)
      .slice(0, 5)
      .map((chapter) => ({ chapter: chapter.number, issueCount: chapter.auditIssues.length }));

    const statusDistribution: Record<string, number> = {};
    for (const chapter of chapters) {
      statusDistribution[chapter.status] = (statusDistribution[chapter.status] ?? 0) + 1;
    }

    return {
      bookId,
      totalChapters,
      totalWords,
      avgWordsPerChapter,
      auditPassRate,
      topIssueCategories,
      chaptersWithMostIssues,
      statusDistribution,
    };
  }

  async function findChapterFile(bookDir: string, chapterNumber: number, preferredTitle?: string): Promise<string> {
    const chaptersDir = join(bookDir, "chapters");
    const resolved = await resolveChapterFile(chaptersDir, chapterNumber, preferredTitle);
    if (resolved.duplicates.length > 0) {
      logInfo("chapter.file.multiple_matches", {
        chapterNumber,
        bookDir,
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
    return resolved.selected.fullPath;
  }

  async function loadChapterIndexWithRealtimeWords(state: StateManager, bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    const bookDir = state.bookDir(bookId);
    const index = await state.loadChapterIndex(bookId);
    let changed = false;

    const merged = await Promise.all(
      index.map(async (chapter) => {
        try {
          const chapterFile = await findChapterFile(bookDir, chapter.number, chapter.title);
          const raw = await readFile(chapterFile, "utf-8");
          const content = raw.split("\n").slice(2).join("\n");
          const realtimeWords = countNovelWords(content);
          if (realtimeWords !== chapter.wordCount) {
            changed = true;
            return {
              ...chapter,
              wordCount: realtimeWords,
              updatedAt: new Date().toISOString(),
            };
          }
        } catch {
          // Keep original index value if file is missing/unreadable.
        }
        return chapter;
      }),
    );

    if (changed) {
      await state.saveChapterIndex(bookId, merged);
      logInfo("chapter.index.words.resynced", {
        bookId,
        chapters: merged.length,
      });
    }

    return merged;
  }

  function normalizeWordCountLikeWawa(text: string): number {
    if (!text) return 0;
    try {
      const matches = text.match(/[\p{Script=Han}]|[\p{L}]+|[\p{N}]+|[^\p{Script=Han}\p{L}\p{N}\s]+/gu);
      return matches ? matches.length : 0;
    } catch {
      const matches = text.match(/[\u4E00-\u9FFF]|[A-Za-z]+|\d+|[^\u4E00-\u9FFFA-Za-z\d\s]+/g);
      return matches ? matches.length : 0;
    }
  }

  async function loadChapterIndexWithRealtimeWordsWawa(state: StateManager, bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    const bookDir = state.bookDir(bookId);
    const index = await state.loadChapterIndex(bookId);
    let changed = false;

    const merged = await Promise.all(
      index.map(async (chapter) => {
        try {
          const chapterFile = await findChapterFile(bookDir, chapter.number, chapter.title);
          const raw = await readFile(chapterFile, "utf-8");
          const content = raw.split("\n").slice(2).join("\n");
          const realtimeWords = normalizeWordCountLikeWawa(content);
          if (realtimeWords !== chapter.wordCount) {
            changed = true;
            return {
              ...chapter,
              wordCount: realtimeWords,
              updatedAt: new Date().toISOString(),
            };
          }
        } catch {
          // Keep original index value if file is missing/unreadable.
        }
        return chapter;
      }),
    );

    if (changed) {
      await state.saveChapterIndex(bookId, merged);
      logInfo("chapter.index.words.resynced", {
        bookId,
        chapters: merged.length,
        counter: "wawa-like",
      });
    }

    return merged;
  }

  const loadChapterIndexForStats = loadChapterIndexWithRealtimeWordsWawa;

  function computeBookStatusFromIndex(
    book: {
      title: string;
      genre: string;
      platform: string;
      status: string;
    },
    bookId: string,
    chapters: ReadonlyArray<ChapterMeta>,
  ) {
    const totalWords = chapters.reduce((sum, ch) => sum + ch.wordCount, 0);
    const maxChapter = chapters.reduce((max, ch) => Math.max(max, ch.number), 0);
    return {
      bookId,
      title: book.title,
      genre: book.genre,
      platform: book.platform,
      status: book.status,
      chaptersWritten: chapters.length,
      totalWords,
      nextChapter: maxChapter + 1,
      chapters: [...chapters],
    };
  }

  function chapterCellMatches(cell: string, chapterNumber: number): boolean {
    const normalized = cell.trim();
    return (
      normalized === String(chapterNumber)
      || normalized === `Ch.${chapterNumber}`
      || normalized === `第${chapterNumber}章`
      || normalized === `第${chapterNumber}`
    );
  }

  function removeChapterRowsFromMarkdownTable(content: string, chapterNumber: number): string {
    const lines = content.split("\n");
    const filtered = lines.filter((line) => {
      if (!line.trim().startsWith("|")) return true;
      const cells = line.split("|").map((cell) => cell.trim());
      if (cells.length < 3) return true;
      const firstCell = cells[1] ?? "";
      const secondCell = cells[2] ?? "";
      if (chapterCellMatches(firstCell, chapterNumber) || chapterCellMatches(secondCell, chapterNumber)) {
        return false;
      }
      return true;
    });
    return `${filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  }

  async function cleanupStoryFilesAfterChapterDelete(
    bookDir: string,
    chapterNumber: number,
    chapters: ReadonlyArray<ChapterMeta>,
  ): Promise<void> {
    const storyDir = join(bookDir, "story");
    const filesToClean = [
      "chapter_summaries.md",
      "subplot_board.md",
      "emotional_arcs.md",
      "character_matrix.md",
      "pending_hooks.md",
    ];

    for (const file of filesToClean) {
      const filePath = join(storyDir, file);
      try {
        const raw = await readFile(filePath, "utf-8");
        const cleaned = removeChapterRowsFromMarkdownTable(raw, chapterNumber);
        if (cleaned !== raw) {
          await writeFile(filePath, cleaned, "utf-8");
        }
      } catch {
        // ignore missing/unreadable files
      }
    }

    const currentStatePath = join(storyDir, "current_state.md");
    try {
      const maxChapter = chapters.reduce((max, item) => Math.max(max, item.number), 0);
      const nextChapter = maxChapter + 1;
      const completed = chapters.length;
      const currentStateRaw = await readFile(currentStatePath, "utf-8");
      let nextState = currentStateRaw
        .replace(/(\|\s*当前章节\s*\|\s*)([^|]*)(\|)/, `$1${maxChapter}$3`)
        .replace(/(\|\s*下一章\s*\|\s*)([^|]*)(\|)/, `$1${nextChapter}（待写作）$3`)
        .replace(/(\|\s*已完成\s*\|\s*)([^|]*)(\|)/, `$1${completed}章$3`);

      const totalMatch = currentStateRaw.match(/\|\s*总规划\s*\|\s*(\d+)章?\s*\|/);
      if (totalMatch) {
        const total = Number.parseInt(totalMatch[1] ?? "0", 10);
        if (Number.isFinite(total) && total > 0) {
          const remaining = Math.max(total - completed, 0);
          nextState = nextState.replace(/(\|\s*待写作\s*\|\s*)([^|]*)(\|)/, `$1${remaining}章$3`);
        }
      }

      if (nextState !== currentStateRaw) {
        await writeFile(currentStatePath, nextState, "utf-8");
      }
    } catch {
      // ignore missing/unreadable current_state
    }
  }

  async function recalcChapterWordCounts(
    state: StateManager,
    bookId: string,
    chapters: ReadonlyArray<ChapterMeta>,
  ): Promise<ReadonlyArray<ChapterMeta>> {
    const bookDir = state.bookDir(bookId);
    const updated = await Promise.all(
      chapters.map(async (chapter) => {
        try {
          const chapterFile = await findChapterFile(bookDir, chapter.number, chapter.title);
          const raw = await readFile(chapterFile, "utf-8");
          const content = raw.split("\n").slice(2).join("\n");
          const wordCount = normalizeWordCountLikeWawa(content);
          if (wordCount !== chapter.wordCount) {
            return {
              ...chapter,
              wordCount,
              updatedAt: new Date().toISOString(),
            };
          }
        } catch {
          // keep original
        }
        return chapter;
      }),
    );
    return updated;
  }

  async function initializeBookSkeleton(bookId: string): Promise<void> {
    const storyDir = join(projectRoot, "books", bookId, "story");
    await mkdir(storyDir, { recursive: true });
    await Promise.all([
      writeFile(join(storyDir, "story_bible.md"), "# 故事圣经\n\n（快速初始化占位，后续写作会逐步完善）\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# 卷纲\n\n（快速初始化占位）\n", "utf-8"),
      writeFile(
        join(storyDir, "book_rules.md"),
        [
          "---",
          "version: \"1.0\"",
          "protagonist:",
          "  name: \"未命名主角\"",
          "  personalityLock: []",
          "  behavioralConstraints: []",
          "genreLock:",
          "  primary: other",
          "  forbidden: []",
          "prohibitions: []",
          "chapterTypesOverride: []",
          "fatigueWordsOverride: []",
          "additionalAuditDimensions: []",
          "enableFullCastTracking: false",
          "---",
          "",
          "## 叙事视角",
          "第一人称/第三人称按章节需要确定。",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# 当前状态\n\n| 字段 | 值 |\n|------|-----|\n| 当前章节 | 0 |\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n\n| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |\n|--------|----------|------|------|----------|----------|------|\n", "utf-8"),
      writeFile(join(storyDir, "particle_ledger.md"), "# 资源账本\n\n| 章节 | 期初值 | 来源 | 完整度 | 增量 | 期末值 | 依据 |\n|------|--------|------|--------|------|--------|------|\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# 章节摘要\n\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线进度板\n\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感弧线\n\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 角色交互矩阵\n\n", "utf-8"),
    ]);
  }

  function storyDirPath(bookId: string): string {
    return join(projectRoot, "books", bookId, "story");
  }

  function storyFilePath(bookId: string, filename: string): string {
    return join(storyDirPath(bookId), filename);
  }

  function authorBriefPath(bookId: string): string {
    return storyFilePath(bookId, "author_brief.md");
  }

  async function readAuthorBrief(bookId: string): Promise<string> {
    try {
      return await readFile(authorBriefPath(bookId), "utf-8");
    } catch {
      return "";
    }
  }

  async function readStoryFile(bookId: string, filename: string): Promise<string> {
    try {
      return await readFile(storyFilePath(bookId, filename), "utf-8");
    } catch {
      return "";
    }
  }

  async function writeAuthorBrief(bookId: string, content: string): Promise<void> {
    if (!content.trim()) return;
    await mkdir(dirname(authorBriefPath(bookId)), { recursive: true });
    await writeFile(authorBriefPath(bookId), content.trimEnd() + "\n", "utf-8");
  }

  function composeInitContext(context?: string, authorBrief?: string): string | undefined {
    const sections = [
      context?.trim() ? `## 作者补充约束\n${context.trim()}` : "",
      authorBrief?.trim() ? `## 作者创作简报\n${authorBrief.trim()}` : "",
    ].filter(Boolean);

    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }

  async function buildBookDirectorySummary(bookDir: string): Promise<string> {
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    const snapshotsDir = join(storyDir, "snapshots");

    const storyEntries = await readdir(storyDir, { withFileTypes: true }).catch(() => []);
    const storyFiles = storyEntries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    const chapterEntries = await readdir(chaptersDir).catch(() => []);
    const chapterMdFiles = chapterEntries.filter((file) => file.endsWith(".md") && !file.startsWith("index")).sort();

    const snapshotEntries = await readdir(snapshotsDir, { withFileTypes: true }).catch(() => []);
    const snapshotDirs = snapshotEntries.filter((entry) => entry.isDirectory());

    const lines = ["## 本书目录概览"];
    if (storyFiles.length > 0) {
      lines.push(`- story/ 下文件：${storyFiles.join("、")}`);
    }
    if (chapterMdFiles.length > 0) {
      const first = chapterMdFiles[0]!.slice(0, 4);
      const last = chapterMdFiles[chapterMdFiles.length - 1]!.slice(0, 4);
      lines.push(`- chapters/ 下共 ${chapterMdFiles.length} 个章节文件（${first} ~ ${last}）`);
    } else {
      lines.push("- chapters/ 下暂无章节文件");
    }
    if (snapshotDirs.length > 0) {
      lines.push(`- snapshots/ 下共 ${snapshotDirs.length} 个快照目录`);
    }
    lines.push("如需查看具体文件列表，请调用 list_directory 工具。");
    return lines.join("\n");
  }

  function mergeAuthorBrief(context?: string, authorBrief?: string): string | undefined {
    const sections = [
      context?.trim() ? `## 长期创作约束\n${context.trim()}` : "",
      authorBrief?.trim() ? authorBrief.trim() : "",
    ].filter(Boolean);

    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }

  async function buildExistingBookContext(bookId: string): Promise<{
    readonly pathBlock: string;
    readonly allPathsBlock: string;
    readonly memoryBlock: string;
  }> {
    const state = new StateManager(projectRoot);
    const bookDir = state.bookDir(bookId);
    const chapterIndex = await state.loadChapterIndex(bookId);
    const directorySummary = await buildBookDirectorySummary(bookDir);
    const latestChapter = [...chapterIndex].sort((left, right) => right.number - left.number)[0];
    const latestChapterFile = latestChapter
      ? await findChapterFile(bookDir, latestChapter.number, latestChapter.title).catch(() => "")
      : "";

    const [authorBrief, currentState, pendingHooks, chapterSummaries] = await Promise.all([
      readAuthorBrief(bookId),
      readStoryFile(bookId, "current_state.md"),
      readStoryFile(bookId, "pending_hooks.md"),
      readStoryFile(bookId, "chapter_summaries.md"),
    ]);

    const pathBlock = [
      "## 当前书籍项目路径",
      `- bookId：${bookId}`,
      `- 书籍目录：${bookDir}`,
      `- story 目录：${storyDirPath(bookId)}`,
      `- 作者简报：${authorBriefPath(bookId)}`,
      `- 状态卡：${storyFilePath(bookId, "current_state.md")}`,
      `- 伏笔池：${storyFilePath(bookId, "pending_hooks.md")}`,
      `- 章节摘要：${storyFilePath(bookId, "chapter_summaries.md")}`,
      `- 支线进度板：${storyFilePath(bookId, "subplot_board.md")}`,
      `- 情感弧线：${storyFilePath(bookId, "emotional_arcs.md")}`,
      `- 角色矩阵：${storyFilePath(bookId, "character_matrix.md")}`,
      latestChapter
        ? `- 最新章节文件：${latestChapterFile || `第${latestChapter.number}章文件解析失败`}`
        : "- 最新章节文件：（暂无）",
      `- 已有章节数：${chapterIndex.length}`,
      latestChapter ? `- 最近章节：第${latestChapter.number}章 ${latestChapter.title}` : "- 最近章节：（暂无）",
      "这是一本已经存在的书，请优先在这些已有资料基础上补强，不要把它当成全新开书。",
    ].join("\n");

    const allPathsBlock = directorySummary;

    const memoryBlock = [
      authorBrief.trim() ? `## 已有作者简报（${authorBriefPath(bookId)}）\n${authorBrief.trim()}` : "",
      currentState.trim() ? `## 当前状态卡（${storyFilePath(bookId, "current_state.md")}）\n${currentState.trim()}` : "",
      pendingHooks.trim() ? `## 当前伏笔池（${storyFilePath(bookId, "pending_hooks.md")}）\n${pendingHooks.trim().slice(-2500)}` : "",
      chapterSummaries.trim() ? `## 章节摘要（${storyFilePath(bookId, "chapter_summaries.md")}）\n${chapterSummaries.trim().slice(-3500)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    return { pathBlock, allPathsBlock, memoryBlock };
  }

  return {
    authorBriefPath,
    buildExistingBookContext,
    cleanupStoryFilesAfterChapterDelete,
    composeInitContext,
    computeAnalytics,
    computeBookStatusFromIndex,
    findChapterFile,
    initializeBookSkeleton,
    loadChapterIndexForStats,
    mergeAuthorBrief,
    readAuthorBrief,
    readStoryFile,
    recalcChapterWordCounts,
    storyDirPath,
    storyFilePath,
    writeAuthorBrief,
  };
}
