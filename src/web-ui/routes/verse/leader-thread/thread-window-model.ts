export const THREAD_WINDOW_STEP = 200;

/** Keep the newest rows and the day heading for the first retained row. */
export function windowItems<T extends { type: string; key: string }>(items: T[], limit: number): { shown: T[]; hidden: number } {
  const total = items.filter(item => item.type !== 'day').length;
  const count = Math.min(total, Math.max(0, Math.floor(limit)));
  if (count === 0) return { shown: [], hidden: total };
  let remaining = count;
  let start = items.length;
  while (start > 0 && remaining > 0) {
    start--;
    if (items[start]!.type !== 'day') remaining--;
  }
  // The closest preceding separator heads this row, even when earlier rows
  // from that day have been omitted.
  for (let i = start - 1; i >= 0; i--) {
    if (items[i]!.type === 'day') {
      return { shown: [items[i]!, ...items.slice(start)], hidden: total - count };
    }
  }
  return { shown: items.slice(start), hidden: total - count };
}
