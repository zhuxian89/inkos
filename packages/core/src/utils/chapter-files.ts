import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ChapterFileCandidate {
  readonly file: string;
  readonly fullPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly headingTitle: string;
}

export interface ResolvedChapterFile {
  readonly selected: ChapterFileCandidate;
  readonly candidates: ReadonlyArray<ChapterFileCandidate>;
  readonly duplicates: ReadonlyArray<ChapterFileCandidate>;
}

export function sanitizeChapterTitle(title: string): string {
  return title
    .replace(/[/\\?%*:|"<>]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 50);
}

export function buildChapterFilename(chapterNumber: number, title: string): string {
  const paddedNum = String(chapterNumber).padStart(4, "0");
  return `${paddedNum}_${sanitizeChapterTitle(title)}.md`;
}

function chapterPrefix(chapterNumber: number): string {
  return `${String(chapterNumber).padStart(4, "0")}_`;
}

function extractHeadingTitle(raw: string, chapterNumber: number): string {
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine
    .replace(/^#\s*/, "")
    .replace(new RegExp(`^第${chapterNumber}章\\s*`), "")
    .replace(/^第\d+章\s*/, "")
    .trim();
}

function comparableTitle(title: string): string {
  return sanitizeChapterTitle(title).toLowerCase();
}

function candidateScore(candidate: ChapterFileCandidate, preferredTitle?: string): number {
  let score = 0;
  const preferred = preferredTitle?.trim() ? comparableTitle(preferredTitle) : "";
  const filenameTitle = candidate.file.replace(/^\d{4}_/, "").replace(/\.md$/i, "");
  const headingTitle = candidate.headingTitle ? comparableTitle(candidate.headingTitle) : "";

  if (preferred) {
    if (filenameTitle.toLowerCase() === preferred) score += 1_000;
    if (headingTitle === preferred) score += 800;
  }
  if (candidate.size > 0) score += 100;
  return score;
}

export async function resolveChapterFile(
  chaptersDir: string,
  chapterNumber: number,
  preferredTitle?: string,
): Promise<ResolvedChapterFile> {
  const matches = (await readdir(chaptersDir))
    .filter((file) => file.startsWith(chapterPrefix(chapterNumber)) && file.endsWith(".md"));

  if (matches.length === 0) {
    throw new Error(`Chapter file not found for chapter ${chapterNumber} in ${chaptersDir}`);
  }

  const candidates = await Promise.all(
    matches.map(async (file) => {
      const fullPath = join(chaptersDir, file);
      const info = await stat(fullPath);
      let headingTitle = "";
      if (info.size > 0) {
        try {
          headingTitle = extractHeadingTitle(await readFile(fullPath, "utf-8"), chapterNumber);
        } catch {
          headingTitle = "";
        }
      }
      return {
        file,
        fullPath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        headingTitle,
      } satisfies ChapterFileCandidate;
    }),
  );

  candidates.sort((left, right) => {
    const scoreDiff = candidateScore(right, preferredTitle) - candidateScore(left, preferredTitle);
    if (scoreDiff !== 0) return scoreDiff;
    if (left.size !== right.size) return right.size - left.size;
    if (left.mtimeMs !== right.mtimeMs) return right.mtimeMs - left.mtimeMs;
    return left.file.localeCompare(right.file);
  });

  const [selected, ...duplicates] = candidates;
  if (!selected) {
    throw new Error(`Chapter file not found for chapter ${chapterNumber} in ${chaptersDir}`);
  }
  return { selected, candidates, duplicates };
}

export async function writeCanonicalChapterFile(input: {
  readonly chaptersDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly body: string;
  readonly trailingNewline?: boolean;
}): Promise<{
  readonly filename: string;
  readonly fullPath: string;
  readonly removedDuplicates: ReadonlyArray<string>;
}> {
  await mkdir(input.chaptersDir, { recursive: true });

  const filename = buildChapterFilename(input.chapterNumber, input.title);
  const fullPath = join(input.chaptersDir, filename);
  const content = [
    `# 第${input.chapterNumber}章 ${input.title}`,
    "",
    input.body,
  ].join("\n") + (input.trailingNewline ? "\n" : "");

  await writeFile(fullPath, content, "utf-8");

  const removedDuplicates = (await readdir(input.chaptersDir))
    .filter((file) => file.startsWith(chapterPrefix(input.chapterNumber)) && file.endsWith(".md") && file !== filename);

  await Promise.all(
    removedDuplicates.map((file) => rm(join(input.chaptersDir, file), { force: true })),
  );

  return { filename, fullPath, removedDuplicates };
}

export function extractChapterBody(raw: string): string {
  const lines = raw.split("\n");
  const contentStart = lines.findIndex((line, index) => index > 0 && line.trim().length > 0);
  return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
}
