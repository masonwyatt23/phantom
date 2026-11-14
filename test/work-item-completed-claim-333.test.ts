/** RQ-PHX-COMPLETEDCLAIMHONEST333: a claim settled `complete` without a
 * verified reply stays ASSIGNED and names exactly what is absent —
 * `verification artifact (claim completed <iso>)` — so the work board,
 * work-trace and Mason/Dot can tell "done, unverified" from "assigned,
 * idle". Pure classifier cases plus real durable stores in a private tmp
 * root; ids and text are plainly fake and no token may appear in output. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { classifyWorkItem, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const NOW = '2026-11-14T12:00:00.000Z';
const RECEIVED = '2026-11-14T11:00:00.000Z';
const DONE = '2026-11-14T11:59:00.000Z';
const ENTRY = `verification artifact (claim completed ${DONE})`;
const base: WorkItemEvidence = { id: 'RQ-PHX-FAKE-333', receivedAt: RECEIVED, owner: 'fake-owner', claimReceipt: 'fake-claim-1' };
const assigned = { state: 'ASSIGNED', asOf: RECEIVED, source: 'claim:fake-claim-1' } as const;

describe('classifyWorkItem with a settled complete claim', () => {
  it('stays ASSIGNED and names the missing verification artifact', () => {
    expect(classifyWorkItem({ ...base, completedAt: DONE }, NOW))
      .toEqual({ ...assigned, missing: [ENTRY] });
  });

  it('keeps VERIFIED and BLOCKED ahead of the completion marker', () => {
    const verified = { pr: 1, head: 'abc1234', source: 'fake-reply', at: DONE };
    expect(classifyWorkItem({ ...base, completedAt: DONE, verified }, NOW))
      .toEqual({ state: 'VERIFIED', asOf: DONE, source: 'fake-reply', missing: [] });
    const blocker = { dependency: 'fake-dep', source: 'fake-reply', at: DONE };
    expect(classifyWorkItem({ ...base, completedAt: DONE, blocker }, NOW))
      .toEqual({ state: 'BLOCKED', asOf: DONE, source: 'fake-reply', missing: [] });
  });

  it('a malformed, mistyped or absent completedAt changes nothing', () => {
    expect(classifyWorkItem(base, NOW)).toEqual({ ...assigned, missing: [] });
    for (const bad of ['', '   ', 'not a date']) {
      expect(classifyWorkItem({ ...base, completedAt: bad }, NOW)).toEqual({ ...assigned, missing: [] });
    }
    // Evidence JSON is untrusted input; a non-string marker is ignored.
    const mistyped = 1_700_000_000_000 as unknown as string;
    expect(classifyWorkItem({ ...base, completedAt: mistyped }, NOW)).toEqual({ ...assigned, missing: [] });
  });

  it('appends after stale running evidence, in the existing order', () => {
    const stale = { source: 'fake-heartbeat', at: '2026-11-14T10:00:00.000Z' };
    expect(classifyWorkItem({ ...base, runningEvidence: stale }, NOW).missing)
      .toEqual(['fresh running evidence']);
    expect(classifyWorkItem({ ...base, runningEvidence: stale, completedAt: 'bogus' }, NOW).missing)
      .toEqual(['fresh running evidence']);
    expect(classifyWorkItem({ ...base, runningEvidence: stale, completedAt: DONE }, NOW).missing)
      .toEqual(['fresh running evidence', ENTRY]);
  });

  it('the RECEIVED branch never reports the marker', () => {
    expect(classifyWorkItem({ id: 'RQ-PHX-FAKE-333', receivedAt: RECEIVED, completedAt: DONE }, NOW))
      .toEqual({ state: 'RECEIVED', asOf: RECEIVED, source: 'receivedAt',
        missing: ['named owner', 'durable claim receipt'] });
  });
});

describe('completed claim over real durable stores', { timeout: 60_000 }, () => {
  let root: string, now: number;
  const ID = 'RQ-PHX-FAKE-333-STORE';
  const iso = (ms: number) => new Date(ms).toISOString();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'work-item-completed-333-'));
    chmodSync(root, 0o700);
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it('evidence carries completedAt and the board lists done-unverified', () => {
    expect(appendBusInbox({ id: ID, from: 'fake-requester', to: 'fake-lane', priority: 'P1',
      ttl: 10_000_000, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
    const claim = mutateBusWorkClaim({ action: 'acquire', id: ID, owner: 'fake-owner', leaseMs: 600_000, root });
    expect(claim.status).toBe('acquired');
    now += 5_000;
    expect(mutateBusWorkClaim({ action: 'complete', id: ID, token: claim.token!, root }).status).toBe('completed');

    const { evidence, sources } = collectBusWorkItemEvidence(ID, { root, now });
    expect(sources).toEqual({ inbox: 'found', claims: 'available' });
    expect(evidence.completedAt).toBe(iso(now));
    expect(evidence.runningEvidence).toBeUndefined();
    expect(evidence.verified).toBeUndefined();
    expect(evidence.owner).toBe('fake-owner');

    const board = listWorkBoard({ root, now });
    const item = board.items.find(i => i.id === ID)!;
    expect(item.state).toBe('ASSIGNED');
    expect(item.missing).toEqual([`verification artifact (claim completed ${iso(now)})`]);
    // The fencing token never surfaces in evidence or the board.
    expect(JSON.stringify({ evidence, board })).not.toMatch(/[a-f0-9]{64}/);
  });
});
