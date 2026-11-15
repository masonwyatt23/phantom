/** Exact short ideation-plan asks; longer requests stay with the Leader. */
export function isIdeationAsk(text: string): boolean {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > 40) return false;
  const ask = trimmed.toLowerCase().replace(/’/g, "'").replace(/[?.!]+$/, '').trim();
  return /^(?:ideation|ideas|strategy|latest ideation)$/.test(ask);
}
