import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdMetrics } from '../src/cli/metrics.js';
import {
  buildMorningReport, classifyPr, MORNING_KEYS, mergeMorningReport, parseLedgerNodes, parseMorningPrs,
} from '../src/core/metrics/morning.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();
const pr = (o: Record<string, unknown>) => ({
  url: `https://github.com/ashlrai/${o.repo ?? 'phantom'}/pull/${o.number}`, state: 'MERGED', mergedAt: hoursAgo(2),
  additions: 10, deletions: 2, files: [], ...o,
});
const prs = (rows: unknown[]) => parseMorningPrs(JSON.stringify(rows)).rows;

describe('classifyPr', () => {
  const base = { repo: 'ashlrai/phantom', number: 1, state: 'MERGED', mergedAtMs: NOW, additions: 5, deletions: 5, files: [], branch: null };
  it.each([
    ['chore: remove dead code in fleet', 'dead-code'],
    ['refactor: prune unused helpers', 'dead-code'],
    ['feat(cli): add phm foo', 'feature-added'],
    ['Remove the legacy export command', 'feature-removed'],
    ["feat!: drop v1 api", "feature-removed"],
    ['bridge: RQ-X-1', 'unclassified'],
  ])('%s -> %s', (title, cls) => expect(classifyPr({ ...base, title }).class).toBe(cls));
  it('uses added-only source files as heuristic feature evidence', () => {
    const files = [{ path: 'src/core/new-thing.ts', additions: 40, deletions: 0 }];
    expect(classifyPr({ ...base, title: 'Add thing', files })).toEqual({ class: 'feature-added', basis: 'file-evidence' });
    expect(classifyPr({ ...base, title: 'fix: thing', files }).class).toBe('unclassified');
    expect(classifyPr({ ...base, title: 'Add thing', files: [{ path: 'src/core/a.test.ts', additions: 4, deletions: 0 }] }).class).toBe('unclassified');
  });
});

describe('buildMorningReport', () => {
  const rows = prs([
    pr({ number: 10, title: 'feat: new thing', additions: 100, deletions: 0 }),
    pr({ number: 11, title: 'chore: remove dead code', additions: 3, deletions: 80 }),
    pr({ number: 12, repo: 'lexicon', title: 'Remove old command', additions: 0, deletions: 20 }),
    pr({ number: 13, title: 'old merge', mergedAt: hoursAgo(30), additions: 999, deletions: 0 }),
    pr({ number: 14, title: 'no totals', additions: undefined, deletions: undefined }),
    pr({ number: 6236, title: 'bridge: RQ-DEVIN-ABSORB-1', state: 'CLOSED', mergedAt: null }),
  ]);
  const report = buildMorningReport({ nowMs: NOW, prs: rows, dispatchEvents: null, app: null, ledger: null });

  it('classifies and sums only the 24h merged window', () => {
    const f = report.features_added_and_cut as any;
    expect(f.feature_added.map((x: any) => x.pr)).toEqual([10]);
    expect(f.feature_removed_or_cut.map((x: any) => x.pr)).toEqual([12]);
    expect(f.dead_code_removal.map((x: any) => x.pr)).toEqual([11]);
    expect(f.merged_prs).toBe(4);
    const d = report.dead_code_deleted_net_lines as any;
    expect(d).toMatchObject({ status: 'partial', dead_code_deleted_lines: 80, total_additions: 103, total_deletions: 100, net_lines: 3, merged_prs_without_line_totals: 1 });
  });
  it('reports missing with reasons and never invents values', () => {
    for (const k of ['observability_app_status', 'cost_per_merged_pr', 'node_capacity']) expect((report as any)[k].status).toBe('missing');
    expect((report.devin_absorption as any).RQ_DEVIN_ABSORB_1).toMatchObject({ pr: 6236, state: 'CLOSED', merged: false });
    expect(JSON.stringify(report)).not.toMatch(/—/);
  });
  it('is missing everywhere PR data is needed when no export is given', () => {
    const r = buildMorningReport({ nowMs: NOW, prs: null, dispatchEvents: null, app: null, ledger: null });
    expect((r.features_added_and_cut as any).status).toBe('missing');
    expect((r.feedback_loop_minutes as any).status).toBe('missing');
  });
});

