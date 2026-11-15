import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const tracker = vi.hoisted(() => ({ active: 0, peak: 0, calls: 0, fail: false }));
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFile: (...args: Parameters<typeof original.execFile>) => {
      const callback = args.at(-1) as (...values: unknown[]) => void;
      tracker.active++;
      tracker.peak = Math.max(tracker.peak, tracker.active);
      tracker.calls++;
      const finish = (error: unknown, stdout: unknown, stderr: unknown) => { tracker.active--; callback(error, { stdout, stderr }); };
      if (tracker.fail) {
        tracker.fail = false;
        setTimeout(() => finish(new Error('injected failure'), '', ''), 5);
        return {};
      }
      return original.execFile(args[0], args[1] as string[], args[2] as object, finish as never);
    },
  };
});

import { gitSurfaceLog } from '../src/core/fleet/surface-owner-git-log.js';
import { pathJobHistory } from '../src/core/fleet/path-job-history.js';

let repo: string;
let previous: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const commit = (subject: string) => { git('add', '.'); git('commit', '-m', subject); git('update-ref', 'refs/remotes/origin/master', 'HEAD'); };
beforeAll(() => {
  previous = process.cwd();
  repo = mkdtempSync(join(tmpdir(), 'surface-git-'));
  git('init', '-q');
  git('config', 'user.name', 'Fake Agent');
  git('config', 'user.email', 'fake@example.test');
  for (let i = 0; i < 12; i++) writeFileSync(join(repo, `path${i}`), 'first');
  commit('bridge(RQ-OLD): old\twork (#1)');
  for (let i = 0; i < 500; i++) writeFileSync(join(repo, `bulk${i}`), 'bulk');
  for (let i = 0; i < 12; i++) writeFileSync(join(repo, `path${i}`), 'bulk');
  commit('bridge(RQ-BULK): bulk (#2)');
  process.chdir(repo);
});
afterAll(() => { process.chdir(previous); rmSync(repo, { recursive: true, force: true }); });

it('bounds concurrent git children, preserves real history and recovers', async () => {
  tracker.calls = 0;
  const histories = await Promise.all(Array.from({ length: 12 }, (_, i) => gitSurfaceLog!(`path${i}`, 2)));
  expect(tracker.peak).toBeLessThanOrEqual(2);
  expect(tracker.calls).toBe(24); // Previously 12 logs + 24 shows.
  expect(histories[0]![0]!.filesChanged).toBe(512);
  expect(histories[0]![1]!.subject).toBe('bridge(RQ-OLD): old\twork (#1)');
  expect(histories[0]![0]!.sha).toBe(histories[1]![0]!.sha);
  expect((await pathJobHistory('path0', { log: gitSurfaceLog! }, { limit: 1 }))[0]!.jobId).toBe('RQ-OLD');
  expect(await gitSurfaceLog!('missing', 1)).toEqual([]);
  tracker.fail = true;
  await expect(gitSurfaceLog!('path0', 1)).rejects.toThrow('injected failure');
  expect((await gitSurfaceLog!('path0', 1)).length).toBeGreaterThan(0);
  writeFileSync(join(repo, 'path0'), 'new');
  commit('bridge(RQ-NEW): new (#3)');
  expect((await gitSurfaceLog!('path0', 1))[0]!.subject).toBe('bridge(RQ-NEW): new (#3)');
  expect(tracker.active).toBe(0);
});
