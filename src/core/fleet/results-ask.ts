/** Exact short results asks; longer requests stay in the Leader's inbox. */
export function isResultsAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:results|returns|verified|what's verified|what landed)$/.test(ask);
}
