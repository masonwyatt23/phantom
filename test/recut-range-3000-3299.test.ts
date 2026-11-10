/**
 * RQ-PHX-RECUTR3000S73 — recovered coverage for PR #3146
 * (bridge: RQ-LAT-FIX4-EMPTYGATEQ9R2, attempt-bound empty launch suppression).
 *
 * The recovered entry points live in contrib/mac/launch_precheck.py:
 *   - attempt_identity(repo, prompt, home): bind an attempt to the local
 *     refs/remotes/origin/HEAD commit plus a prompt hash, no fetch.
 *   - empty_reason(job, identity, rows, now): suppress a launch only when a
 *     prior successful empty finish carries the same attempt identity.
 *   - read_attempts(runs): parse the metrics ledger for that evidence.
 *
 * These tests drive those functions and the shipped unittest suite through
 * real subprocess entry points, never a fixture of one view.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const MAC_DIR = join(REPO_ROOT, 'contrib', 'mac');

function py(script: string, cwd = MAC_DIR): string {
  return execFileSync('python3', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

function gitRepoWithOriginHead(home: string): string {
  const repo = join(home, 'Projects', 'ashlrai', 'phantom');
  mkdirSync(repo, { recursive: true });
  const run = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  run(['init']);
  run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
       'commit', '--allow-empty', '-m', 'base']);
  run(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return run(['rev-parse', 'HEAD']).trim();
}

describe('recut PR #3146 — attempt-bound empty launch suppression', () => {
  it('shipped EmptyGateTests suite passes through its unittest entry point', () => {
    const result = spawnSync(
      'python3',
      [join(MAC_DIR, 'tests', 'test_empty_gate.py')],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('OK');
  });

  it('attempt_identity binds repo, base_sha and prompt_hash without a fetch', () => {
    const home = mkdtempSync(join(tmpdir(), 'recut-3146-'));
    const sha = gitRepoWithOriginHead(home);
    const out = py(
      `import json
from launch_precheck import attempt_identity
print(json.dumps(attempt_identity('phantom', 'the prompt', ${JSON.stringify(home)})))`,
    );
    const identity = JSON.parse(out);
    expect(identity.repo).toBe('phantom');
    expect(identity.base_sha).toBe(sha);
    expect(identity.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('attempt_identity fails open when the repo or ref is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'recut-3146-'));
    const out = py(
      `import json
from launch_precheck import attempt_identity
print(json.dumps(attempt_identity('phantom', 'p', ${JSON.stringify(home)})))`,
    );
    expect(JSON.parse(out)).toEqual({});
  });

  it('empty_reason suppresses an RQ-UPKEEP job emptied on the same base', () => {
    const home = mkdtempSync(join(tmpdir(), 'recut-3146-'));
    const sha = gitRepoWithOriginHead(home);
    const runs = join(home, '.ashlr-runs');
    mkdirSync(join(runs, 'metrics'), { recursive: true });
    writeFileSync(
      join(runs, 'metrics', 'jobs.jsonl'),
      JSON.stringify({ event: 'claim', job: 'RQ-UPKEEP-REL-1', repo: 'phantom', base_sha: sha }) +
        '\n' +
        JSON.stringify({ event: 'finish', job: 'RQ-UPKEEP-REL-1', empty: true, exit_code: 0 }) +
        '\n',
    );
    const out = py(
      `import json
from launch_precheck import attempt_identity, empty_reason, read_attempts
identity = attempt_identity('phantom', 'p', ${JSON.stringify(home)})
rows = read_attempts(${JSON.stringify(runs)})
print(json.dumps({'identity': identity, 'reason': empty_reason('RQ-UPKEEP-REL-1', identity, rows, 0)}))`,
    );
    const result = JSON.parse(out);
    expect(result.identity.base_sha).toBe(sha);
    expect(result.reason).toBe('upkeep_empty_same_base');
  });

  it('empty_reason retries after a failed or nonempty finish on the same base', () => {
    const out = py(
      `import json
from launch_precheck import empty_reason
identity = {'repo': 'phantom', 'base_sha': 'a' * 40, 'prompt_hash': 'b' * 64}
claim = dict(identity, event='claim', job='RQ-UPKEEP-REL-1')
rows_failed = [claim, dict(event='finish', job='RQ-UPKEEP-REL-1', empty=True, exit_code=1)]
rows_worked = [claim, dict(event='finish', job='RQ-UPKEEP-REL-1', empty=False, exit_code=0)]
print(json.dumps([empty_reason('RQ-UPKEEP-REL-1', identity, rows_failed, 0),
                  empty_reason('RQ-UPKEEP-REL-1', identity, rows_worked, 0)]))`,
    );
    expect(JSON.parse(out)).toEqual([null, null]);
  });
});
