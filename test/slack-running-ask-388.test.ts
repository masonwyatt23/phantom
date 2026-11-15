/** RQ-PHX-SLACKRUNNINGASK388: exact "running"/"claims" asks in the Slack
 * Leader thread get the claim-execution evidence reply. Fake values only —
 * nothing touches the real ledger, process table or home. */
import { describe, expect, it, vi } from 'vitest';
import { isRunningAsk } from '../src/core/fleet/running-ask.js';
import { isStatusAsk } from '../src/core/fleet/status-ask.js';
import { isRecheckAsk } from '../src/core/fleet/recheck-ask.js';
import { isOrdersAsk } from '../src/core/fleet/orders-ask.js';
import { isReviewAsk } from '../src/core/fleet/review-ask.js';
import { isOwnersAsk } from '../src/core/fleet/owners-ask.js';
import { formatClaimExecutionReply } from '../src/core/fleet/claim-execution-reply.js';
import type { ClaimExecutionReport, ClaimExecutionRow } from '../src/core/fleet/claim-execution-evidence.js';
import {
  composeOwnerRunningReply, defaultRunningReply, isOwnerStatusRequest,
  OWNER_RUNNING_FALLBACK, ownerStatusReply,
} from '../src/core/agents/owner-status-reply.js';

const RUNS_DIR = '/nonexistent/fake-runs-388';
const NOW = new Date('2026-11-14T19:30:00.000Z');
const ASOF = NOW.toISOString();

const row = (over: Partial<ClaimExecutionRow> = {}): ClaimExecutionRow => ({
  claimId: 'fake-claim-1', agent: 'fake-agent', repo: 'ashlrai/phantom',
  jobId: 'RQ-PHX-FAKEJOB1', state: 'UNKNOWN', worker: null, expiresInSeconds: 600,
  ...over,
});

const report = (over: Partial<ClaimExecutionReport> = {}): ClaimExecutionReport => ({
  schema: 'fleet.claim-execution.v1', authority: 'none', asOf: ASOF,
  ledger: 'known', processes: 'healthy', rows: [],
  counts: { running: 0, claimedNoWorker: 0, unknown: 0 }, reasons: [], ...over,
});

describe('isRunningAsk', () => {
  it.each(['running', 'claims', "who's running", 'who is running', 'claims running', 'execution',
    'Running?', 'CLAIMS!', '  running. ', 'who’s running'])(
    'accepts %s', t => expect(isRunningAsk(t)).toBe(true));
  it.each(["what's running", 'what is running', 'status', 'recheck', 'orders', 'review', 'owners',
    'running on PR #12 please', 'claims please', 'x'.repeat(41), ''])(
    'rejects %s', t => expect(isRunningAsk(t)).toBe(false));
  it('never overlaps another exact ask', () => {
    for (const t of ['running', 'claims', "who's running", 'claims running', 'execution',
      'status', "what's running", 'recheck', 'orders', 'review', 'owners', 'glance']) {
      const hits = [isRunningAsk, isStatusAsk, isRecheckAsk, isOrdersAsk, isReviewAsk, isOwnersAsk].filter(f => f(t)).length;
      expect(hits).toBe(1);
    }
  });
  it("keeps \"what's running\" a status ask, never a running ask", () => {
    expect(isOwnerStatusRequest("what's running")).toBe(true);
    expect(isStatusAsk("what's running")).toBe(true);
    expect(isRunningAsk("what's running")).toBe(false);
    expect(isRunningAsk('what is running')).toBe(false);
  });
});

