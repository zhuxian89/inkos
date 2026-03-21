import { describe, it, expect } from "vitest";
import { truncateMarkdownTable } from "../utils/truncate.js";

describe("truncateMarkdownTable", () => {
  const header = "| 章节 | 标题 | 关键事件 |\n|------|------|----------|\n";

  function buildTable(rowCount: number): string {
    const rows = Array.from({ length: rowCount }, (_, i) =>
      `| ${i + 1} | 第${i + 1}章 | 事件${i + 1} |`,
    );
    return header + rows.join("\n") + "\n";
  }

  it("returns content unchanged when rows <= maxRows", () => {
    const table = buildTable(5);
    expect(truncateMarkdownTable(table, 10)).toBe(table);
  });

  it("returns content unchanged when rows === maxRows", () => {
    const table = buildTable(10);
    expect(truncateMarkdownTable(table, 10)).toBe(table);
  });

  it("truncates and keeps last maxRows when rows > maxRows", () => {
    const table = buildTable(15);
    const result = truncateMarkdownTable(table, 5);
    const lines = result.split("\n");

    // Header (2 lines) + ellipsis (1) + data (5) + trailing empty = 9
    expect(lines[0]).toContain("章节");
    expect(lines[1]).toContain("---");
    expect(lines[2]).toContain("已省略早期 10 条记录");
    // Last 5 rows should be rows 11-15
    expect(lines[3]).toContain("| 11 |");
    expect(lines[7]).toContain("| 15 |");
  });

  it("returns plain text unchanged", () => {
    const text = "这是一段普通文本\n没有表格\n第三行";
    expect(truncateMarkdownTable(text, 5)).toBe(text);
  });

  it("handles mixed content: text before and after table", () => {
    const content = `# 标题\n\n${buildTable(8)}一些后续文字\n`;
    const result = truncateMarkdownTable(content, 3);

    expect(result).toContain("# 标题");
    expect(result).toContain("已省略早期 5 条记录");
    expect(result).toContain("| 6 |");
    expect(result).toContain("| 8 |");
    expect(result).toContain("一些后续文字");
    // Should not contain early rows
    expect(result).not.toContain("| 1 |");
  });

  it("handles empty input", () => {
    expect(truncateMarkdownTable("", 10)).toBe("");
  });

  it("preserves ellipsis column count matching header", () => {
    const table = "| A | B | C | D |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n| 5 | 6 | 7 | 8 |\n| 9 | 10 | 11 | 12 |\n";
    const result = truncateMarkdownTable(table, 1);
    const ellipsisLine = result.split("\n").find(l => l.includes("已省略"));
    expect(ellipsisLine).toBeDefined();
    // Should have 4 cells (matching A|B|C|D)
    const cells = ellipsisLine!.split("|").filter(c => c.trim().length > 0);
    expect(cells.length).toBe(4);
  });

  it("handles table with no data rows", () => {
    const table = "| A | B |\n|---|---|\n";
    expect(truncateMarkdownTable(table, 5)).toBe(table);
  });
});
