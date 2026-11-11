import { parseReadyTsv, type FleetLaneQueueRow } from './lane-console.js';

/** Read-only analysis. Queue order is used only to break ties in known timestamps. */
export function findQueueDupes(lines: string | readonly FleetLaneQueueRow[], now: number = Date.now()) {
  const rows = typeof lines === 'string' ? parseReadyTsv(lines).rows : [...lines];
  const ready = rows.filter(row => row.id && row.status === 'READY' && !row.pool.toUpperCase().startsWith('PARKED-'));
  const parent = ready.map((_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) i = parent[i]!; return i; };
  const keys = new Map<string, number>();
  for (const [i, row] of ready.entries()) {
    const goal = (row.title ?? '').toLowerCase().replace(/\bpass\s*\d*\s*$/i, '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
    const rowKeys = [`id\0${row.id}`];
    if (row.repo && goal) rowKeys.push(`goal\0${row.repo.toLowerCase()}\0${goal}`);
    for (const key of rowKeys) {
      const previous = keys.get(key);
      if (previous !== undefined) parent[root(i)] = root(previous);
      else keys.set(key, i);
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of ready.keys()) { const key = root(i); groups.set(key, [...(groups.get(key) ?? []), i]); }
  const dupGroups = [...groups.values()].filter(group => group.length > 1).map(group => {
    const dated = group.map(i => ({ i, at: Date.parse(ready[i]!.at ?? '') })).filter(entry => Number.isFinite(entry.at) && entry.at <= now);
    dated.sort((a, b) => a.at - b.at || a.i - b.i);
    return { ids: group.map(i => ready[i]!.id!), keep: dated.length === group.length ? ready[dated[0]!.i]!.id : null };
  });
  const stale = ready.flatMap(row => {
    const at = Date.parse(row.at ?? '');
    const ageMs = Number.isFinite(at) && at <= now ? now - at : null;
    return ageMs === null || ageMs > 86_400_000 ? [{ id: row.id!, ageMs }] : [];
  });
  return { dupGroups, stale };
}
