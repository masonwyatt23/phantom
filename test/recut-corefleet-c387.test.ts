import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as coordination from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'recut-corefleet-c387-'));
  dirs.push(dir);
  const options = { path: join(dir, 'coordination.jsonl'), now: 1000 };
  const claimed = coordination.claimFleetWork({ repo: 'example/fake', task: 'preserve receipt', agent: 'fake-agent' }, options);
  if (!claimed.ok) throw new Error('fixture claim failed');
  const input = { id: claimed.value.claim.id, agent: 'fake-agent', lease: claimed.value.lease, tests: 'fake suite passed' };
  vi.spyOn(coordination, 'postFleetMessage').mockReturnValueOnce({ ok: false, error: 'unavailable' });
  expect(returnFleetClaim(input, options).outcome).toBe('released-unposted');
  return { options, input };
}

it('preserves pending receipts through compaction caused by master expiry reaping', () => {
  const { options, input } = fixture();
  const expired = coordination.claimFleetWork({ repo: 'example/fake', task: 'expired work', agent: 'other-agent', ttlMs: 1 }, options);
  if (!expired.ok) throw new Error('fixture expiry claim failed');
  const history = readFileSync(options.path, 'utf8');
  const oldPost = JSON.stringify({ version: 1, kind: 'post', at: 0,
    message: { id: 'old-message', from: 'fake-agent', to: 'all', body: 'old evidence', at: 0, expiresAt: 1 } }) + '\n';
  writeFileSync(options.path, oldPost.repeat(16_000) + history);
  const later = { ...options, now: 1002 };
  expect(coordination.readFleetBoard(later)).toMatchObject({ state: 'known', claims: [], messages: [], expiredClaims: 1 });
  const compacted = readFileSync(options.path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  expect(compacted).toHaveLength(2);
  expect(compacted).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'return', id: input.id }),
    expect.objectContaining({ kind: 'reap', id: expired.value.claim.id, owner: 'other-agent', state: 'RELEASED', reason: 'lease-expired' }),
  ]));
  const recovered = returnFleetClaim({ ...input, tests: 'replacement evidence' }, later);
  expect(recovered.outcome).toBe('returned');
  expect(recovered.message?.body).toContain('tests fake suite passed');
  expect(recovered.message?.body).not.toContain('replacement evidence');
  expect(returnFleetClaim(input, later).outcome).toBe('already-returned');
  expect(coordination.readFleetBoard(later).messages).toEqual([recovered.message]);
  expect(readFileSync(options.path, 'utf8')).not.toContain(input.lease);
});

it('refuses expired pending evidence without publishing a receipt', () => {
  const { options, input } = fixture();
  const before = readFileSync(options.path, 'utf8');
  expect(returnFleetClaim(input, { ...options, now: options.now + 86_400_000 }))
    .toMatchObject({ ok: false, outcome: 'not-found' });
  expect(readFileSync(options.path, 'utf8')).toBe(before);
  expect(coordination.readFleetBoard({ ...options, now: options.now + 86_400_000 }))
    .toMatchObject({ state: 'known', claims: [], messages: [] });
});
