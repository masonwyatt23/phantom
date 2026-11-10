/** Hourly merge observations shared by the CLI and console. */
export interface MergeGraphBucket { start: string; merges: number; medianSeconds: number | null }
export interface MergeGraphReport {
  schema: 'metrics.merges.v1'; known: boolean; windowHours: 24;
  lanes: { lane: string; buckets: MergeGraphBucket[] }[] | null;
}
const HOUR = 3_600_000;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const jobId = (row: Record<string, unknown>): string | null => text(row.job) ?? text(row.job_id) ?? text(row.jobId) ?? text(row.id);

/** MERGED is authoritative in state/outcome/status; reconciler rows keep publish-shaped event fields. */
function isMerged(row: Record<string, unknown>): boolean {
  const event = text(row.event);
  if (event === 'merged') return true;
  const state = [row.state, row.outcome, row.status].map(text).find((value): value is string => value !== null)?.toUpperCase();
  if (state !== 'MERGED') return false;
  if (!event || event === 'outcome') return true;
  return event === 'publish' && row.source === 'metrics-outcomes-reconciler';
}

export function mergeGraph(raw: string | null, now = Date.now()): MergeGraphReport {
  const base = { schema: 'metrics.merges.v1', windowHours: 24 } as const;
  if (raw === null) return { ...base, known: false, lanes: null };
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  const start = end - 24 * HOUR;
  const launches = new Map<string, { lane: string; at: number }[]>();
  const merges = new Map<string, { lane: string | null; at: number; seconds: number | null }>();
  for (const line of raw.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue; row = parsed as Record<string, unknown>; } catch { continue; }
    const id = jobId(row);
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (id === null || !Number.isFinite(at) || at > now) continue;
    const lane = text(row.lane);
    if (text(row.event) === 'launch' && lane !== null) {
      const attempts = launches.get(id) ?? [];
      attempts.push({ lane, at });
      launches.set(id, attempts);
    }
    if (!isMerged(row) || at < start || at >= end || at < (merges.get(id)?.at ?? -Infinity)) continue;
    const seconds = typeof row.ttm_s === 'number' && Number.isFinite(row.ttm_s) && row.ttm_s >= 0 ? row.ttm_s : null;
    merges.set(id, { lane, at, seconds });
  }
  const groups = new Map<string, { count: number; times: number[] }[]>();
  for (const [id, merge] of merges) {
    let launchLane: string | null = null;
    let launchAt = -Infinity;
    for (const launch of launches.get(id) ?? []) {
      if (launch.at <= merge.at && launch.at >= launchAt) { launchAt = launch.at; launchLane = launch.lane; }
    }
    const lane = merge.lane ?? launchLane ?? 'unknown';
    let buckets = groups.get(lane);
    if (!buckets) { buckets = Array.from({ length: 24 }, () => ({ count: 0, times: [] })); groups.set(lane, buckets); }
    const bucket = buckets[Math.floor((merge.at - start) / HOUR)]!;
    bucket.count++;
    if (merge.seconds !== null) bucket.times.push(merge.seconds);
  }
  return { ...base, known: true, lanes: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([lane, buckets]) => ({ lane, buckets: buckets.map((bucket, i) => {
    const times = bucket.times.sort((a, b) => a - b), middle = Math.floor(times.length / 2);
    return { start: new Date(start + i * HOUR).toISOString(), merges: bucket.count, medianSeconds: times.length ? times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2 : null };
  }) })) };
}