describe('devin absorption', () => {
  const ev = (h: number, lane: string) => ({ at: hoursAgo(h), kind: 'LAUNCH', message: `job-${h}-${lane} ${lane} base=abc` });
  it('counts LAUNCH lines by lane for both windows', () => {
    const events = [ev(1, 'devin'), ev(2, 'codex-personal'), ev(3, 'codex-personal'), ev(4, 'claude'), ev(26, 'devin'), ev(27, 'devin'), ev(28, 'devin'), ev(29, 'claude'), { at: hoursAgo(1), kind: 'LAUNCH_DEFERRED', message: 'x devin' }];
    const d = buildMorningReport({ nowMs: NOW, prs: null, dispatchEvents: events, app: null, ledger: null }).devin_absorption as any;
    expect(d.launches_by_lane_24h).toEqual({ devin: 1, 'codex-personal': 2, claude: 1 });
    expect(d.devin_share_24h).toBe(0.25);
    expect(d.non_devin_share_24h).toBe(0.75);
    expect(d.devin_volume_drop_fraction).toBeCloseTo(0.6667, 3);
  });
});

describe('ledger, cost and loop', () => {
  it('parses nodes from arrays and keyed objects', () => {
    const a = parseLedgerNodes({ nodes: [{ name: 'm1', ncpu: 12, memory_gb: 36, load1: 3.5, status: 'ok', lanes: { claude: 2, codex: 3 } }] });
    expect(a).toEqual([{ node: 'm1', ncpu: 12, memory_bytes: 36 * 1024 ** 3, load1: 3.5, status: 'ok', lanes: 5 }]);
    expect(parseLedgerNodes({ nodes: { m2: { ncpu: 8, memory_bytes: 1024, load: 1, state: 'draining' } } })[0]).toMatchObject({ node: 'm2', ncpu: 8, load1: 1, status: 'draining', lanes: null });
    expect(parseLedgerNodes({ lanes: [] })).toEqual([]);
  });
  it('cost is a floor from apiSpend only, else missing with the reader to build', () => {
    const merged = prs([pr({ number: 1, title: 'a' }), pr({ number: 2, title: 'b' })]);
    const ok = buildMorningReport({ nowMs: NOW, prs: merged, dispatchEvents: null, app: null, ledger: { apiSpend: { usdToday: 3 } } }).cost_per_merged_pr as any;
    expect(ok).toMatchObject({ status: 'partial', usd_per_merged_pr_api_only: 1.5 });
    const none = buildMorningReport({ nowMs: NOW, prs: merged, dispatchEvents: null, app: null, ledger: { lanes: [] } }).cost_per_merged_pr as any;
    expect(none.status).toBe('missing');
    expect(none.reason).toContain('phm usage --by-job');
  });
  it('computes p50 idea-to-merged and merged-to-installed', () => {
    const rows = prs([
      pr({ number: 1, title: 'bridge: RQ-A-1', mergedAt: hoursAgo(1) }),
      pr({ number: 2, title: 'bridge: RQ-B-1', mergedAt: hoursAgo(2) }),
      pr({ number: 3, title: 'bridge: RQ-C-1', mergedAt: hoursAgo(3) }),
      pr({ number: 4, title: 'bridge: RQ-D-1', mergedAt: hoursAgo(4) }),
      pr({ number: 5, title: 'chore(release): 3.30.32', mergedAt: hoursAgo(5) }),
    ]);
    const ideas = new Map([['RQ-A-1', NOW - 3 * 3_600_000], ['RQ-B-1', NOW - 5 * 3_600_000], ['RQ-C-1', NOW - 4 * 3_600_000]]);
    const app = { version: '3.30.32', installedAtMs: NOW - 4 * 3_600_000, running: true, views: null };
    const l = buildMorningReport({ nowMs: NOW, prs: rows, dispatchEvents: null, app, ledger: null, ideaAtMs: ideas }).feedback_loop_minutes as any;
    expect(l).toMatchObject({ status: 'partial', idea_to_merged_p50: 120, sample: 3, merged_bridge_prs: 4, merged_to_installed: 60 });
  });
});

