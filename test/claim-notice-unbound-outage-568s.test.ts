import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { appendClaimNoticeSent, claimNoticePaths, readClaimThreadBindingsState } from '../src/core/fleet/claim-notice-send.js';
import { readClaimNoticeView } from '../src/core/fleet/claim-notice-view.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';

const now = 1_800_000_000_000;
const repo = 'fake/repo';
const claim = (id: string): FleetClaim => ({ id, repo, task: 'synthetic', agent: 'fake-agent',
  claimedAt: now - 1000, expiresAt: now + 1000 });
const board = (): FleetBoard => ({ schema: 'fleet.coordination.v1', state: 'known',
  claims: [claim('bound'), claim('unbound')], messages: [], proposals: [], expiredClaims: 0 });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('preserves unknown evidence through an outage and recovers from the same files without writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notice-outage-568s-')); dirs.push(dir);
  const paths = claimNoticePaths(dir);
  const key = JSON.stringify(['ASSIGNED', repo, 'bound', 'fake-agent', now - 1000, 'tail']);
  appendClaimNoticeSent(paths.sent, key, now - 30_000);
  mkdirSync(paths.bindings);
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const receipt = { key: hash(`claim-notice-${hash(key).slice(0, 24)}`), state: 'sent' as const,
    channel: 'C00000000', thread: '1700000000.000100', ts: '1799999990.000000' };
  const read = () => readClaimNoticeView({ runsRoot: dir, now: () => now, readBoard: board,
    readConfig: () => ({ path: 'fake', state: 'missing', teamIdentities: [] }),
    readSendReceipts: () => ({ state: 'ok', receipts: [receipt] }) });
  const before = readFileSync(paths.sent, 'utf8');
  expect(readClaimThreadBindingsState(paths.bindings)).toBeNull();
  const outage = await read();
  expect(outage.unbound).toEqual({ state: 'unknown', total: 0, rows: [] });
  expect(outage.pendingObservation).toEqual({ state: 'unknown', reason: 'bindings-unavailable' });
  expect(outage.sent.recent.map(row => row.delivery)).toEqual(['unknown']);
  expect(readFileSync(paths.sent, 'utf8')).toBe(before);
  expect(readdirSync(paths.bindings)).toEqual([]);

  rmSync(paths.bindings, { recursive: true });
  const binding = `${JSON.stringify({ v: 1, claimId: 'bound', repo,
    threadKey: 'T00000000/C00000000/1700000000.000100' })}\n`;
  writeFileSync(paths.bindings, binding);
  const recovered = await read();
  expect(recovered.unbound).toEqual({ state: 'known', total: 1,
    rows: [{ claimId: 'unbound', repo, agent: 'fake-agent', claimedAt: now - 1000 }] });
  expect(recovered.sent.recent.map(row => row.delivery)).toEqual(['slack-sent']);
  expect(readFileSync(paths.sent, 'utf8')).toBe(before);
  expect(readFileSync(paths.bindings, 'utf8')).toBe(binding);
  expect(recovered.pendingObservation).toEqual({ state: 'known' });

  for (const empty of ['missing', 'empty']) {
    rmSync(paths.bindings);
    if (empty === 'empty') writeFileSync(paths.bindings, '');
    expect(readClaimThreadBindingsState(paths.bindings)).toEqual([]);
    expect((await read()).unbound).toMatchObject({ state: 'known', total: 2 });
    if (empty === 'missing') writeFileSync(paths.bindings, '');
  }
});
