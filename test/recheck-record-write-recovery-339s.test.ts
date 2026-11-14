import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheckRecord } from '../src/cli/fleet-recheck-record.js';
import { FLEET_RECHECK_SCHEMA, type FleetRecheck } from '../src/core/fleet/fleet-recheck.js';
import { recheckLogPath, type ReadRecords } from '../src/core/fleet/recheck-record.js';

const dirs: string[] = [];
function tempRoot(): string { const d = mkdtempSync(join(tmpdir(), 'recheck-write-recovery-')); dirs.push(d); return d; }
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const OLDER = '2026-11-14T03:00:00.000Z';
const NEWER = '2026-11-14T04:00:00.000Z';
const REASON = 'bridge: slack channel stale (4100s old)';

/** A fully typed current FleetRecheck verdict: BLOCKED overall on a stale
 * bridge channel, every other section verified, fake owner/host only. */
function verdict(asOf: string): FleetRecheck {
  return {
    schema: FLEET_RECHECK_SCHEMA,
    asOf,
    sections: {
      runtime: {
        state: 'VERIFIED', source: 'runtime-identity', asOf, missing: [],
        identity: {
          host: 'fake-host', platform: 'darwin', asOf, installedVersion: '1.2.3', sourceVersion: '1.2.3',
          versionDrift: false, tailnetName: 'fake-tailnet-node', reasons: [],
          fleetState: { path: 'fake-state', mtime: asOf, ageSeconds: 3, stale: false },
        },
      },
      claims: {
        state: 'VERIFIED', source: 'fleet-claims', asOf, missing: [],
        claims: [{ id: 'fake-claim-1', owner: 'fake-agent', state: 'RUNNING', claimReceipt: 'fake-rcpt-1', asOf, source: 'fleet-claims' }],
      },
      bridge: {
        state: 'BLOCKED', source: 'channel-health', asOf, missing: [REASON],
        channels: [{
          channel: 'slack', configured: true, processAlive: true, runtimeHost: 'fake-host',
          lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
          proof: { requestCoverage: 'idle', futureDatedCount: 0 },
          state: 'DEAD', missing: [REASON], asOf,
        }],
      },
      task: {
        state: 'VERIFIED', source: 'work-board', asOf, unowned: 0, unclaimed: 0, liveWorker: null, missing: [],
        task: { id: 'T-339', owner: 'fake-agent', state: 'RUNNING', claimReceipt: 'fake-rcpt-1', asOf, source: 'work-board', ledgerClaim: null, coordinationClaim: null },
        lastVerified: { id: 'T-338', owner: 'fake-agent', state: 'VERIFIED', claimReceipt: 'fake-rcpt-0', asOf: OLDER, source: 'work-board', ledgerClaim: null, coordinationClaim: null },
      },
    },
    overall: { state: 'BLOCKED', missing: [REASON] },
  };
}

function capture() {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stdout = () => out.mock.calls.map(c => String(c[0]));
  const stderr = () => err.mock.calls.map(c => String(c[0]));
  const clear = () => { out.mockClear(); err.mockClear(); };
  return { out, err, stdout, stderr, clear };
}

describe('fleet recheck-record write failure and recovery', () => {
  it('a failed append records nothing; after repair only the newer observation is retained', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'fleet'), 'blocker'); // root/fleet must be a directory; a plain file makes the append fail deterministically
    const c = capture();
    const deps = { root, homeDir: () => '/Users/fakehome' };

    expect(await cmdFleetRecheckRecord([], { ...deps, readRecheck: () => verdict(OLDER) })).toBe(1);
    expect(c.stdout().some(l => l.startsWith('recorded '))).toBe(false);
    expect(c.stderr().at(-1)).toMatch(/^record failed: /);
    expect(existsSync(recheckLogPath(root))).toBe(false);

    rmSync(join(root, 'fleet')); // repair only the temporary filesystem
    expect(await cmdFleetRecheckRecord([], { ...deps, readRecheck: () => verdict(NEWER) })).toBe(0);
    expect(c.stdout().at(-1)).toBe(`recorded BLOCKED as-of=${NEWER}`);

    c.clear();
    expect(await cmdFleetRecheckRecord(['--last', '5', '--json', '--envelope'], deps)).toBe(0);
    expect(c.stdout()).toHaveLength(1);
    const env = JSON.parse(c.stdout()[0]!) as ReadRecords;
    expect(env.outcome).toBe('ok');
    expect(env.missing).toBe(false);
    expect(env.rows).toHaveLength(1);
    const row = env.rows[0]!;
    expect(row.asOf).toBe(NEWER);
    expect(row.overall).toBe('BLOCKED');
    expect(row.sections.missing!.overall).toContain(REASON);
    expect(row.sections.missing!.bridge).toContain(REASON);
    expect(row.sections.task.lastVerified).toMatchObject({ id: 'T-338', owner: 'fake-agent', asOf: OLDER });
    expect(env.rows.some(r => r.asOf === OLDER)).toBe(false); // the failed observation was never fabricated
    const lines = readFileSync(recheckLogPath(root), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it('a rejected readRecheck appends no row and prints no success; a later success still records', async () => {
    const root = tempRoot();
    const c = capture();
    const deps = { root, homeDir: () => '/Users/fakehome' };

    expect(await cmdFleetRecheckRecord([], {
      ...deps,
      readRecheck: () => Promise.reject(new Error('fake reader exploded')),
    })).toBe(1);
    expect(c.stdout().some(l => l.startsWith('recorded '))).toBe(false);
    expect(c.stderr().at(-1)).toBe('record failed: unexpected error');
    expect(existsSync(recheckLogPath(root))).toBe(false);

    expect(await cmdFleetRecheckRecord([], { ...deps, readRecheck: () => verdict(NEWER) })).toBe(0);
    expect(c.stdout().at(-1)).toBe(`recorded BLOCKED as-of=${NEWER}`);

    c.clear();
    expect(await cmdFleetRecheckRecord(['--last', '5', '--json', '--envelope'], deps)).toBe(0);
    const env = JSON.parse(c.stdout()[0]!) as ReadRecords;
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]!.asOf).toBe(NEWER);
  });
});