describe('mergeMorningReport', () => {
  it('replaces only owned keys', () => {
    const r = buildMorningReport({ nowMs: NOW, prs: null, dispatchEvents: null, app: null, ledger: null });
    const m = mergeMorningReport({ keep: { a: 1 }, node_capacity: 'old' }, r);
    expect(m.keep).toEqual({ a: 1 });
    expect((m.node_capacity as any).status).toBe('missing');
    for (const k of MORNING_KEYS) expect(m).toHaveProperty(k);
  });
});

describe('phm metrics morning', () => {
  let dir: string;
  const run = async (args: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdMetrics(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'phm-morning-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads injected sources end to end', async () => {
    const runs = join(dir, 'runs'); mkdirSync(join(runs, 'queue'), { recursive: true });
    const stamp = (h: number) => { const d = new Date(NOW - h * 3_600_000); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
    writeFileSync(join(runs, 'queue', 'dispatch-events.log'), `${stamp(1)} LAUNCH j1 claude base=x\n${stamp(2)} LAUNCH j2 devin base=x\ngarbage\n`);
    writeFileSync(join(runs, 'queue', 'fleet-ledger.json'), JSON.stringify({ nodes: [{ name: 'a', ncpu: 4, load1: 1, status: 'ok' }] }));
    const prompt = join(dir, 'p.md'); writeFileSync(prompt, 'x');
    writeFileSync(join(runs, 'queue', 'ready.tsv'), `RQ-Z-1\tphantom\tclaude\t1\t${prompt}\n`);
    const prsFile = join(dir, 'prs.json');
    writeFileSync(prsFile, JSON.stringify([pr({ number: 7, title: 'feat: x' })]));
    const r = await run(['morning', '--json', '--prs', prsFile, '--runs-dir', runs, '--app', join(dir, 'No.app'), '--now', new Date(NOW).toISOString()]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.schema).toBe('metrics.morning.v1');
    expect(j.devin_absorption.launches_by_lane_24h).toEqual({ claude: 1, devin: 1 });
    expect(j.node_capacity.nodes[0]).toMatchObject({ node: 'a', ncpu: 4 });
    expect(j.observability_app_status.status).toBe('missing');
    expect(j.features_added_and_cut.feature_added).toEqual([{ pr: 7, repo: 'phantom', basis: 'title' }]);
  });

  it('degrades to missing when sources are unreadable', async () => {
    const r = await run(['--json', 'morning', '--runs-dir', join(dir, 'none'), '--app', join(dir, 'No.app')]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.node_capacity.reason).toContain('fleet-ledger.json');
    expect(j.devin_absorption.status).toBe('missing');
  });

  it('merges into an existing report with a backup, keeping other keys', async () => {
    const target = join(dir, 'morning.json');
    writeFileSync(target, JSON.stringify({ other: 1 }));
    const r = await run(['morning', '--runs-dir', join(dir, 'none'), '--app', join(dir, 'No.app'), '--merge-into', target]);
    expect(r.code).toBe(0);
    const merged = JSON.parse(readFileSync(target, 'utf8'));
    expect(merged.other).toBe(1);
    expect(merged.node_capacity.status).toBe('missing');
    const backup = readdirSync(dir).find((f) => f.startsWith('morning.json.bak-'))!;
    expect(JSON.parse(readFileSync(join(dir, backup), 'utf8'))).toEqual({ other: 1 });
  });

  it('refuses a symlink or non-object target and leaves it unchanged', async () => {
    const real = join(dir, 'real.json'); writeFileSync(real, '{}');
    const link = join(dir, 'link.json'); symlinkSync(real, link);
    expect((await run(['morning', '--runs-dir', dir, '--merge-into', link])).code).toBe(1);
    expect(readFileSync(real, 'utf8')).toBe('{}');
    const arr = join(dir, 'arr.json'); writeFileSync(arr, '[1]');
    expect((await run(['morning', '--runs-dir', dir, '--merge-into', arr])).code).toBe(1);
    expect(readFileSync(arr, 'utf8')).toBe('[1]');
  });

  it('rejects bad arguments and non-loopback probes', async () => {
    expect((await run(['morning', '--bogus'])).code).toBe(2);
    expect((await run(['morning', '--now', 'tomorrow'])).code).toBe(2);
    expect((await run(['morning', '--runs-dir', dir, '--probe-url', 'http://example.com/'])).code).toBe(2);
    expect((await run(['morning', '--help'])).code).toBe(0);
  });
});
