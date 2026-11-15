import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetClaimExec } from '../src/cli/fleet-claim-exec.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { ClaimExecutionDeps } from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { LiveWorker } from '../src/core/fleet/runs-live-workers.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const AS_OF = new Date(NOW).toISOString();
const USAGE = 'Usage: ashlr fleet claim-exec [--json]';
const claim = (id: string): FleetClaim => ({
  id, agent: 'fake-agent', repo: 'fake-org/fake-repo', task: 'plainly fake task',
  claimedAt: NOW - 1_000, expiresAt: NOW + 60_000,
});
const CLAIMS = [claim('RQ-PHX-FAKEJOB1'), claim('RQ-PHX-FAKEJOB2')];
const WORKER: LiveWorker = {
  pid: 4242, job: 'RQ-PHX-FAKEJOB1', repo: 'fake-repo',
  lane: 'fake-lane', tier: 'work', ageSeconds: 300,
};

function deps(claims = CLAIMS, workers = [WORKER]): ClaimExecutionDeps {
  return {
    now: () => NOW,
    board: (): FleetBoard => ({
      schema: 'fleet.coordination.v1', state: 'known', claims,
      messages: [], proposals: [], expiredClaims: 0,
    }),
    workers: async () => ({
      v: 1, generatedAt: AS_OF, sourceState: 'healthy', workers,
      leaders: [], orchestratorAgents: 0,
    }),
  };
}

describe('fleet claim-exec CLI', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());
  const output = () => vi.mocked(console.log).mock.calls.map(call => call.join(' ')).join('\n');

  it('prints matched execution evidence, unmatched claims and totals', async () => {
    expect(await cmdFleetClaimExec([], deps())).toBe(0);
    expect(output().split('\n')).toEqual([
      'RUNNING RQ-PHX-FAKEJOB1 claim RQ-PHX-FAKEJOB1 by fake-agent repo fake-org/fake-repo pid 4242 lane fake-lane/work age 300s expires in 60s',
      'CLAIMED_NO_WORKER RQ-PHX-FAKEJOB2 claim RQ-PHX-FAKEJOB2 by fake-agent repo fake-org/fake-repo expires in 60s',
      `running 1, claimed-no-worker 1, unknown 0; ledger known; processes healthy; asOf ${AS_OF}`,
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('prints the report as JSON without a wrapper', async () => {
    expect(await cmdFleetClaimExec(['--json'], deps())).toBe(0);
    expect(JSON.parse(output())).toMatchObject({
      schema: 'fleet.claim-execution.v1', authority: 'none', asOf: AS_OF,
      ledger: 'known', processes: 'healthy', reasons: [],
      counts: { running: 1, claimedNoWorker: 1, unknown: 0 },
      rows: [{ state: 'RUNNING', worker: { pid: 4242 } }, { state: 'CLAIMED_NO_WORKER', worker: null }],
    });
    expect(output()).not.toContain('plainly fake task');
  });

  it('keeps every claim UNKNOWN when the workers reader throws', async () => {
    expect(await cmdFleetClaimExec([], {
      ...deps(), workers: async () => { throw new Error('fake private failure'); },
    })).toBe(0);
    expect(output().split('\n')).toEqual([
      ...CLAIMS.map(c => `UNKNOWN ${c.id} claim ${c.id} by fake-agent repo fake-org/fake-repo expires in 60s`),
      `running 0, claimed-no-worker 0, unknown 2; ledger known; processes unavailable; asOf ${AS_OF}`,
      'reasons: process table: unavailable',
    ]);
  });

  it('reports an unavailable ledger successfully without leaking the error', async () => {
    expect(await cmdFleetClaimExec([], {
      ...deps(), board: () => { throw new Error('fake private failure'); },
    })).toBe(0);
    expect(output().split('\n')).toEqual([
      'no live claims',
      `running 0, claimed-no-worker 0, unknown 0; ledger unavailable; processes healthy; asOf ${AS_OF}`,
      'reasons: coordination ledger: missing or unreadable',
    ]);
  });

  it('prints no live claims for an empty ledger', async () => {
    expect(await cmdFleetClaimExec([], deps([]))).toBe(0);
    expect(output()).toBe(`no live claims\nrunning 0, claimed-no-worker 0, unknown 0; ledger known; processes healthy; asOf ${AS_OF}`);
  });

  it('prints unknown job and age placeholders and caps claim lines at 50', async () => {
    const claims = [claim('fake-claim-without-job'), ...Array.from({ length: 55 }, (_, i) => claim(`RQ-PHX-FAKEJOB${i + 1}`))];
    expect(await cmdFleetClaimExec([], deps(claims, [{ ...WORKER, ageSeconds: null }]))).toBe(0);
    const lines = output().split('\n');
    expect(lines[0]).toBe('UNKNOWN - claim fake-claim-without-job by fake-agent repo fake-org/fake-repo expires in 60s');
    expect(lines[1]).toContain('pid 4242 lane fake-lane/work age ?s');
    expect(lines.filter(line => /^(RUNNING|CLAIMED_NO_WORKER|UNKNOWN) /.test(line))).toHaveLength(50);
  });

  it.each([['--bogus'], ['--json', '--json'], ['unexpected']])('rejects invalid args %j before reading', async (...args) => {
    const readers = deps();
    readers.board = vi.fn(readers.board!);
    readers.workers = vi.fn(readers.workers!);
    expect(await cmdFleetClaimExec(args, readers)).toBe(2);
    expect(console.error).toHaveBeenCalledWith(USAGE);
    expect(console.log).not.toHaveBeenCalled();
    expect(readers.board).not.toHaveBeenCalled();
    expect(readers.workers).not.toHaveBeenCalled();
  });

  it.each(['--help', '-h'])('prints help for %s without reading', async flag => {
    const board = vi.fn(() => { throw new Error('must not read'); });
    expect(await cmdFleetClaimExec([flag], { board })).toBe(0);
    expect(output()).toBe(USAGE);
    expect(board).not.toHaveBeenCalled();
  });

  it('loads the command through convention dispatch', async () => {
    const loader = FLEET_SUBCOMMAND_LOADERS['claim-exec'];
    expect(loader).toBeTypeOf('function');
    expect((await loader!()).cmdFleetClaimExec).toBe(cmdFleetClaimExec);
  });
});
