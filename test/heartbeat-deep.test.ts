import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readFastHeartbeatDigest, DEEP_HEARTBEAT_INSTRUCTION } from '../src/core/heartbeat/deep.js';
import { runFastHeartbeat } from '../src/core/heartbeat/fast.js';
import { buildLeaderPrompt, gatherLeaderEvidence, readLeaderRunState, type LeaderEvidenceSources } from '../src/core/vision/leader.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';

let root: string;
let now: number;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'heartbeat-deep-')); now = Date.now(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it('feeds repeated high findings through leader evidence and the real prompt builder, with default wiring', async () => {
  const finding = { kind: 'merge_stall', severity: 'high', job: 'RQ-DEEP', evidence: 'metrics/jobs.jsonl: job finished 40 minutes ago; no merged event observed' };
  const generate = async () => JSON.stringify({ findings: [finding], suggested_actions: ['Review the existing merge gate'] });
  await runFastHeartbeat({ runsDir: root, now: () => now, generate }); now += 60_000;
  await runFastHeartbeat({ runsDir: root, now: () => now, generate });
  const digest = readFastHeartbeatDigest(root, now);
  expect(digest.findings[0]).toMatchObject({ job: 'RQ-DEEP', observations: 2, severity: 'high' });
  expect(digest.repeated_high).toEqual([digest.findings[0]!.id]);
  const sources: LeaderEvidenceSources = {
    fastHeartbeat: t => readFastHeartbeatDigest(root, t), standingPolicy: () => null,
    budgetPolicy: defaultBudgetPolicy, capacity: () => null, goals: () => ({ goals: [], complete: true }),
    readLedger: async () => ({ entries: [], head: null, chain: 'empty', brokenAtSeq: null, reason: null }),
    holds: () => [], quality7d: () => ({ proposalsCreated: 0, merged: 0, rejected: 0, pending: 0, emptyRate: null, acceptRate: null, verifyPassRate: null }),
    models: () => [], reasoning: async () => ({ generatedAt: new Date(now).toISOString(), window: { from: '', to: '' }, totals: { steps: 0, sessions: 0, byEngine: {} }, insights: [], trends: [] }),
  };
  const evidence = await gatherLeaderEvidence(sources, now, readLeaderRunState(now));
  expect(evidence.fastHeartbeat).toEqual(digest);
  const prompt = buildLeaderPrompt(evidence, { dryRun: true, nowIso: new Date(now).toISOString() });
  expect(prompt).toContain('BEGIN UNTRUSTED DATA: FAST HEARTBEAT'); expect(prompt).toContain('RQ-DEEP');
  expect(prompt).toContain(DEEP_HEARTBEAT_INSTRUCTION); expect(prompt).toContain('This is a DRY RUN');
  expect(readFileSync('src/cli/index.ts', 'utf8')).toContain("import('./heartbeat.js')");
  expect(readFileSync('contrib/mac/fast-heartbeat.sh', 'utf8')).toContain('heartbeat watch --json');
  expect(readFileSync('src/core/vision/leader.ts', 'utf8')).toContain("fastHeartbeat: (nowMs) => readFastHeartbeatDigest(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), nowMs)");
});

it('decays unconfirmed high severity and expires old observations even if the source is touched', async () => {
  const generate = async () => JSON.stringify({ findings: [{ kind: 'stale_job', severity: 'high', job: 'RQ-OLD', evidence: 'queue/status.json: last progress 45 minutes ago' }], suggested_actions: [] });
  await runFastHeartbeat({ runsDir: root, now: () => now, generate });
  expect(readFastHeartbeatDigest(root, now + 10 * 60_000).findings[0]!.severity).toBe('medium');
  expect(readFastHeartbeatDigest(root, now + 20 * 60_000).findings[0]!.severity).toBe('low');
  expect(readFastHeartbeatDigest(root, now + 30 * 60_000).findings).toEqual([]);
  now += 31 * 60_000;
  await runFastHeartbeat({ runsDir: root, now: () => now, generate });
  expect(readFastHeartbeatDigest(root, now).findings[0]!.observations).toBe(1);
  expect(readFastHeartbeatDigest(root, now).repeated_high).toEqual([]);
});

it('ignores future, duplicate, malformed and partial rows, preserving unknown health', () => {
  mkdirSync(join(root, 'metrics'));
  const record = { schema: 'heartbeat.fast.v1', event: 'heartbeat.tick', ts: new Date(now + 60_000).toISOString(), interval_s: 300, interval_reason: 'base', model: 'local:fast', status: 'healthy', findings: [], observed_ids: [], suggested_actions: [] };
  writeFileSync(join(root, 'metrics/heartbeat-fast.jsonl'), 'invalid\n' + JSON.stringify(record) + '\n' + '{"partial":', { mode: 0o600 });
  expect(readFastHeartbeatDigest(root, now)).toMatchObject({ last_tick: null, model_health: 'unknown', findings: [] });
  record.ts = new Date(now).toISOString();
  const line = JSON.stringify(record) + '\n'; writeFileSync(join(root, 'metrics/heartbeat-fast.jsonl'), line + line);
  expect(readFastHeartbeatDigest(root, now)).toMatchObject({ last_tick: record.ts, findings: [] });
});
