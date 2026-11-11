export interface BelowLine { key: string; countable: boolean }

export function countNewBelow(lineKeys: readonly BelowLine[], lastSeenKey: string | null): number {
  if (lastSeenKey === null) return 0;
  const index = lineKeys.findIndex(line => line.key === lastSeenKey);
  return index < 0 ? 0 : lineKeys.slice(index + 1).filter(line => line.countable).length;
}

export function pillLabel(n: number): string {
  return `${n > 99 ? '99+' : n} new ${n === 1 ? 'message' : 'messages'}`;
}
