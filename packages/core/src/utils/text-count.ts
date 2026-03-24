/**
 * Count text units for novel "字数" display.
 *
 * Rule (aligned with common online counters):
 * - Each Han character counts as 1.
 * - Each contiguous non-Han non-whitespace run counts as 1
 *   (e.g. an English word, a number run, or a punctuation run).
 */
export function countNovelWords(text: string): number {
  if (!text) return 0;
  try {
    const matches = text.match(/[\p{Script=Han}]|[^\p{Script=Han}\s]+/gu);
    return matches ? matches.length : 0;
  } catch {
    const matches = text.match(/[\u4E00-\u9FFF]|[^\u4E00-\u9FFF\s]+/g);
    return matches ? matches.length : 0;
  }
}

