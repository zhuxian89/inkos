/**
 * Extract a tagged section from LLM output.
 * Handles `===`, `==`, `====` and extra whitespace around tag names.
 * Uses `\n` anchor for the next-tag lookahead to avoid partial matches.
 */
export function extractTag(tag: string, content: string): string {
  const regex = new RegExp(
    `={2,}\\s*${tag}\\s*={2,}([\\s\\S]*?)(?=\\n={2,}\\s*[A-Z_]+\\s*={2,}|$)`,
  );
  const match = content.match(regex);
  return match?.[1]?.trim() ?? "";
}
