import { describe, expect, it, vi } from 'vitest';
import { cmdFleetReleaseGateStart } from '../src/cli/fleet-release-gate-start.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const sha = 'a'.repeat(40);
const ok = (body: unknown): GitRunResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '', timedOut: false, missing: false, truncated: false });

describe('release gate start preservation', () => {
  it.each(['dry-run', 'head-moved', 'incomplete-page', 'stable'] as const)('%s uses bounded synthetic transport', async scenario => {
    const calls: string[][] = [];
    let reads = 0;
    const gh: GitRunner = async (_command, args) => {
      calls.push([...args]);
      if (args[0] === 'workflow') return ok(null);
      const path = args[1]!;
      if (path === 'repos/acme/project') return ok({ default_branch: 'master' });
      if (path.includes('/branches/')) return ok({ commit: { sha: scenario === 'head-moved' && reads++ > 0 ? 'b'.repeat(40) : sha } });
      return ok({ total_count: scenario === 'incomplete-page' ? 101 : 0, workflow_runs: [] });
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await cmdFleetReleaseGateStart(['--repo', 'acme/project', '--sha', sha, ...(scenario === 'dry-run' ? [] : ['--apply']), '--json'], { gh });
      const report = JSON.parse(String(log.mock.calls[0]![0]));
      expect(code).toBe(scenario === 'head-moved' ? 1 : scenario === 'incomplete-page' ? 3 : 0);
      expect(report.reason).toBe({ 'dry-run': 'eligible', 'head-moved': 'head_mismatch', 'incomplete-page': 'inventory_unavailable', stable: 'dispatch_accepted' }[scenario]);
      expect(calls.filter(call => call[0] === 'workflow')).toEqual(scenario === 'stable'
        ? [['workflow', 'run', 'ci.yml', '--repo', 'acme/project', '--ref', 'master', '-f', 'release_gate=true']]
        : []);
    } finally { log.mockRestore(); }
  });
});
