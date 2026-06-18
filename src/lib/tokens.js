export function estimateTokens(text) {
  if (!text) return 0;
  const latinWords = text.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)?/g) || [];
  const cjkChars = text.match(/[\u3400-\u9fff]/g) || [];
  const other = Math.ceil(text.replace(/[A-Za-z0-9_\s\u3400-\u9fff'-]/g, '').length / 3);
  return latinWords.length + cjkChars.length + other;
}
