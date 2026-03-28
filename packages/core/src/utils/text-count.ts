/**
 * Count text units for novel "字数" display.
 *
 * Rule (aligned with https://www.iamwawa.cn/zishu.html style):
 * - Each Han character counts as 1.
 * - Each contiguous Latin-letter run counts as 1.
 * - Each contiguous number run counts as 1.
 * - Each contiguous symbol/punctuation run counts as 1.
 */
export function countNovelWords(text: string): number {
  if (!text) return 0;
  try {
    const matches = text.match(/[\p{Script=Han}]|[\p{L}]+|[\p{N}]+|[^\p{Script=Han}\p{L}\p{N}\s]+/gu);
    return matches ? matches.length : 0;
  } catch {
    const matches = text.match(/[\u4E00-\u9FFF]|[A-Za-z]+|\d+|[^\u4E00-\u9FFFA-Za-z\d\s]+/g);
    return matches ? matches.length : 0;
  }
}

