/** Canonical fleet evidence contract: see docs/FLEET-VITALS.md. No host probes or writes. */
import { opendirSync } from 'node:fs';
import { join } from 'node:path';
import { openStableDirectoryGuard } from '../util/stable-file-read.js';
import { scrubPrivateText, scrubSecrets } from '../util/scrub.js';
import { readVitalsSource } from './vitals-read.js';

export const FLEET_VITALS_STALE_MS = 30 * 60_000;
export const FLEET_VITALS_MAX_BYTES = 32 * 1024;
export type VitalsState = 'fresh' | 'stale' | 'missing' | 'unavailable';
export interface VitalsAttribution { source: string; state: VitalsState; observedAt: string | null }
export interface VitalsSource {
  kind: 'status' | 'durable' | 'ledger'; state: VitalsState; observedAt: string | null;
  recordedAt: string | null; summary: string; truncated: boolean;
}
export interface VitalsLane extends VitalsAttribution {
  lane: string; running: number | null; target: number | null; queued: number | null;
  floor: number | null; cap: number | null; held: boolean | null;
  used_pct: number | null; reset_at: string | null; budget: VitalsAttribution;
}
export interface VitalsBudget extends VitalsAttribution { lane: string; used_pct: number | null; reset_at: string | null }
export interface VitalsEvent extends VitalsAttribution {
  event: 'launch' | 'publish' | 'merge'; at: string | null; job: string | null;
  lane: string | null; repo: string | null; tier: string | null; url: string | null;
}
export interface FleetVitals {
  schema: 'fleet.vitals.v1'; assembledAt: string; truncated: boolean;
  sources: Record<string, VitalsSource>; lanes: VitalsLane[]; budget: VitalsBudget[];
  admission: VitalsAttribution & { decision: 'admit' | 'stop' | null; admit: boolean | null; reasons: string[]; warnings: string[] };
  host: VitalsAttribution & { worktrees: number | null; procs: number | null; load1: number | null; load_max: number | null;
    mem_free_pct: number | null; swap_gb: number | null; free_gb: number | null; lane_disk_gate: string | null; status: VitalsAttribution };
  recent: VitalsEvent[];
  findings: Array<VitalsAttribution & { id: string; code: string | null; lane: string | null; severity: string | null }>;
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
// Explicit homes keep the pure projection independent of the caller's environment.
const clean = (value: unknown, cap = 240): string => typeof value === 'string'
  ? scrubPrivateText(value, { emails: true, homes: [] }).replace(/\+?\d[\d ()-]{8,}\d/g, '[REDACTED]').slice(0, cap) : '';
const id = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(value)
  && /[A-Za-z]/.test(value) && scrubSecrets(value) === value ? value : null;
const stamp = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(value)) return null;
  // Offset-free evidence is interpreted consistently across host timezones.
  const ms = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const texts = (value: unknown): string[] => items(value).slice(0, 8).map(v => clean(v)).filter(Boolean);
const stateAt = (at: string | null, now: number): VitalsState => at === null ? 'unavailable'
  : now - Date.parse(at) > FLEET_VITALS_STALE_MS || Date.parse(at) > now + 60_000 ? 'stale' : 'fresh';
const entries = (value: unknown): Array<[string, Row]> => Object.entries(row(value)).filter(([key, v]) => id(key) && Object.keys(row(v)).length)
  .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, row(v)]);

function resourceMap(value: unknown): Row {
  const r = row(value), nested = r.resources ?? r.lanes ?? r.pools ?? value;
  return Array.isArray(nested) ? Object.fromEntries(nested.map(row).flatMap(v => {
    const key = id(v.id ?? v.lane ?? v.pool ?? v.resource); return key ? [[key, v]] : [];
  })) : row(nested);
}

