import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cmdFleetReviewTake, type FleetReviewTakeDeps } from '../src/cli/fleet-review-take.js';
import { readFleetBoard, releaseFleetClaim } from '../src/core/fleet/coordination.js';
import { readReviewPick } from '../src/core/fleet/review-pick.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

it('recovers the CLI route after releasing a stale-head claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-cli-recovery-'));
  const path = join(directory, 'ledger.jsonl');
  const repo = 'example/phantom';
  const agent = 'agent-one';
  const now = Date.parse('2026-11-14T16:00:00Z');
  const headA = 'a'.repeat(40);
  const headB = 'b'.repeat(40);
  const heads = [headA, headB, headB, headB, headB];
  const calls: string[][] = [];
  const gh: CloudGh = async args => {
    calls.push([...args]);
    const head = heads.shift();
    if (!head) throw new Error('unexpected GH read');
    return { ok: true, stderr: '', stdout: JSON.stringify([{
      number: 10, title: 'Example review', headRefName: 'example/review', headRefOid: head,
      isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z',
    }]) };
  };
  const evidence = {
    gh, now: () => now,
    readClaimedTsv: async () => ({ state: 'healthy' as const, text: '' }),
    inspectBusWork: () => ({ source: 'available' as const, claims: [] }),
    listWorkers: async () => ({ v: 1 as const, generatedAt: '', sourceState: 'healthy' as const, workers: [], leaders: [], orchestratorAgents: 0 }),
  };
  const board = () => readFleetBoard({ path, now });
  async function run() {
    let stdout = '';
    let stderr = '';
    const deps: FleetReviewTakeDeps = { ...evidence, ledgerPath: path,
      stdout: text => { stdout += text; }, stderr: text => { stderr += text; } };
    const code = await cmdFleetReviewTake(['--agent', agent, '--repo', repo, '--json'], deps);
    expect(stderr).toBe('');
    return { code, report: JSON.parse(stdout) };
  }
  try {
    writeFileSync(path, '', { mode: 0o600 });
    const first = await run();
    expect(first.code).not.toBe(0);
    expect(first.report).toMatchObject({ outcome: 'none', owner: null, claim: null, lease: null,
      reason: 'picked PR head moved during claim' });
    expect(board()).toMatchObject({ state: 'known', claims: [] });

    const second = await run();
    expect(second.code).toBe(0);
    const durable = board();
    expect(durable.state).toBe('known');
    expect(durable.claims).toHaveLength(1);
    const claim = durable.claims[0]!;
    expect(second.report).toMatchObject({ outcome: 'claimed', repo, pr: 10, head_sha: headB,
      owner: claim.agent, claim: { id: claim.id, task: claim.task, expiresAt: claim.expiresAt }, lease: expect.any(String) });
    expect(claim).toMatchObject({ repo, agent, task: `review ${repo}#10 example/review @${headB.slice(0, 12)}` });
    expect(releaseFleetClaim({ id: claim.id, agent, lease: second.report.lease }, { path, now }).ok).toBe(true);
    expect(board().claims).toEqual([]);
    const pick = await readReviewPick({ ...evidence, repo, readBoard: board });
    expect(pick.picked).toMatchObject({ repo, pr: 10, head_sha: headB });
    expect(heads).toEqual([]);
    expect(calls).toHaveLength(5);
    for (const args of calls) {
      expect(args.slice(0, 2)).toEqual(['pr', 'list']);
      expect(args[args.indexOf('--repo') + 1]).toBe(repo);
      expect(args[args.indexOf('--state') + 1]).toBe('open');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
