import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

it('reopens durable claim and return evidence and recovers from an unreadable ledger', async () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-claim-disk-'));
  try {
    const root = join(home, '.ashlr-runs');
    const ledger = join(home, 'coordination.jsonl');
    let now = Date.parse('2026-11-13T13:13:00.000Z');
    mkdirSync(root);
    const stateFile = join(root, 'state.json');
    writeFileSync(stateFile, '{}');
    utimesSync(stateFile, (now - 30_000) / 1000, (now - 30_000) / 1000);
    const deps: FleetRuntimeDeps = {
      now: () => now, home: () => home, stateRoot: () => root,
      host: () => 'fake-host', platform: () => 'fakeos', arch: () => 'fakearch',
      pid: () => 123, uptime: () => 100, installedVersion: () => '1.2.3',
      sourceVersion: () => '1.2.3', tailnet: () => 'fake-tailnet',
      board: options => readFleetBoard({ ...options, path: ledger }),
    };
    const claim = claimFleetWork({ repo: 'fake/repo', task: 'fake task', agent: 'fake-agent' }, { path: ledger, now });
    if (!claim.ok) throw new Error('fixture claim failed');
    const acquired = await readRuntimeSnapshot(deps);
    expect(acquired.coordination).toEqual({ state: 'known', activeClaims: 1, newestReturnAgeSeconds: 'UNKNOWN',
      reason: 'no readable retained return at or before asOf' });
    expect(acquired.lastFleetStateRead).toEqual({ mtime: '2026-11-13T13:12:30.000Z', ageSeconds: 30 });
    expect(acquired.asOf).toBe('2026-11-13T13:13:00.000Z');

    now += 10_000;
    expect(returnFleetClaim({ id: claim.value.claim.id, agent: 'fake-agent', lease: claim.value.lease,
      artifact: 'fake report' }, { path: ledger, now }).outcome).toBe('returned');
    now += 7_000;
    const returned = await readRuntimeSnapshot({ ...deps, board: options => readFleetBoard({ ...options, path: ledger }) });
    expect(returned.coordination).toEqual({ state: 'known', activeClaims: 0, newestReturnAgeSeconds: 7 });
    expect(returned.asOf).toBe('2026-11-13T13:13:17.000Z');
    expect(returned.lastFleetStateRead.ageSeconds).toBe(47);

    const valid = readFileSync(ledger);
    writeFileSync(ledger, 'corrupt ledger\n');
    const damaged = await readRuntimeSnapshot(deps);
    expect(damaged.coordination).toEqual({ state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN',
      reason: 'coordination ledger: missing or unreadable' });
    writeFileSync(ledger, valid);
    now += 3_000;
    const recovered = await readRuntimeSnapshot(deps);
    expect(recovered.coordination).toEqual({ state: 'known', activeClaims: 0, newestReturnAgeSeconds: 10 });
    expect(recovered.asOf).toBe('2026-11-13T13:13:20.000Z');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
