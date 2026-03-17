import { StateManager } from "@actalk/inkos-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectSummary {
  readonly projectRoot: string;
  readonly initialized: boolean;
  readonly config: Record<string, unknown> | null;
  readonly globalLlm: {
    readonly provider?: string;
    readonly baseUrl?: string;
    readonly model?: string;
    readonly apiKeyConfigured: boolean;
  } | null;
  readonly books: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly genre: string;
    readonly platform: string;
    readonly status: string;
    readonly chapters: number;
    readonly totalWords: number;
    readonly pendingReviews: number;
    readonly failedAudits: number;
  }>;
}

async function loadGlobalLlmConfig(): Promise<ProjectSummary["globalLlm"]> {
  try {
    const inkosHome = process.env.INKOS_HOME?.trim() || join(process.env.HOME ?? "/root", ".inkos");
    const raw = await readFile(join(inkosHome, ".env"), "utf-8");
    const entries = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        if (index <= 0) return null;
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        return [key, value] as const;
      })
      .filter((entry): entry is readonly [string, string] => entry !== null);
    const map = Object.fromEntries(entries);
    return {
      provider: map.INKOS_LLM_PROVIDER,
      baseUrl: map.INKOS_LLM_BASE_URL,
      model: map.INKOS_LLM_MODEL,
      apiKeyConfigured: Boolean(map.INKOS_LLM_API_KEY),
    };
  } catch {
    return null;
  }
}

export async function loadProjectSummary(projectRoot: string): Promise<ProjectSummary> {
  const state = new StateManager(projectRoot);
  const configPath = join(projectRoot, "inkos.json");
  const globalLlm = await loadGlobalLlmConfig();

  try {
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const bookIds = await state.listBooks();
    const books = await Promise.all(
      bookIds.map(async (bookId: string) => {
        const book = await state.loadBookConfig(bookId);
        const chapters = await state.loadChapterIndex(bookId);
        return {
          id: bookId,
          title: book.title,
          genre: book.genre,
          platform: book.platform,
          status: book.status,
          chapters: chapters.length,
          totalWords: chapters.reduce((sum: number, chapter) => sum + chapter.wordCount, 0),
          pendingReviews: chapters.filter((chapter) => chapter.status === "ready-for-review").length,
          failedAudits: chapters.filter((chapter) => chapter.status === "audit-failed").length,
        };
      }),
    );

    return {
      projectRoot,
      initialized: true,
      config,
      globalLlm,
      books,
    };
  } catch {
    return {
      projectRoot,
      initialized: false,
      config: null,
      globalLlm,
      books: [],
    };
  }
}
