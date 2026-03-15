import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";

export class StateManager {
  constructor(private readonly projectRoot: string) {}

  async acquireBookLock(bookId: string): Promise<() => Promise<void>> {
    const bookDir = this.bookDir(bookId);
    await mkdir(bookDir, { recursive: true });
    const lockPath = join(bookDir, ".write.lock");

    const release = async () => {
      try {
        await unlink(lockPath);
      } catch {
        // ignore
      }
    };

    const lockContent = () => `pid:${process.pid} ts:${Date.now()}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(lockPath, lockContent(), { encoding: "utf-8", flag: "wx" });
        return release;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "EEXIST") {
          throw error;
        }

        let lockData = "";
        try {
          lockData = await readFile(lockPath, "utf-8");
        } catch (readError) {
          const readCode = (readError as NodeJS.ErrnoException | undefined)?.code;
          if (readCode === "ENOENT") continue; // raced with unlock; retry
          throw readError;
        }

        const pidMatch = lockData.match(/pid:(\d+)/);
        if (pidMatch) {
          const lockPid = parseInt(pidMatch[1]!, 10);
          try {
            process.kill(lockPid, 0);
          } catch (killError) {
            const killCode = (killError as NodeJS.ErrnoException | undefined)?.code;
            if (killCode === "ESRCH") {
              // Stale lock: process is gone
              try {
                await unlink(lockPath);
              } catch {
                // ignore, retry will handle races
              }
              continue;
            }
          }
        }

        throw new Error(
          `Book "${bookId}" is locked by another process (${lockData}). ` +
            `If this is stale, delete ${lockPath}`,
        );
      }
    }

    throw new Error(`Failed to acquire lock for book "${bookId}" (${lockPath})`);
  }

  get booksDir(): string {
    return join(this.projectRoot, "books");
  }

  bookDir(bookId: string): string {
    return join(this.booksDir, bookId);
  }

  async loadProjectConfig(): Promise<Record<string, unknown>> {
    const configPath = join(this.projectRoot, "inkos.json");
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  }

  async saveProjectConfig(config: Record<string, unknown>): Promise<void> {
    const configPath = join(this.projectRoot, "inkos.json");
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  async loadBookConfig(bookId: string): Promise<BookConfig> {
    const configPath = join(this.bookDir(bookId), "book.json");
    const raw = await readFile(configPath, "utf-8");
    if (!raw.trim()) {
      throw new Error(`book.json is empty for book "${bookId}"`);
    }
    return JSON.parse(raw) as BookConfig;
  }

  async saveBookConfig(bookId: string, config: BookConfig): Promise<void> {
    const dir = this.bookDir(bookId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "book.json"),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
  }

  async listBooks(): Promise<ReadonlyArray<string>> {
    try {
      const entries = await readdir(this.booksDir);
      const bookIds: string[] = [];
      for (const entry of entries) {
        const bookJsonPath = join(this.booksDir, entry, "book.json");
        try {
          await stat(bookJsonPath);
          bookIds.push(entry);
        } catch {
          // not a book directory
        }
      }
      return bookIds;
    } catch {
      return [];
    }
  }

  async getNextChapterNumber(bookId: string): Promise<number> {
    const index = await this.loadChapterIndex(bookId);
    if (index.length === 0) return 1;
    const maxNum = Math.max(...index.map((ch) => ch.number));
    return maxNum + 1;
  }

  async loadChapterIndex(bookId: string): Promise<ReadonlyArray<ChapterMeta>> {
    const indexPath = join(this.bookDir(bookId), "chapters", "index.json");
    try {
      const raw = await readFile(indexPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async saveChapterIndex(
    bookId: string,
    index: ReadonlyArray<ChapterMeta>,
  ): Promise<void> {
    const chaptersDir = join(this.bookDir(bookId), "chapters");
    await mkdir(chaptersDir, { recursive: true });
    await writeFile(
      join(chaptersDir, "index.json"),
      JSON.stringify(index, null, 2),
      "utf-8",
    );
  }

  async snapshotState(bookId: string, chapterNumber: number): Promise<void> {
    const storyDir = join(this.bookDir(bookId), "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));
    await mkdir(snapshotDir, { recursive: true });

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    await Promise.all(
      files.map(async (f) => {
        try {
          const content = await readFile(join(storyDir, f), "utf-8");
          await writeFile(join(snapshotDir, f), content, "utf-8");
        } catch {
          // file doesn't exist yet
        }
      }),
    );
  }

  async restoreState(bookId: string, chapterNumber: number): Promise<boolean> {
    const storyDir = join(this.bookDir(bookId), "story");
    const snapshotDir = join(storyDir, "snapshots", String(chapterNumber));

    const files = [
      "current_state.md", "particle_ledger.md", "pending_hooks.md",
      "chapter_summaries.md", "subplot_board.md", "emotional_arcs.md", "character_matrix.md",
    ];
    try {
      // The first 3 files are required; the rest are optional (may not exist in older snapshots)
      const requiredFiles = files.slice(0, 3);
      const optionalFiles = files.slice(3);

      await Promise.all(
        requiredFiles.map(async (f) => {
          const content = await readFile(join(snapshotDir, f), "utf-8");
          await writeFile(join(storyDir, f), content, "utf-8");
        }),
      );

      await Promise.all(
        optionalFiles.map(async (f) => {
          try {
            const content = await readFile(join(snapshotDir, f), "utf-8");
            await writeFile(join(storyDir, f), content, "utf-8");
          } catch {
            // Optional file missing in older snapshots — skip
          }
        }),
      );

      return true;
    } catch {
      return false;
    }
  }
}