describe('formatClaimExecutionReply', () => {
  it('formats RUNNING, CLAIMED and UNKNOWN rows with RUNNING first', () => {
    const out = formatClaimExecutionReply(report({
      rows: [
        row({ claimId: 'fake-claim-9', jobId: null, state: 'UNKNOWN', agent: 'fake-agent-c' }),
        row({ claimId: 'fake-claim-2', jobId: 'RQ-PHX-FAKEJOB2', state: 'CLAIMED_NO_WORKER', agent: 'fake-agent-b', expiresInSeconds: 42 }),
        row({ claimId: 'RQ-PHX-FAKEJOB1', jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING', agent: 'fake-agent-a',
          worker: { pid: 4242, lane: 'devin', tier: 'work', ageSeconds: 300 } }),
      ],
      counts: { running: 1, claimedNoWorker: 1, unknown: 1 },
    })).split('\n');
    expect(out).toEqual([
      `Phantom running, as of ${ASOF}`,
      'RUNNING 1 · CLAIMED (no worker) 1 · UNKNOWN 1',
      'RUNNING RQ-PHX-FAKEJOB1 — fake-agent-a, pid 4242, devin/work, 300s',
      'CLAIMED RQ-PHX-FAKEJOB2 — fake-agent-b, no live worker, expires in 42s',
      'UNKNOWN fake-claim-9 — fake-agent-c',
    ]);
  });
  it('falls back to the claim id when a CLAIMED row has no job id', () => {
    const out = formatClaimExecutionReply(report({
      rows: [row({ claimId: 'fake-claim-7', jobId: null, state: 'CLAIMED_NO_WORKER', expiresInSeconds: 5 })],
      counts: { running: 0, claimedNoWorker: 1, unknown: 0 },
    }));
    expect(out).toContain('CLAIMED fake-claim-7 — fake-agent, no live worker, expires in 5s');
  });
  it('says "No live claims." when the report has no rows', () => {
    const out = formatClaimExecutionReply(report());
    expect(out).toContain('No live claims.');
    expect(out).toContain('RUNNING 0 · CLAIMED (no worker) 0 · UNKNOWN 0');
  });
  it('names degraded sources honestly', () => {
    const out = formatClaimExecutionReply(report({ ledger: 'unavailable', processes: 'unavailable' }));
    expect(out).toContain('Ledger unavailable');
    expect(out).toContain('Process table unavailable — RUNNING unproven');
  });
  it('marks only the process table degraded when the ledger read is healthy', () => {
    const out = formatClaimExecutionReply(report({ processes: 'unavailable' }));
    expect(out).not.toContain('Ledger unavailable');
    expect(out).toContain('Process table unavailable — RUNNING unproven');
  });
  it('caps at 10 rows and counts the rest', () => {
    const rows = Array.from({ length: 14 }, (_, i) =>
      row({ claimId: `fake-claim-${i}`, jobId: `RQ-PHX-FAKEJOB${i}`, state: 'CLAIMED_NO_WORKER' }));
    const out = formatClaimExecutionReply(report({ rows, counts: { running: 0, claimedNoWorker: 14, unknown: 0 } }));
    expect(out.split('\n').filter(l => l.startsWith('CLAIMED '))).toHaveLength(10);
    expect(out).toContain('+4 more');
  });
  it('hard-caps at 1500 chars', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row({
      claimId: `fake-claim-with-a-very-long-identifier-${i}`,
      jobId: `RQ-PHX-FAKEJOB${'9'.repeat(60)}${i}`, agent: `fake-agent-with-a-long-name-${i}`,
      state: 'CLAIMED_NO_WORKER', expiresInSeconds: 99999,
    }));
    const out = formatClaimExecutionReply(report({ rows, counts: { running: 0, claimedNoWorker: 50, unknown: 0 } }));
    expect(out.length).toBeLessThanOrEqual(1500);
  });
  it('escapes &, <, > and newlines in every field', () => {
    const out = formatClaimExecutionReply(report({
      asOf: `${ASOF}\ninjected<line>&`,
      rows: [row({ agent: 'a<&>\nb', claimId: 'x<&>\ny', jobId: 'j<&>\nk', state: 'CLAIMED_NO_WORKER' })],
      counts: { running: 0, claimedNoWorker: 1, unknown: 0 },
    }));
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toContain('&lt;');
    expect(out.split('\n')).toHaveLength(3);
  });
  it('never says "assigned" or "routed"', () => {
    const out = formatClaimExecutionReply(report({
      rows: [row({ state: 'RUNNING', worker: { pid: 1, lane: 'devin', tier: 'work', ageSeconds: 1 } })],
      counts: { running: 1, claimedNoWorker: 0, unknown: 0 },
    })).toLowerCase();
    expect(out).not.toContain('assigned');
    expect(out).not.toContain('routed');
  });
});

