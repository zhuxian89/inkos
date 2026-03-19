import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChapterFilename, extractChapterBody, resolveChapterFile, writeCanonicalChapterFile } from "../utils/chapter-files.js";

describe("chapter file utils", () => {
  let tempDir: string;
  let chaptersDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "inkos-chapter-files-"));
    chaptersDir = join(tempDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("prefers the canonical title match when duplicate chapter files exist", async () => {
    await writeFile(
      join(chaptersDir, "0002_陶管与雪.md"),
      "# 第2章 雪盐与柴刀\n\n短内容",
      "utf-8",
    );
    await writeFile(
      join(chaptersDir, "0002_雪盐与柴刀.md"),
      "# 第2章 雪盐与柴刀\n\n这是更完整的正文内容，长度明显更长。",
      "utf-8",
    );

    const resolved = await resolveChapterFile(chaptersDir, 2, "雪盐与柴刀");
    expect(resolved.selected.file).toBe("0002_雪盐与柴刀.md");
    expect(resolved.duplicates.map((item) => item.file)).toContain("0002_陶管与雪.md");
  });

  it("removes stale duplicates when writing the canonical chapter file", async () => {
    await writeFile(join(chaptersDir, "0002_旧稿.md"), "# 第2章 旧稿\n\n旧内容", "utf-8");
    await writeFile(join(chaptersDir, "0002_空白.md"), "", "utf-8");

    const result = await writeCanonicalChapterFile({
      chaptersDir,
      chapterNumber: 2,
      title: "雪盐与柴刀",
      body: "这是修复后的正文。",
      trailingNewline: true,
    });

    expect(result.filename).toBe(buildChapterFilename(2, "雪盐与柴刀"));
    expect([...result.removedDuplicates].sort()).toEqual(["0002_旧稿.md", "0002_空白.md"].sort());
    expect(await readdir(chaptersDir)).toEqual([buildChapterFilename(2, "雪盐与柴刀")]);
    expect(await readFile(result.fullPath, "utf-8")).toBe("# 第2章 雪盐与柴刀\n\n这是修复后的正文。\n");
  });

  it("extracts chapter body after the heading block", () => {
    const raw = "# 第2章 雪盐与柴刀\n\n第一段\n第二段";
    expect(extractChapterBody(raw)).toBe("第一段\n第二段");
  });
});
