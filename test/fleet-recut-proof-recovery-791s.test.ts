import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetRecutCheck } from '../src/cli/fleet-recut-check.js';
import { checkPrRecut } from '../src/core/fleet/pr-recut-check.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

let dir: string, head: string, output: string[];
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (path: string, text: string) => writeFileSync(join(dir, path), text);
const commit = (message: string) => { git('add', '.'); git('commit', '-qm', message); };
const gh = (row: unknown) => async () => ({ ok: true, stdout: JSON.stringify(row), stderr: '' });
const row = () => ({ number: 1, baseRefName: 'master', headRefOid: head });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recut-test-')); output = [];
  const gitPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  vi.stubEnv('PATH', [dirname(gitPath), '/usr/bin', '/bin'].join(delimiter));
  vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  git('init', '-q', '-b', 'master'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  write('a', 'one\ntwo\nthree\nfour\n'); write('b', 'old\n'); commit('base');
  git('checkout', '-qb', 'topic'); write('a', 'ONE\ntwo\nthree\nfour\n'); write('b', 'new\n'); commit('topic');
  head = git('rev-parse', 'HEAD'); git('update-ref', 'refs/pull/1/head', head); git('checkout', '-q', 'master');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it('proves missing, partial and fully landed work, including later base edits', async () => {
  const deps = { gh: gh(row()), remote: dir };
  let report = await checkPrRecut(1, 'owner/repo', deps);
  expect(report.remainingFiles).toEqual(['a', 'b']);
  write('a', 'ONE\ntwo\nthree\nfour\n'); commit('partial');
  report = await checkPrRecut(1, 'owner/repo', deps);
  expect(report.alreadyOnMasterFiles).toEqual(['a']); expect(report.remainingFiles).toEqual(['b']);
  write('b', 'new\n'); commit('landed');
  write('a', 'ONE\ntwo\nthree\nFOUR\n'); commit('later edit');
  expect(await cmdFleetRecutCheck(['1', '--repo', 'owner/repo', '--json'], deps)).toBe(0);
  const result = JSON.parse(output[0]!);
  expect(result.alreadyOnMaster).toBe(true); expect(result.remainingFiles).toEqual([]);
  expect(result.evidence.baseSha).toMatch(/^[0-9a-f]{40}$/);
});

it('fails closed for unavailable, malformed and mismatched evidence', async () => {
  const rows = [null, {}, { ...row(), number: 2 }, { ...row(), baseRefName: 'main' }, { ...row(), headRefOid: 'abc' }, { ...row(), headRefOid: 'a'.repeat(40) }];
  for (const value of rows) {
    const result = await checkPrRecut(1, 'owner/repo', { gh: gh(value), remote: dir });
    expect(result.alreadyOnMaster).toBeNull(); expect(result.remainingFiles).toBeNull(); expect(result.next).not.toMatch(/skip|completed/i);
  }
  for (const read of [async () => ({ ok: false, stdout: '', stderr: 'private' }), async () => ({ ok: true, stdout: '{', stderr: '' }), async () => ({ ok: true, stdout: JSON.stringify(row()), stderr: '', truncated: true })]) {
    expect(await cmdFleetRecutCheck(['1', '--json'], { gh: read, remote: dir })).toBe(1);
  }
  expect(await cmdFleetRecutCheck(['1', '--json'], { gh: gh(row()), remote: join(dir, 'missing') })).toBe(1);
  expect(output.join(' ')).not.toContain('private');
});

it('rejects invalid usage before invoking gh and resolves through the fleet registry', async () => {
  const read = vi.fn(gh(row()));
  for (const args of [[], ['0'], ['1', '2'], ['1', '--json', '--json'], ['1', '--repo', '../x'], ['1', '--repo', 'a/b', '--repo', 'a/b'], ['1', '--other'], ['1', '--repo']]) {
    expect(await cmdFleetRecutCheck(args, { gh: read, remote: dir })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
  expect(resolveFleetSubcommand('recut-check')?.exportName).toBe('cmdFleetRecutCheck');
  expect((await FLEET_SUBCOMMAND_LOADERS['recut-check']!()).cmdFleetRecutCheck).toBe(cmdFleetRecutCheck);
});
