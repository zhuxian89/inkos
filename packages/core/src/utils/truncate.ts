/**
 * Truncate markdown tables to keep header + last N data rows.
 * Non-table content is preserved as-is.
 */
export function truncateMarkdownTable(content: string, maxRows: number): string {
  if (!content) return content;

  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Detect start of a markdown table: a line starting with `|` followed by a separator line
    if (line.trimStart().startsWith("|") && i + 1 < lines.length && isSeparatorLine(lines[i + 1]!)) {
      // Collect the full table
      const headerLine = line;
      const separatorLine = lines[i + 1]!;
      i += 2;

      const dataRows: string[] = [];
      while (i < lines.length && lines[i]!.trimStart().startsWith("|") && !isSeparatorLine(lines[i]!)) {
        dataRows.push(lines[i]!);
        i++;
      }

      // Emit header
      result.push(headerLine);
      result.push(separatorLine);

      if (dataRows.length > maxRows) {
        const dropped = dataRows.length - maxRows;
        // Build an ellipsis row matching the table column count
        const colCount = headerLine.split("|").length - 2; // -2 for leading/trailing empty splits
        const ellipsisCells = Array.from({ length: Math.max(colCount, 1) }, (_, idx) =>
          idx === 0 ? ` ... (已省略早期 ${dropped} 条记录) ` : " ... ",
        );
        result.push(`|${ellipsisCells.join("|")}|`);
        // Keep only the last maxRows
        for (const row of dataRows.slice(-maxRows)) {
          result.push(row);
        }
      } else {
        for (const row of dataRows) {
          result.push(row);
        }
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join("\n");
}

function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  // A separator line looks like |---|---|---| or | --- | --- |
  return trimmed.startsWith("|") && /^\|[\s:]*-{2,}[\s:]*\|/.test(trimmed);
}