describe('ownerStatusReply running branch', () => {
  it('asks and composes through the seam', async () => {
    const running = vi.fn(async () => 'FAKE RUNNING');
    const r = ownerStatusReply({ running });
    expect(r.ask('running')).toBe(true);
    expect(r.ask('claims')).toBe(true);
    expect(r.ask("what's running")).toBe(true); // status ask — still gated
    expect(await r.compose(RUNS_DIR, NOW, 'running')).toBe('FAKE RUNNING');
    expect(await r.compose(RUNS_DIR, NOW, 'claims')).toBe('FAKE RUNNING');
    expect(running).toHaveBeenCalledTimes(2);
    expect(running).toHaveBeenCalledWith(NOW);
  });
  it('returns the fixed fallback when the seam throws', async () => {
    const r = ownerStatusReply({ running: async () => { throw new Error('boom'); } });
    expect(await r.compose(RUNS_DIR, NOW, 'running')).toBe(OWNER_RUNNING_FALLBACK);
    expect(await composeOwnerRunningReply(NOW, { running: async () => { throw new Error('x'); } })).toBe(OWNER_RUNNING_FALLBACK);
    expect(OWNER_RUNNING_FALLBACK).toBe(
      "Phantom running: the claim execution read failed; your message is in the Leader's inbox.");
  });
  it("sends \"what's running\" to the status digest, not the running seam", async () => {
    const running = vi.fn(async () => 'FAKE RUNNING');
    const brief = vi.fn(async () => 'Morning leader brief\nfake digest');
    const r = ownerStatusReply({ running, brief, board: () => { throw new Error('no board'); },
      snapshot: async () => { throw new Error('no snapshot'); } });
    const out = await r.compose(RUNS_DIR, NOW, "what's running");
    expect(out).toContain('fake digest');
    expect(running).not.toHaveBeenCalled();
  });
  it('keeps status, owners and review on their own seams', async () => {
    const running = vi.fn(async () => 'FAKE RUNNING');
    const owners = vi.fn(async () => 'FAKE OWNERS');
    const review = vi.fn(async () => 'FAKE REVIEW');
    const brief = vi.fn(async () => 'Morning leader brief\nfake digest');
    const r = ownerStatusReply({ running, owners, review, brief, board: () => { throw new Error('no board'); },
      snapshot: async () => { throw new Error('no snapshot'); } });
    expect(await r.compose(RUNS_DIR, NOW, 'owners')).toBe('FAKE OWNERS');
    expect(await r.compose(RUNS_DIR, NOW, 'review')).toBe('FAKE REVIEW');
    expect(await r.compose(RUNS_DIR, NOW, 'status')).toContain('fake digest');
    expect(running).not.toHaveBeenCalled();
  });
});

describe('defaultRunningReply', () => {
  it('formats the injected claim-execution read', async () => {
    const out = await defaultRunningReply(NOW, { read: async () => report({
      rows: [row({ state: 'RUNNING', worker: { pid: 4242, lane: 'devin', tier: 'work', ageSeconds: 60 } })],
      counts: { running: 1, claimedNoWorker: 0, unknown: 0 },
    }) });
    expect(out).toContain(`Phantom running, as of ${ASOF}`);
    expect(out).toContain('RUNNING RQ-PHX-FAKEJOB1 — fake-agent, pid 4242, devin/work, 60s');
  });
  it('formats a degraded read without throwing', async () => {
    const out = await defaultRunningReply(NOW, { read: async () => report({ ledger: 'unavailable', processes: 'unavailable' }) });
    expect(out).toContain('No live claims.');
    expect(out).toContain('Ledger unavailable');
    expect(out).toContain('Process table unavailable — RUNNING unproven');
  });
});
