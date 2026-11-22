import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as backlog from '../src/core/release/backlog.js';
import { cmdFleetReleaseBacklog } from '../src/cli/fleet-release-backlog.js';
import { cmdLeaderBrief } from '../src/cli/leader-brief.js';
import { readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

let dir = '';
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); });
it('reaches the command and refreshes the explicit brief while compact reads only cache', async () => {
  dir = await mkdtemp(join(tmpdir(), 'backlog-owner-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  const get = vi.fn(async (path: string) => {
    if (path.endsWith('/releases/latest')) return { tag_name: 'v1', published_at: '2026-11-01T00:00:00Z' };
    if (path.includes('/commits/')) return { sha: 'pinned-head' };
    if (path.includes('/compare/')) return { status: 'identical', total_commits: 0, commits: [] };
    return { default_branch: 'main' };
  });
  const real = backlog.readReleaseBacklog;
  const read = vi.spyOn(backlog, 'readReleaseBacklog').mockImplementation(opts => real({ ...opts, stateDir: dir, get }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(resolveFleetSubcommand('release-backlog')).toEqual({ module: './fleet-release-backlog.js', exportName: 'cmdFleetReleaseBacklog' });
  expect(await cmdFleetReleaseBacklog(['--json'], () => real({ stateDir: dir, get }))).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0])).repos).toHaveLength(7);
  await rm(join(dir, 'release-backlog'), { recursive: true, force: true });
  get.mockClear();
  expect(await cmdLeaderBrief(['--json'])).toBe(0);
  expect(read.mock.calls.some(([opts]) => !opts?.cacheOnly)).toBe(true);
  expect(get.mock.calls.some(([path]) => path.includes('...pinned-head'))).toBe(true);
  get.mockClear();
  const brief = await readCompactBrief(dir);
  expect(get).not.toHaveBeenCalled();
  expect(brief.release.ok).toBe(7);
  expect(brief).toHaveProperty('headline'); expect(brief).toHaveProperty('mergeLatency');
});
it('reports incomplete comparison as unknown rather than zero', async () => {
  dir = await mkdtemp(join(tmpdir(), 'backlog-owner-'));
  const report = await backlog.readReleaseBacklog({ stateDir: dir, get: async path => {
    if (path.endsWith('/releases/latest')) return { tag_name: 'v1', published_at: '2026-11-01T00:00:00Z' };
    if (path.includes('/commits/')) return { sha: 'head' };
    if (path.includes('/compare/')) return { status: 'ahead', total_commits: 1, commits: [] };
    return { default_branch: 'main' };
  } });
  expect(report.counts.unknown).toBe(7);
  expect(report.repos.every(row => row.mergedCommits === null)).toBe(true);
});
