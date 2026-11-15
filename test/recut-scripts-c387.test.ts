// Supersedes the unlanded stats CLI slice of #5211. The retired bridge
// script's handoff is exercised through its current merge-drain replacement.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdRouterQueue } from '../src/cli/router-queue.js';
import { completeRouterJob, enqueueRouterFollowup, enqueueRouterRecut, routerQueueRoot } from '../src/core/fleet/router-queue.js';

const repo = 'ashlrai/phantom';
const headSha = 'a'.repeat(40);
const conflict = {
  v: 1, state: 'CONFLICTING', prUrl: `https://github.com/${repo}/pull/42`,
  headSha, baseRef: 'master', observedAt: '2026-01-02T00:00:00.000Z',
};
let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'recut-scripts-c387-'));
  vi.stubEnv('HOME', home);
  root = routerQueueRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const repositories = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-cortex', 'ashlr-md']
    .map((name) => `ashlrai/${name}`);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ v: 1, repositories }), { mode: 0o600 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function run(args = ['stats', '--json']) {
  const output: unknown[] = [];
  const code = await cmdRouterQueue(args, {
    input: (async function* () { throw new Error('stats must not read stdin'); yield ''; })(),
    output: (value) => output.push(value),
  });
  return { code, output };
}

describe('recovered queue statistics CLI', () => {
  it('reports outstanding, superseded and completed work with measured latency', async () => {
    enqueueRouterFollowup({
      v: 1, state: 'MERGED', prUrl: `https://github.com/${repo}/pull/43`,
      headSha, mergeSha: 'c'.repeat(40), mergedAt: '2026-01-01T00:00:00.000Z',
    });
    enqueueRouterRecut(conflict);
    const next = enqueueRouterRecut({ ...conflict, headSha: 'b'.repeat(40), observedAt: '2026-01-03T00:00:00.000Z' });
    completeRouterJob(next.jobId!);
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.output).toEqual([expect.objectContaining({
      v: 1, totals: { outstanding: 1, done: 1, superseded: 1 },
      merge: expect.objectContaining({ outstanding: 1, done: 0, meanLatencyMs: null }),
      conflict: expect.objectContaining({ outstanding: 0, done: 1, oldestAgeMs: null, latencyUnknown: 0 }),
    })]);
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    const receipt = state.receipts.find((row: { status: string }) => row.status === 'done');
    expect(result.output[0]).toMatchObject({ conflict: {
      meanLatencyMs: Date.parse(receipt.completedAt) - Date.parse(receipt.observedAt),
      meanQueueMs: Date.parse(receipt.completedAt) - Date.parse(receipt.enqueuedAt),
    } });
  });

  it('keeps missing timing unknown for legacy completed receipts', async () => {
    const { jobId } = enqueueRouterRecut(conflict);
    completeRouterJob(jobId!);
    const path = join(root, 'state.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    delete state.receipts[0].completedAt;
    delete state.receipts[0].enqueuedAt;
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
    expect((await run()).output[0]).toMatchObject({ conflict: {
      done: 1, latencyUnknown: 1, meanLatencyMs: null, maxLatencyMs: null, meanQueueMs: null,
    } });
  });

  it('refuses unavailable state without exposing its contents', async () => {
    writeFileSync(join(root, 'state.json'), 'plainly-fake-invalid-state');
    expect(await run()).toEqual({ code: 1, output: [{ error: 'queue-unavailable-or-invalid' }] });
  });

  it.each([['stats', 'extra'], ['stats', '--json', '--json'], ['stats', '--shell']])(
    'rejects invalid stats arguments %j', async (...args) => {
      expect((await run(args)).code).toBe(2);
    },
  );
});

describe('current bridge supervisor script with fake provider inputs', () => {
  it.each(['dirty', 'behind'])('preserves the %s handoff without a live provider', (state) => {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const pr = {
      number: 42, state: 'open', draft: false, auto_merge: {},
      base: { ref: 'master', repo: { full_name: repo } },
      head: { ref: 'codex-bridge/FAKE', sha: headSha, repo: { full_name: repo } },
      mergeable: state === 'behind', mergeable_state: state,
    };
    writeFileSync(join(home, 'pr.json'), JSON.stringify(pr));
    writeFileSync(join(bin, 'locus'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
const pr = JSON.parse(fs.readFileSync('pr.json', 'utf8'));
console.log(JSON.stringify(args.includes('PUT') ? {} : args.at(-1).includes('?') ? [pr] : pr));
`, { mode: 0o700 });
    const stdout = execFileSync(process.execPath, [resolve('scripts/ci/merge-drain.mjs'), repo,
      '--limit', '1', '--retries', '0'], {
      cwd: home, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env['PATH']}` },
    });
    const result = JSON.parse(stdout);
    const calls = readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(result.prs).toHaveLength(1);
    expect(result.prs[0]).toMatchObject({ number: 42, headSha,
      status: state === 'dirty' ? 'conflict' : 'update-requested' });
    const puts = calls.filter((args: string[]) => args.includes('PUT'));
    if (state === 'dirty') {
      expect(puts).toEqual([]);
      expect(result.prs[0].ask).toMatchObject({ schema: 'ask.v1', id: expect.stringMatching(/^RQ-RECUT-[a-f0-9]{64}$/) });
      expect(result.prs[0].ask.task).toContain(`expected source head ${headSha}`);
    } else {
      expect(puts).toEqual([['exec', '--', 'gh', 'api', '--method', 'PUT',
        `repos/${repo}/pulls/42/update-branch`, '-f', `expected_head_sha=${headSha}`]]);
    }
  });
});
