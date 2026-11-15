import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

const scanReason = 'lastFleetStateRead: state missing, unreadable or scan limit exceeded';

for (const limit of ['depth', 'entries'] as const) {
  it(`recovers from the ${limit} scan limit without losing claims or following symlinks`, async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'runtime-scan-384s-'));
    try {
      const home = join(temporary, 'home');
      const root = join(home, 'state');
      const outside = join(temporary, 'outside-private');
      mkdirSync(root, { recursive: true });
      mkdirSync(outside);
      const now = Date.now() + 60_000;
      const stateFile = join(root, 'state.json');
      const outsideFile = join(outside, 'private-content.txt');
      writeFileSync(stateFile, '{}');
      writeFileSync(outsideFile, 'private sentinel content');
      const stateTime = Math.floor((now - 20_000) / 1000);
      const outsideTime = Math.floor((now - 5_000) / 1000);
      utimesSync(stateFile, stateTime, stateTime);
      utimesSync(outsideFile, outsideTime, outsideTime);
      symlinkSync(outside, join(root, 'outside-link'), 'dir');

      const excess = join(root, 'excess');
      mkdirSync(excess);
      if (limit === 'depth') {
        let dir = excess;
        for (let i = 0; i < 17; i++) {
          dir = join(dir, 'level');
          mkdirSync(dir);
        }
      } else {
        for (let i = 0; i < 4100; i++) writeFileSync(join(excess, String(i)), '');
      }
      const deps: FleetRuntimeDeps = {
        now: () => now, home: () => home, stateRoot: () => root,
        host: () => 'fake-host', platform: () => 'fakeos', arch: () => 'fakearch',
        pid: () => 123, uptime: () => 10, installedVersion: () => '1.2.3',
        sourceVersion: () => '1.2.4', tailnet: () => 'fake-tailnet',
        board: () => ({ schema: 'fleet.coordination.v1', state: 'known',
          claims: [{ id: 'fake-claim', repo: 'example/repo', task: 'fake task', agent: 'fake-agent', claimedAt: now - 1000, expiresAt: now + 60_000 }],
          messages: [], proposals: [], expiredClaims: 0 }),
      };
      const assertIndependentEvidence = (result: Awaited<ReturnType<typeof readRuntimeSnapshot>>) => {
        expect(result).toMatchObject({ host: 'fake-host', tailnetName: 'fake-tailnet',
          installedVersion: '1.2.3', sourceVersion: '1.2.4', stateRoot: '~/state',
          coordination: { state: 'known', activeClaims: 1, newestReturnAgeSeconds: 'UNKNOWN',
            reason: 'no readable retained return at or before asOf' } });
        expect(JSON.stringify(result)).not.toContain(outside);
        expect(JSON.stringify(result)).not.toContain('private sentinel content');
        expect(JSON.stringify(result)).not.toContain('private-content.txt');
      };

      const bounded = await readRuntimeSnapshot(deps);
      assertIndependentEvidence(bounded);
      expect(bounded.lastFleetStateRead).toEqual({ mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' });
      expect(bounded.reasons).toEqual([scanReason]);

      rmSync(excess, { recursive: true });
      const recovered = await readRuntimeSnapshot(deps);
      assertIndependentEvidence(recovered);
      expect(recovered.lastFleetStateRead).toEqual({ mtime: new Date(stateTime * 1000).toISOString(),
        ageSeconds: Math.floor((now - stateTime * 1000) / 1000) });
      expect(Number.isFinite(recovered.lastFleetStateRead.ageSeconds)).toBe(true);
      expect(recovered.reasons).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 120_000);
}
