import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';
import * as coordination from '../src/core/fleet/coordination.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('recovers a failed CLI return after expiry reaping without replacing its original evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recut-fleetal-c382-'));
  dirs.push(dir);
  const path = join(dir, 'coordination.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const output = () => JSON.parse(String(log.mock.calls.at(-1)![0]));
  expect(await cmdFleetCoordination(['claim', '--repo', 'ashlrai/phantom', '--task', 'Recover receipt',
    '--agent', 'fake-agent', '--json'])).toBe(0);
  const claim = output().value;
  expect(await cmdFleetCoordination(['claim', '--repo', 'ashlrai/phantom', '--task', 'Expiring work',
    '--agent', 'expiring-agent', '--ttl-seconds', '1', '--json'])).toBe(0);
  const expiringId = output().value.claim.id;
  const args = ['return', claim.claim.id, '--agent', 'fake-agent', '--lease', claim.lease];
  const post = vi.spyOn(coordination, 'postFleetMessage')
    .mockReturnValueOnce({ ok: false, error: 'unavailable' });
  expect(await cmdFleetCoordination([...args, '--artifact', 'original-report.txt', '--json'])).toBe(1);
  const failed = output();
  expect(failed.outcome).toBe('released-unposted');
  post.mockRestore();

  // Reading the real board reaps other expired work and must retain the pending return.
  clock.mockReturnValue(1_802_000);
  expect(await cmdFleetCoordination(['board', '--json'])).toBe(0);
  expect(output()).toMatchObject({ state: 'known', claims: [], messages: [] });
  const events = () => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events().find(event => event.id === expiringId && event.kind === 'reap'))
    .toMatchObject({ owner: 'expiring-agent', state: 'RELEASED', reason: 'lease-expired' });
  const before = readFileSync(path, 'utf8');
  expect(await cmdFleetCoordination(['return', claim.claim.id, '--agent', 'fake-agent',
    '--lease', 'wrong-lease', '--tests', 'replacement', '--json'])).toBe(1);
  expect(output().outcome).toBe('not-owner');
  expect(readFileSync(path, 'utf8')).toBe(before);

  expect(await cmdFleetCoordination([...args, '--tests', 'replacement', '--json'])).toBe(0);
  expect(output()).toMatchObject({ outcome: 'returned', message: { body: failed.body } });
  expect(await cmdFleetCoordination([...args, '--blocked', 'later evidence', '--json'])).toBe(0);
  expect(output()).toMatchObject({ outcome: 'already-returned', message: { body: failed.body } });
  expect(await cmdFleetCoordination(['returns', '--json'])).toBe(0);
  expect(output()).toMatchObject({ state: 'known', unparsed: 0,
    returns: [{ claimId: claim.claim.id, result: 'VERIFIED', evidenceKind: 'artifact' }] });
  expect(events().filter(event => event.kind === 'return')).toHaveLength(1);
  expect(events().filter(event => event.kind === 'post')).toHaveLength(1);
  expect(readFileSync(path, 'utf8')).not.toContain(claim.lease);
});
