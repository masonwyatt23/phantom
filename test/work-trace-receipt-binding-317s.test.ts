/** Receipt-binding coverage for collectBusWorkItemEvidence: a `verified`
 * reply counts only when its referenced request receipt is retained, the
 * reply cursor follows the request cursor and the reply receipt is not
 * timestamped before the request's, and only after a settled inbox scan.
 * Real appendBusInbox/postBusReply stores in a private tmp root; fake
 * identities, no network, no credentials; claim tokens never asserted. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';
import { cmdFleetWorkTrace } from '../src/cli/fleet-work-trace.js';

let root: string, now: number;
const ID = 'RQ-PHX-BIND-1';
const REPLY_ID = 'fake-reply-bound';
const iso = (ms: number) => new Date(ms).toISOString();
const collect = (id = ID, at = now) => collectBusWorkItemEvidence(id, { root, now: at });
const post = (id = ID, ttl = 10_000_000, at = now) => {
  expect(appendBusInbox({ id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl,
    body: { kind: 'work' } }, { root, now: () => at }).status).toBe('posted');
};
/** A reply-shaped envelope appended directly: postBusReply refuses a
 * caller-supplied inReplyTo and requires a live request, so orphan and
 * predating replies can only enter through the raw store. */
const rawReply = (id: string, at: number, ttl = 10_000_000, inReplyTo = ID) => {
  expect(appendBusInbox({ id, from: 'fake-lane', to: 'fake-requester', priority: 'P2', ttl,
    body: { inReplyTo, verified: { pr: 7, head: 'feedface' } } },
    { root, now: () => at }).status).toBe('posted');
};
const acquire = (id = ID, leaseMs = 600_000) =>
  mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner', leaseMs, root });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-trace-bind-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('work-trace receipt binding', { timeout: 60_000 }, () => {
  it('VERIFIED when the request receipt precedes a verified reply', async () => {
    post();
    expect(postBusReply(ID, REPLY_ID, { verified: { pr: 7, head: 'feedface' }, text: 'BODYMARKER-1' },
      { root, now: () => now }).outcome).toBe('posted');
    const { evidence, sources } = collect();
    expect(sources).toEqual({ inbox: 'found', claims: 'missing' });
    expect(evidence.verified).toMatchObject({ pr: 7, head: 'feedface', source: `bus-reply:${REPLY_ID}` });
    expect(classifyWorkItem(evidence, iso(now)).state).toBe('VERIFIED');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkTrace(['--id', ID, '--root', root, '--json'])).toBe(0);
    const out = String(log.mock.calls.at(-1)![0]);
    expect(JSON.parse(out)).toMatchObject({ id: ID, state: 'VERIFIED', inbox: 'found', claims: 'missing' });
    expect(out).not.toContain('BODYMARKER-1');
    expect(out).not.toMatch(/[a-f0-9]{64}/);
  });

  it('an orphan verified reply cannot manufacture VERIFIED, even after its request is evicted', () => {
    // Request retained only briefly; the reply outlives it. A later append
    // prunes the expired request receipt while the reply stays retained.
    post(ID, 1_000);
    rawReply(REPLY_ID, now, 10_000_000);
    now += 5_000;
    appendBusInbox({ id: 'fake-filler', from: 'fake-lane', to: 'fake-lane', priority: 'P3', ttl: 10_000_000,
      body: { kind: 'work' } }, { root, now: () => now });
    const { evidence, sources } = collect();
    expect(sources).toEqual({ inbox: 'missing', claims: 'missing' });
    expect(evidence.verified).toBeUndefined();
    expect(evidence.receivedAt).toBeUndefined();
    expect(classifyWorkItem(evidence, iso(now)).state).toBe('RECEIVED');
    // A reply for a request that was never posted is equally inert.
    rawReply('fake-reply-orphan', now, 10_000_000, 'RQ-PHX-NEVER');
    const { evidence: orphan, sources: orphanSources } = collectBusWorkItemEvidence('RQ-PHX-NEVER', { root, now });
    expect(orphanSources.inbox).toBe('missing');
    expect(orphan.verified).toBeUndefined();
  });

  it('a reply that precedes its request in cursor or receipt time is not evidence', () => {
    // Reply appended before the request exists: lower cursor, later adopted id.
    rawReply('fake-reply-early', now);
    post();
    expect(collect().evidence.verified).toBeUndefined();
    // Reply cursor after the request but receipt timestamped before it.
    rawReply('fake-reply-backdated', now - 60_000);
    const { evidence, sources } = collect();
    expect(sources.inbox).toBe('found');
    expect(evidence.verified).toBeUndefined();
    expect(classifyWorkItem(evidence, iso(now)).state).toBe('RECEIVED');
  });

  it('a degraded inbox scan promotes no partial reply evidence to VERIFIED', () => {
    post();
    expect(postBusReply(ID, REPLY_ID, { verified: { pr: 7, head: 'feedface' } },
      { root, now: () => now }).outcome).toBe('posted');
    // Corrupt the snapshot so the bounded scan cannot settle: no page is a
    // settled current request view, so reply candidates stay unbound.
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{"version":2,"highWater":2,"rows":[');
    const { evidence, sources } = collect();
    expect(sources.inbox).toBe('unavailable');
    expect(evidence.verified).toBeUndefined();
    expect(classifyWorkItem(evidence, iso(now)).state).not.toBe('VERIFIED');
  });

  it('a non-verification reply preserves claim and running evidence', () => {
    post();
    const claim = acquire();
    expect(claim.status).toBe('acquired');
    now += 5_000;
    // Names the request but carries no verified object: proves nothing, and
    // must not disturb the claim-bound RUNNING evidence.
    expect(postBusReply(ID, REPLY_ID, { text: 'still running' }, { root, now: () => now }).outcome).toBe('posted');
    const { evidence, sources } = collect();
    expect(sources).toEqual({ inbox: 'found', claims: 'available' });
    expect(evidence.verified).toBeUndefined();
    expect(evidence.owner).toBe('fake-owner');
    expect(evidence.claimReceipt).toBe(`bus-claim:${ID}:1:${now - 5_000}`);
    const r = classifyWorkItem(evidence, iso(now));
    expect(r.state).toBe('RUNNING');
    expect(JSON.stringify(evidence)).not.toContain(claim.token!);
  });
});
