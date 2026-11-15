import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

const START = Date.parse('2026-11-13T14:00:00.000Z');
const unavailable = {
  state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN',
  reason: 'coordination ledger: missing or unreadable',
};

describe('runtime snapshot live recovery', () => {
  it('rereads durable claims and returns across missing, corrupt and restored state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'runtime-recovery-380s-'));
    const root = join(home, '.ashlr-runs');
    const ledger = join(home, 'ledger', 'coordination.jsonl');
    let now = START;
    const deps: FleetRuntimeDeps = {
      now: () => now, home: () => home, stateRoot: () => root,
      host: () => 'fake host/private', tailnet: () => 'fake@example.test',
      platform: () => 'fake-os', arch: () => 'fake-arch', pid: () => 42, uptime: () => 10,
      installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3',
      board: options => readFleetBoard({ ...options, path: ledger }),
    };
    try {
      const missing = await readRuntimeSnapshot(deps);
      expect(missing).toMatchObject({
        host: 'UNKNOWN', tailnetName: 'UNKNOWN', stateRoot: '~/.ashlr-runs',
        lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' }, coordination: unavailable,
      });
      expect(missing.reasons).toContain('lastFleetStateRead: state missing, unreadable or scan limit exceeded');
      expect(JSON.stringify(missing)).not.toContain(home);
      expect(JSON.stringify(missing)).not.toContain('fake@example.test');

      const claim = claimFleetWork({ repo: 'example/repo', task: 'fake private task', agent: 'fake-agent' }, { path: ledger, now });
      expect(claim.ok).toBe(true);
      if (!claim.ok) throw new Error('claim setup failed');
      const claimedWithoutState = await readRuntimeSnapshot(deps);
      expect(claimedWithoutState.lastFleetStateRead.mtime).toBe('UNKNOWN');
      expect(claimedWithoutState.coordination).toMatchObject({ state: 'known', activeClaims: 1, newestReturnAgeSeconds: 'UNKNOWN' });

      mkdirSync(join(root, 'queue'), { recursive: true });
      const state = join(root, 'queue', 'status.json');
      writeFileSync(state, JSON.stringify({ last_tick: new Date(now).toISOString(), paused: false, mem_free_pct: 50, lanes: {} }));
      utimesSync(state, (now - 30_000) / 1000, (now - 30_000) / 1000);
      const active = await readRuntimeSnapshot(deps);
      expect(active.lastFleetStateRead).toEqual({ mtime: new Date(now - 30_000).toISOString(), ageSeconds: 30 });
      expect(active.coordination).toMatchObject({ state: 'known', activeClaims: 1, newestReturnAgeSeconds: 'UNKNOWN' });
      expect(JSON.stringify(active)).not.toContain('fake private task');

      now += 5_000;
      const returned = returnFleetClaim({ id: claim.value.claim.id, agent: 'fake-agent', lease: claim.value.lease, tests: 'fake pass' }, { path: ledger, now });
      expect(returned).toMatchObject({ ok: true, outcome: 'returned' });
      const current = await readRuntimeSnapshot(deps);
      expect(current.coordination).toEqual({ state: 'known', activeClaims: 0, newestReturnAgeSeconds: 0 });
      now += 12_000;
      const later = await readRuntimeSnapshot(deps);
      expect(later.asOf).toBe(new Date(now).toISOString());
      expect(later.lastFleetStateRead.ageSeconds).toBe(47);
      expect(later.coordination).toEqual({ state: 'known', activeClaims: 0, newestReturnAgeSeconds: 12 });
      expect(later.asOf).not.toBe(current.asOf);

      const validLedger = readFileSync(ledger);
      unlinkSync(ledger);
      const removed = await readRuntimeSnapshot(deps);
      expect(removed.coordination).toEqual(unavailable);
      expect(removed.lastFleetStateRead.ageSeconds).toBe(47);
      const privateText = 'fake confidential ledger contents';
      writeFileSync(ledger, privateText, { mode: 0o600 });
      const corrupt = await readRuntimeSnapshot(deps);
      expect(corrupt.coordination).toEqual(unavailable);
      expect(JSON.stringify(corrupt)).not.toContain(privateText);
      expect(JSON.stringify(corrupt)).not.toContain(home);
      writeFileSync(ledger, validLedger);
      now += 3_000;
      const recovered = await readRuntimeSnapshot(deps);
      expect(recovered.coordination).toEqual({ state: 'known', activeClaims: 0, newestReturnAgeSeconds: 15 });
      expect(recovered.asOf).toBe(new Date(now).toISOString());
      expect(recovered.lastFleetStateRead.ageSeconds).toBe(50);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
