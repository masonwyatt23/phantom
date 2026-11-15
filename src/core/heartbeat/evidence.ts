import { readHeartbeatFile, bytePrefix, scrub } from './io.js';
import { MAX_DIGEST_BYTES, type HeartbeatState, type Finding } from './schema.js';

const SOURCES = ['queue/status.json', 'queue/admission.json', 'dispatch-events.log', 'metrics/jobs.jsonl', 'queue/budget-overrides.json', 'metrics/work-market.jsonl'] as const;
type Source = { path: string; freshness: 'fresh' | 'stale' | 'unavailable'; observed_at: string | null; text: string };
export interface Vitals { digest: string; sources: Source[]; status: Record<string, unknown>; admission: boolean | null }
function object(text: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}
export function readVitals(root: string, now: number): Vitals {
  let status: Record<string, unknown> = {};
  let admission: boolean | null = null;
  const sources: Source[] = SOURCES.map(path => {
    const tail = path.endsWith('.jsonl') || path.endsWith('.log');
    const file = readHeartbeatFile(root, path, 64 * 1024, tail);
    const parsed = !tail && file ? object(file.text) : null;
    const stamp = parsed?.ts ?? parsed?.last_tick;
    const embedded = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
    const observed = file ? (Number.isFinite(embedded) ? Math.min(file.mtime, embedded) : file.mtime) : null;
    const maxAge = path.includes('budget') ? 30 * 60_000 : 5 * 60_000;
    const age = observed === null ? Infinity : now - observed;
    const freshness = !file || (parsed && !Object.keys(parsed).length) ? 'unavailable' : age < -60_000 || age > maxAge || embedded > now + 60_000 ? 'stale' : 'fresh';
    if (freshness === 'fresh' && parsed) {
      if (path === 'queue/status.json') status = parsed;
      if (path === 'queue/admission.json' && typeof parsed.admit === 'boolean') admission = parsed.admit;
    }
    const text = scrub(file?.text ?? '');
    return { path, freshness, observed_at: observed === null ? null : new Date(observed).toISOString(), text: bytePrefix(tail ? text.slice(-6000) : text, 3000) };
  });
  // Serialize each source independently: truncation never separates a claim from its attribution.
  let digest = JSON.stringify({ sources });
  while (Buffer.byteLength(digest) > MAX_DIGEST_BYTES) {
    const largest = sources.reduce((a, b) => Buffer.byteLength(a.text) > Buffer.byteLength(b.text) ? a : b);
    largest.text = bytePrefix(largest.text, Math.max(0, Buffer.byteLength(largest.text) - 500));
    digest = JSON.stringify({ sources });
  }
  return { digest, sources, status, admission };
}

export function selectInterval(vitals: Vitals, findings: Finding[], history: HeartbeatState['admissions']): { interval_s: 60 | 300 | 900; interval_reason: string } {
  const st = vitals.status;
  const launches = Array.isArray(st.launched_this_tick) ? st.launched_this_tick.length : 0;
  const lanes = st.lanes && typeof st.lanes === 'object' && !Array.isArray(st.lanes) ? Object.values(st.lanes) : [];
  const running = lanes.map(l => l && typeof l === 'object' ? (l as Record<string, unknown>).running : undefined);
  const knownRunning = running.length > 0 && running.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  const idle = knownRunning && running.every(n => n === 0);
  const flips = history.slice(1).filter((v, i) => v.admit !== history[i]!.admit).length;
  const hot = launches >= 3 ? 'launch_churn' : flips >= 3 ? 'admission_flapping'
    : idle && typeof st.queue_depth === 'number' && st.queue_depth > 0 && vitals.admission === true ? 'queue_starvation'
      : findings.some(f => f.severity === 'high' && ['merge_stall', 'admission_flap', 'idle_lane_with_queue'].includes(f.kind)) ? 'high_severity_finding' : null;
  if (hot) return { interval_s: 60, interval_reason: hot };
  if (idle && st.queue_depth === 0 && launches === 0 && findings.length === 0 && vitals.admission !== null) return { interval_s: 900, interval_reason: 'quiet' };
  return { interval_s: 300, interval_reason: 'base_or_unknown' };
}
