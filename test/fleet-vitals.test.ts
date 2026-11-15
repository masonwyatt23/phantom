import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFleetVitals, FLEET_VITALS_MAX_BYTES, FLEET_VITALS_STALE_MS } from '../src/core/fleet/vitals.js';
import { VITALS_SOURCE_BYTES, VITALS_TAIL_BYTES } from '../src/core/fleet/vitals-read.js';
import { cmdFleetVitals } from '../src/cli/fleet-vitals.js';
import { buildTeammateOperationalContext } from '../src/core/comms/teammate-context-evidence.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const NOW = Date.parse('2026-11-14T08:00:00Z');
const iso = (age = 0) => new Date(NOW - age).toISOString();
let root: string;
function put(path: string, data: unknown, age = 1000): string {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  utimesSync(file, new Date(NOW - age), new Date(NOW - age));
  return file;
}
const ledger = (...rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-vitals-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('canonical fleet vitals', () => {
  it('attributes deterministic lane, host, admission, activity and budget evidence', () => {
    put('queue/status.json', { last_tick: iso(), queue_depth: 4, lanes: { codex: { running: 2, target: 5, queued: 3 } }, mem_free_pct: 62,
      budget: { codex: { weekly_used_pct: 99 } }, admission: { admit: true } });
    put('queue/admission.json', { admit: false, reasons: ['load ceiling'], load1: 9, load_max: 8, procs: 500, worktrees: 20 });
    put('queue/budget-overrides.json', { codex: { weekly_used_pct: 42, reset_at: '2026-11-15T00:00:00Z', observed_at: iso(2 * FLEET_VITALS_STALE_MS) } });
    put('queue/resources.json', { lanes: { claude: { used_frac: 0.25, reset_at: '2026-11-16T00:00:00Z' } } });
    put('queue/route-state.json', { J1: { pool: 'codex', decided_at: NOW / 1000, moves: [] } });
    put('metrics/work-market.jsonl', ledger({ schema: 'work-market.v1', reason: 'capacity' }));
    put('metrics/jobs.jsonl', ledger({ event: 'launch', job: 'RQ-A', ts: iso(3000) }, { event: 'publish', job: 'RQ-A', ts: iso(2000), url: 'https://github.com/ashlrai/phantom/pull/99' }, { event: 'outcome', state: 'MERGED', job: 'RQ-A', ts: iso(1000) }));
    put('supervisor/status-other.md', 'All green.');
    const v = buildFleetVitals(root, NOW);
    expect(v).toEqual(buildFleetVitals(root, NOW));
    expect(v).toMatchObject({ schema: 'fleet.vitals.v1', assembledAt: iso(), admission: { source: 'queue/admission.json', state: 'fresh', decision: 'stop', reasons: ['load ceiling'] }, host: { load1: 9, procs: 500, worktrees: 20, mem_free_pct: 62 } });
    expect(v.lanes.find(l => l.lane === 'codex')).toMatchObject({ running: 2, target: 5, queued: 3, used_pct: 42, budget: { state: 'stale', observedAt: iso(2 * FLEET_VITALS_STALE_MS) } });
    expect(v.budget.find(b => b.lane === 'claude')).toMatchObject({ used_pct: 25, source: 'queue/resources.json' });
    expect(v.recent.map(e => e.event)).toEqual(['merge', 'publish', 'launch']);
    expect(v.sources['supervisor/status-other.md']?.summary).toBe('All green.');
    expect(v.sources['metrics/work-market.jsonl']?.state).toBe('fresh');
  });

  it('distinguishes stale status, durable context, absence, invalid JSON and bad types', () => {
    put('leader/VISION.md', 'Durable mission.', 90 * FLEET_VITALS_STALE_MS);
    put('queue/status.json', { lanes: { codex: { running: '7', target: -1 } } }, FLEET_VITALS_STALE_MS + 1);
    put('queue/admission.json', '[]');
    const v = buildFleetVitals(root, NOW);
    expect(v.sources['leader/VISION.md']).toMatchObject({ kind: 'durable', state: 'fresh', observedAt: iso(90 * FLEET_VITALS_STALE_MS) });
    expect(v.sources['queue/status.json']?.state).toBe('stale');
    expect(v.sources['queue/admission.json']?.state).toBe('unavailable');
    expect(v.sources['queue/resources.json']?.state).toBe('missing');
    expect(v.lanes[0]).toMatchObject({ running: null, target: null, queued: null, state: 'stale' });
    expect(v.admission).toMatchObject({ admit: null, decision: null, state: 'unavailable' });
    expect(buildFleetVitals(join(root, 'absent'), NOW).host.procs).toBeNull();
    expect(() => buildFleetVitals(root, NaN)).toThrow('Invalid fleet vitals time');
  });

  it('keeps the 30-minute freshness boundary and marks future observations stale', () => {
    put('queue/status.json', {}, FLEET_VITALS_STALE_MS);
    expect(buildFleetVitals(root, NOW).sources['queue/status.json']?.state).toBe('fresh');
    put('queue/status.json', {}, -120000);
    expect(buildFleetVitals(root, NOW).sources['queue/status.json']?.state).toBe('stale');
  });

  it('does not make copied ticks or budgets fresh or hide an unreadable override', () => {
    put('queue/status.json', { last_tick: iso(2 * FLEET_VITALS_STALE_MS), lanes: { codex: { running: 1 } }, budget: { codex: { weekly_used_pct: 30 } } });
    expect(buildFleetVitals(root, NOW).sources['queue/status.json']).toMatchObject({ state: 'stale', observedAt: iso(1000), recordedAt: iso(2 * FLEET_VITALS_STALE_MS) });
    put('queue/status.json', { last_tick: iso(), lanes: { codex: { running: 1 } }, budget: { codex: { weekly_used_pct: 30 } } });
    expect(buildFleetVitals(root, NOW).budget[0]).toMatchObject({ state: 'unavailable', observedAt: null, used_pct: 30 });
    put('queue/budget-overrides.json', '{broken');
    expect(buildFleetVitals(root, NOW).budget[0]).toMatchObject({ state: 'unavailable', source: 'queue/budget-overrides.json', used_pct: null });
    put('queue/budget-overrides.json', { codex: { weekly_used_pct: 40, observed_at: 'invalid' } });
    expect(buildFleetVitals(root, NOW).budget[0]).toMatchObject({ state: 'unavailable', observedAt: null, used_pct: 40 });
  });

  it('reads bounded complete tail records and marks oversized snapshots unavailable', () => {
    put('metrics/jobs.jsonl', ledger({ event: 'launch', job: 'RQ-HEAD' }) + 'x'.repeat(VITALS_TAIL_BYTES * 2) + '\n' + ledger({ event: 'publish', job: 'RQ-TAIL' }) + '{"event":"launch","job":"RQ-PARTIAL"}');
    put('queue/status.json', JSON.stringify({ text: 'x'.repeat(VITALS_SOURCE_BYTES) }));
    const v = buildFleetVitals(root, NOW);
    expect(v.recent.map(e => e.job)).toEqual(['RQ-TAIL']);
    expect(v.sources['metrics/jobs.jsonl']?.truncated).toBe(true);
    expect(v.sources['queue/status.json']?.state).toBe('unavailable');
    put('metrics/jobs.jsonl', 'x'.repeat(VITALS_TAIL_BYTES * 2));
    expect(buildFleetVitals(root, NOW).recent).toEqual([]);
  });

  it('scrubs credentials before truncation and never exports message fields, handles or raw log suffixes', () => {
    const credentials = ['sk-' + 'a'.repeat(40), 'ghp_' + 'b'.repeat(40), 'xoxb-' + '1234567890-'.repeat(3), 'cog_' + 'z'.repeat(40)];
    const secrets = credentials.join(' ') + ' TEST_TOKEN=opaque-fixture-only';
    put('leader/VISION.md', `Mission ${secrets}\nmessage: PRIVATE_BODY\n  PRIVATE_CONTINUATION\ncontact agent@example.test +15555550123`);
    put('queue/status.json', { lanes: { [credentials[0]!]: { running: 9 }, codex: { running: 1, message: 'PRIVATE_BODY' } }, message: 'PRIVATE_BODY', handle: 'agent@example.test' });
    put('queue/admission.json', { admit: false, reason: secrets, warnings: [`Authorization: Bearer ${'c'.repeat(40)}`] });
    put('metrics/jobs.jsonl', ledger({ event: 'launch', job: 'RQ-SAFE', message: 'PRIVATE_BODY', handle: 'agent@example.test', url: 'https://example.test/?token=opaque-fixture-only' }));
    put('dispatch-events.log', '2026-11-14 07:59:00 LAUNCH RQ-SAFE phantom codex work message=PRIVATE_BODY handle=agent@example.test\n');
    for (const text of [JSON.stringify(buildFleetVitals(root, NOW)), buildTeammateOperationalContext(root, NOW)]) {
      for (const value of [...credentials, 'opaque-fixture-only', 'PRIVATE_BODY', 'PRIVATE_CONTINUATION', 'agent@example.test', '+15555550123', 'c'.repeat(40)]) expect(text).not.toContain(value);
      expect(text).toContain('[REDACTED]');
      expect(text).toContain('RQ-SAFE');
    }
  });

  it('folds heartbeat snapshots and resolution records without exporting finding message text', () => {
    put('metrics/heartbeat-fast.jsonl', ledger({ findings: [{ id: 'a', code: 'stuck', message: 'PRIVATE_BODY' }, { id: 'b', code: 'load' }] }, { id: 'a', state: 'resolved' }, { id: 'c', state: 'open', lane: 'codex', severity: 'warning' }));
    expect(buildFleetVitals(root, NOW).findings.map(f => f.id)).toEqual(['b', 'c']);
    put('metrics/heartbeat-fast.jsonl', ledger({ findings: [] }));
    expect(buildFleetVitals(root, NOW).findings).toEqual([]);
  });

  it('keeps timestamp-bearing job ids while excluding phone-shaped identifiers', () => {
    put('metrics/jobs.jsonl', ledger({ event: 'launch', job: 'RQ-DOT-review-1794643200000' }, { event: 'launch', job: '15555550123' }));
    expect(buildFleetVitals(root, NOW).recent.map(e => e.job)).toEqual(['RQ-DOT-review-1794643200000']);
  });

  it('enforces the UTF-8 payload cap while retaining valid JSON and source attribution', () => {
    for (let i = 0; i < 22; i++) put(`supervisor/status-${i}.md`, '界\\"'.repeat(500));
    const lanes = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`lane-${i}-${'l'.repeat(90)}`, { running: i, target: 50, weekly_used_pct: 10 }]));
    put('queue/status.json', { lanes, budget: lanes });
    put('metrics/jobs.jsonl', ledger(...Array.from({ length: 60 }, (_, i) => ({ event: 'launch', job: `RQ-${i}-${'x'.repeat(100)}`, lane: 'codex' }))));
    const v = buildFleetVitals(root, NOW), text = JSON.stringify(v);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FLEET_VITALS_MAX_BYTES);
    expect(JSON.parse(text).schema).toBe('fleet.vitals.v1');
    expect(v.truncated).toBe(true);
    expect(v.sources['queue/status.json']?.observedAt).toBe(iso(1000));
    expect(v.lanes.length).toBeLessThanOrEqual(32);
  });

  it('rejects source symlinks, hardlinks, writable files and symlinked parents', () => {
    const target = put('target', '{}');
    mkdirSync(join(root, 'queue'));
    symlinkSync(target, join(root, 'queue/status.json'));
    linkSync(target, join(root, 'queue/admission.json'));
    expect(buildFleetVitals(root, NOW).sources['queue/status.json']?.state).toBe('unavailable');
    expect(buildFleetVitals(root, NOW).sources['queue/admission.json']?.state).toBe('unavailable');
    if (process.platform !== 'win32') {
      const file = put('dispatchd.log', '2026-11-14 07:59:00 LAUNCH RQ-UNSAFE\n'); chmodSync(file, 0o666);
      expect(buildFleetVitals(root, NOW).sources['dispatchd.log']?.state).toBe('unavailable');
    }
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, 'metrics'), 'dir');
    expect(buildFleetVitals(root, NOW).sources['metrics/jobs.jsonl']?.state).toBe('unavailable');
  });
});

describe('fleet vitals CLI', () => {
  it('resolves the registered verb and prints the canonical JSON/section/text views', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const module = await FLEET_SUBCOMMAND_LOADERS.vitals!();
    expect(module.cmdFleetVitals).toBe(cmdFleetVitals);
    expect(await cmdFleetVitals(['--json'], { runsDir: root, now: () => NOW })).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual(buildFleetVitals(root, NOW));
    await cmdFleetVitals(['--section', 'admission', '--json'], { runsDir: root, now: () => NOW });
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ schema: 'fleet.vitals.v1', assembledAt: iso(), truncated: false, admission: buildFleetVitals(root, NOW).admission });
    await cmdFleetVitals([], { runsDir: root, now: () => NOW });
    expect(log.mock.calls.at(-1)![0]).toContain('state: missing');
  });
  it('rejects unknown, missing and duplicate flags before reading any evidence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const now = vi.fn(() => NOW);
    for (const args of [['--section'], ['--section', 'body'], ['--json', '--json'], ['--runs-dir', '/'], ['--section', 'lanes', '--section', 'host']]) expect(await cmdFleetVitals(args, { now })).toBe(2);
    expect(now).not.toHaveBeenCalled();
  });
});
