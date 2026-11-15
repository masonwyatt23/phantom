import { describe, expect, it } from 'vitest';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import { listLiveWorkers, type LiveWorker } from '../src/core/fleet/runs-live-workers.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const now = Date.parse('2026-11-14T12:00:00Z');
const job = 'RQ-PHX-FAKEJOB1';
const board: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
  claims: [{ id: job, repo: 'ashlrai/phantom', task: 'fake', agent: 'fake-agent', claimedAt: now - 1000, expiresAt: now + 60000 }],
};
const worker = { pid: 10, job, repo: 'phantom', lane: 'codex', tier: 'work', ageSeconds: 10 };
const read = (ps: string, extra: unknown[] = []) => readClaimExecution({
  board: () => board, now: () => now,
  workers: async () => {
    const snapshot = await listLiveWorkers({ now: () => now, runPs: async () => ps });
    return { ...snapshot, workers: [...snapshot.workers, ...extra as LiveWorker[]] };
  },
});
const line = (repo: string, otherJob = job) => `  123 00:00:05 /fake/bin/launch.sh ${otherJob} ${repo} codex work`;

describe('repository proof for claim execution', () => {
  it('accepts a real parsed bare repository for a qualified claim', async () => {
    const report = await read(line('phantom'));
    expect(report.authority).toBe('none');
    expect(report.rows[0]).toMatchObject({ state: 'RUNNING', repo: 'ashlrai/phantom', worker: { pid: 123 } });
  });

  it('excludes another repository and reports an absent job', async () => {
    for (const ps of [line('locus'), line('phantom', 'RQ-PHX-OTHERJOB1'), '']) {
      const report = await read(ps);
      expect(report.rows[0]).toMatchObject({ state: 'CLAIMED_NO_WORKER', worker: null });
      expect(report.reasons).toEqual([]);
    }
  });

  it.each([undefined, null, '', '/', 'owner/', '/phantom', 'owner/phantom', '.', '..', 'bad repo', 'phantom/../../private', 42])(
    'rejects unusable worker repository %s with a fixed reason', async repo => {
      const report = await read('', [{ ...worker, repo }]);
      expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
      expect(report.reasons).toEqual(['matching worker evidence malformed']);
      expect(JSON.stringify(report)).not.toContain('private');
    },
  );

  it('recovers with a valid younger worker despite ambiguous evidence', async () => {
    const report = await read(line('phantom'), [{ ...worker, repo: '', ageSeconds: 1 }]);
    expect(report.rows[0]).toMatchObject({ state: 'RUNNING', worker: { pid: 123 } });
    expect(report.reasons).toEqual([]);
  });

  it('does not expose reader errors or arbitrary malformed repository text', async () => {
    const marker = 'fake private error text';
    const report = await read('', [{ ...worker, repo: marker }]);
    expect(JSON.stringify(report)).not.toContain(marker);
    const failed = await readClaimExecution({ board: () => board, now: () => now, workers: async () => { throw new Error(marker); } });
    expect(failed.rows[0]?.state).toBe('UNKNOWN');
    expect(JSON.stringify(failed)).not.toContain(marker);
  });
});