function documentSummary(text: string): string {
  // Message fields and their continuations are never rendered as operational prose.
  let privateBlock = false;
  return clean(text.split('\n').filter(line => {
    if (/\b(?:message|body|handle|recipient|sender|prompt|text)\b["']?\s*[=:]/i.test(line)) { privateBlock = true; return false; }
    if (privateBlock && (/^\s/.test(line) || line.trim() === '')) return false;
    privateBlock = false; return true;
  }).join('\n'), 1200);
}

/** Fixed inputs (including file times) and `now` produce identical JSON. */
export function buildFleetVitals(runsDir: string, now: number): FleetVitals {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new RangeError('Invalid fleet vitals time');
  const sources: FleetVitals['sources'] = {};
  const data = new Map<string, unknown>();
  const records = new Map<string, Row[]>();
  let truncated = false;
  const specs: Array<[string, VitalsSource['kind'], 'json' | 'jsonl' | 'text' | 'log']> = [
    ['leader/VISION.md', 'durable', 'text'], ['supervisor/status-main-guardian.md', 'status', 'text'],
    ['queue/status.json', 'status', 'json'], ['queue/admission.json', 'status', 'json'],
    ['queue/budget-overrides.json', 'status', 'json'], ['queue/resources.json', 'status', 'json'],
    ['queue/route-state.json', 'status', 'json'], ['metrics/jobs.jsonl', 'ledger', 'jsonl'],
    ['metrics/work-market.jsonl', 'ledger', 'jsonl'], ['metrics/heartbeat-fast.jsonl', 'status', 'jsonl'],
    ['dispatch-events.log', 'ledger', 'log'], ['dispatchd.log', 'ledger', 'log'],
  ];
  const guard = openStableDirectoryGuard(join(runsDir, 'supervisor'), { anchorPath: runsDir });
  if (guard.ok) {
    let directory: ReturnType<typeof opendirSync> | undefined;
    const names: string[] = [];
    try {
      directory = opendirSync(join(runsDir, 'supervisor'));
      for (let count = 0; count < 256; count++) {
        const entry = directory.readSync();
        if (!entry) break;
        if (/^status-[A-Za-z0-9._-]{1,80}\.md$/.test(entry.name) && clean(entry.name) === entry.name) names.push(entry.name);
        // A partial directory has no deterministic sorted subset: omit extras.
        if (count === 255) { truncated = true; names.length = 0; }
      }
    } catch { truncated = true; names.length = 0; } finally { directory?.closeSync(); }
    if (guard.finish() === null) {
      const extra = names.filter(n => n !== 'status-main-guardian.md').sort();
      truncated ||= extra.length > 16;
      for (const name of extra.slice(0, 16)) specs.push([`supervisor/${name}`, 'status', 'text']);
    } else truncated = true;
  }
  for (const [path, kind, format] of specs) {
    const read = readVitalsSource(runsDir, path, format === 'jsonl' || format === 'log');
    const source: VitalsSource = { kind, state: read.state === 'present'
      ? kind === 'durable' ? 'fresh' : stateAt(read.observedAt, now) : read.state,
    observedAt: read.observedAt, recordedAt: null, summary: '', truncated: read.truncated };
    sources[path] = source;
    if (read.state !== 'present') continue;
    if (format === 'json') {
      try {
        const parsed: unknown = JSON.parse(read.text);
        if (parsed === null || typeof parsed !== 'object' || (Array.isArray(parsed) && path !== 'queue/resources.json')) throw new Error('shape');
        data.set(path, parsed);
        source.summary = `${Object.keys(row(parsed)).length} fields observed`;
        const record = row(parsed);
        const recorded = record.last_tick ?? record.ts ?? record.observedAt ?? record.observed_at ?? record.generatedAt;
        source.recordedAt = stamp(recorded);
        if (kind === 'status' && recorded !== undefined && stateAt(source.recordedAt, now) !== 'fresh') source.state = stateAt(source.recordedAt, now);
      } catch { source.state = 'unavailable'; source.summary = 'Invalid or incomplete JSON snapshot'; }
    } else if (format === 'jsonl') {
      let invalid = 0;
      const parsed = read.text.split('\n').filter(Boolean).flatMap(line => {
        try { const value = JSON.parse(line); if (!Object.keys(row(value)).length) throw new Error('shape'); return [row(value)]; }
        catch { invalid++; return []; }
      });
      records.set(path, parsed);
      source.summary = `${parsed.length} records in bounded tail; ${invalid} invalid`;
      const latest = parsed.at(-1);
      source.recordedAt = stamp(latest?.ts ?? latest?.timestamp ?? latest?.at);
      if (kind === 'status' && source.recordedAt && stateAt(source.recordedAt, now) === 'stale') source.state = 'stale';
      if (invalid) { source.truncated = true; if (!parsed.length) source.state = 'unavailable'; }
    } else if (format === 'text') {
      source.summary = documentSummary(read.text);
      source.truncated = read.text.length > 1200;
    }
    else {
      // Only the fixed operational columns survive; never arbitrary log suffixes.
      const events = read.text.split('\n').flatMap(line => {
        const m = /^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:Z|[+-]\d\d:?\d\d)?)\s+(LAUNCH|PUBLISH|MERGE|MERGED)\s+(RQ-[A-Za-z0-9._-]+)(?:\s+([a-z][a-z0-9_/-]*)\s+([a-z][a-z0-9-]*)\s+(frontier|work|mid|fast))?/.exec(line);
        return m ? [{ ts: m[1], event: m[2]?.toLowerCase(), job: m[3], repo: m[4], lane: m[5], tier: m[6] }] : [];
      });
      records.set(path, events);
      source.summary = `${events.length} operational events in bounded tail`;
    }
  }
  const attribution = (source: string): VitalsAttribution => ({ source, state: sources[source]?.state ?? 'missing', observedAt: sources[source]?.observedAt ?? null });
  const statusPath = 'queue/status.json', admissionPath = 'queue/admission.json';
  const status = row(data.get(statusPath));
  // A malformed/stale dedicated admission record is never hidden by a fresh status copy.
  const admSource = sources[admissionPath]!.state === 'missing' ? statusPath : admissionPath;
  const adm = admSource === statusPath ? row(status.admission) : row(data.get(admissionPath));
  const admit = bool(adm.admit) ?? (adm.decision === 'admit' ? true : adm.decision === 'stop' ? false : null);
  const statusLanes = row(status.lanes), statusBudget = row(status.budget);
  const overrides = row(data.get('queue/budget-overrides.json')), resources = resourceMap(data.get('queue/resources.json'));
  const laneNames = [...new Set([...entries(statusLanes), ...entries(statusBudget), ...entries(overrides), ...entries(resources)].map(([name]) => name))].sort();
  truncated ||= laneNames.length > 32;
  const budget: VitalsBudget[] = laneNames.slice(0, 32).map(lane => {
    const source = Object.hasOwn(overrides, lane) || sources['queue/budget-overrides.json']!.state === 'unavailable' ? 'queue/budget-overrides.json'
      : Object.hasOwn(resources, lane) ? 'queue/resources.json' : statusPath;
    const value = row((source === statusPath ? statusBudget : source.endsWith('resources.json') ? resources : overrides)[lane]);
    const timeKey = ['observed_at', 'updated_at', 'observedAt', 'updatedAt', 'ts', 'as_of'].find(key => Object.hasOwn(value, key));
    const readingTime = timeKey ? value[timeKey] : undefined;
    const observedAt = stamp(readingTime);
    const attr = attribution(source);
    if (readingTime !== undefined || source === statusPath) attr.observedAt = observedAt;
    if (attr.state !== 'unavailable') {
      if (!Object.keys(value).length) attr.state = Object.hasOwn(source === statusPath ? statusBudget : source.endsWith('resources.json') ? resources : overrides, lane) ? 'unavailable' : 'missing';
      else if (value.stale === true || attr.state === 'stale' || stateAt(attr.observedAt, now) === 'stale') attr.state = 'stale';
      else attr.state = stateAt(attr.observedAt, now);
    }
    return { ...attr, lane, used_pct: num(value.weekly_used_pct ?? value.used_pct) ?? (num(value.used_frac) === null ? null : num(Number(value.used_frac) * 100)), reset_at: stamp(value.reset_at ?? value.resets_at) };
  });
  const lanes = budget.map(b => {
    const lane = row(statusLanes[b.lane]);
    return { ...attribution(statusPath), lane: b.lane, running: num(lane.running), target: num(lane.target), queued: num(lane.queued),
      floor: num(lane.floor), cap: num(lane.hard_cap ?? lane.ceiling), held: bool(lane.held), used_pct: b.used_pct, reset_at: b.reset_at,
      budget: { source: b.source, state: b.state, observedAt: b.observedAt } };
  });
  const recent: VitalsEvent[] = [];
  const addEvent = (r: Row, source: string): void => {
    const event = typeof r.event === 'string' ? r.event.toLowerCase() : '';
    const kind = event === 'launch' || event === 'publish' ? event : event === 'merge' || event === 'merged' || (event === 'outcome' && r.state === 'MERGED') ? 'merge' : null;
    if (!kind) return;
    const url = typeof r.url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(r.url) && clean(r.url) === r.url ? r.url : null;
    const job = id(r.job ?? r.job_id ?? r.jobId);
    if (!job && !url) return;
    recent.push({ ...attribution(source), event: kind, at: stamp(r.ts ?? r.timestamp ?? r.at), job, url, lane: id(r.lane), repo: id(r.repo), tier: id(r.tier) });
  };
  for (const job of items(status.launched_this_tick).slice(-16)) addEvent({ event: 'launch', job, ts: status.last_tick }, statusPath);
  for (const r of items(status.recent_publishes).slice(0, 16)) addEvent({ ...row(r), event: 'publish' }, statusPath);
  for (const path of ['dispatchd.log', 'dispatch-events.log', 'metrics/jobs.jsonl']) {
    for (const r of records.get(path) ?? []) addEvent(r, path);
  }
  const heartbeat = 'metrics/heartbeat-fast.jsonl';
  const open = new Map<string, FleetVitals['findings'][number]>();
  for (const r of records.get(heartbeat) ?? []) {
    // Snapshot records replace prior findings; individual open/resolved records fold in order.
    if (Array.isArray(r.findings)) open.clear();
    for (const f of Array.isArray(r.findings) ? r.findings.map(row) : [r]) {
      const key = id(f.id ?? f.code); if (!key) continue;
      if (f.state === 'resolved' || f.status === 'resolved' || f.open === false || f.event === 'resolved') { open.delete(key); continue; }
      if (!Array.isArray(r.findings) && f.state !== 'open' && f.status !== 'open' && f.open !== true && f.event !== 'finding') continue;
      open.set(key, { ...attribution(heartbeat), id: key, code: id(f.code), lane: id(f.lane), severity: id(f.severity) });
    }
  }
  const disk = row(row(status.autopilot).disk);
  sources[statusPath]!.summary = data.has(statusPath) ? [
    `tick=${stamp(status.last_tick) ?? '?'} queue_depth=${num(status.queue_depth) ?? '?'} paused=${bool(status.paused) ?? '?'}`,
    `24h rollup: ${entries(row(status.rollup_24h).by_lane).slice(0, 16).map(([name, v]) => `${name}:jobs=${num(v.jobs) ?? '?'},merged=${num(v.merged ?? v.merged_prs) ?? '?'}`).join(' | ')}`,
  ].join('\n') : sources[statusPath]!.summary;
  const unique = [...new Map(recent.map(e => [`${e.event}:${e.job}:${e.url}:${e.at}`, e])).values()]
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const result: FleetVitals = {
    schema: 'fleet.vitals.v1', assembledAt: new Date(now).toISOString(), truncated: truncated || unique.length > 24 || open.size > 24,
    sources, lanes, budget,
    admission: { ...attribution(admSource), admit, decision: admit === null ? null : admit ? 'admit' : 'stop',
      reasons: [...new Set([...texts(adm.reasons), clean(adm.reason), clean(adm.gate_reason)].filter(Boolean))], warnings: texts(adm.warnings) },
    host: { ...attribution(admSource), worktrees: num(adm.worktrees), procs: num(adm.procs), load1: num(adm.load1), load_max: num(adm.load_max),
      mem_free_pct: num(status.mem_free_pct), swap_gb: num(status.swap_gb), free_gb: num(disk.free_gb), lane_disk_gate: id(disk.lane_disk_gate), status: attribution(statusPath) },
    recent: unique.slice(0, 24), findings: [...open.values()].slice(-24),
  };
  // Keep valid JSON and all source attribution under the UTF-8 byte cap, even with escaping/multibyte prose.
  for (const s of Object.values(sources)) result.truncated ||= s.truncated;
  while (Buffer.byteLength(JSON.stringify(result)) > FLEET_VITALS_MAX_BYTES) {
    result.truncated = true;
    const longest = Object.values(sources).sort((a, b) => b.summary.length - a.summary.length)[0];
    if (longest?.summary) { longest.summary = longest.summary.slice(0, Math.floor(longest.summary.length / 2)); longest.truncated = true; }
    else if (result.recent.length) result.recent.pop();
    else if (result.findings.length) result.findings.pop();
    else if (result.lanes.length) { result.lanes.pop(); result.budget.pop(); }
    else break; // Fixed metadata alone is below the cap (at most 28 source paths).
  }
  return result;
}
