import { describe, expect, it, vi } from 'vitest';
import { cmdFleetDevloop, type FleetDevloopRun } from '../src/cli/fleet-devloop.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const SCRIPT = '/fake/repo/scripts/gate.mjs';
function harness(result: FleetDevloopRun, exists = true) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const errs: string[] = [];
  const deps = {
    script: SCRIPT,
    exists: () => exists,
    run: (command: string, args: string[]) => { calls.push({ command, args }); return result; },
    err: (line: string) => { errs.push(line); },
  };
  return { calls, errs, deps };
}

describe('fleet devloop (recovered from PR #4128)', () => {
  it('resolves under the convention dispatcher', () => {
    expect(resolveFleetSubcommand('devloop')).toEqual({ module: './fleet-devloop.js', exportName: 'cmdFleetDevloop' });
  });

  it('runs the gate with --check and forwards arguments as an array', async () => {
    const h = harness({ status: 0 });
    expect(await cmdFleetDevloop(['--base', 'origin/dev', '--json'], h.deps)).toBe(0);
    expect(h.calls).toEqual([{ command: process.execPath, args: [SCRIPT, '--check', '--base', 'origin/dev', '--json'] }]);
    expect(h.errs).toEqual([]);
  });

  it('propagates a nonzero gate status', async () => {
    const h = harness({ status: 1 });
    expect(await cmdFleetDevloop([], h.deps)).toBe(1);
    expect((await cmdFleetDevloop([], harness({ status: 2 }).deps))).toBe(2);
  });

  it('reports a missing gate script without spawning', async () => {
    const h = harness({ status: 0 }, false);
    expect(await cmdFleetDevloop([], h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.errs[0]).toContain(`gate script not found at ${SCRIPT}`);
  });

  it('reports a spawn failure', async () => {
    const h = harness({ status: null, error: new Error('spawn ENOENT') });
    expect(await cmdFleetDevloop([], h.deps)).toBe(1);
    expect(h.errs[0]).toContain('could not run the gate: spawn ENOENT');
  });

  it('reports signal termination as failure', async () => {
    const h = harness({ status: null, signal: 'SIGKILL' });
    expect(await cmdFleetDevloop([], h.deps)).toBe(1);
    expect(h.errs[0]).toContain('SIGKILL');
  });

  it('prints usage for --help without running anything', async () => {
    const h = harness({ status: 0 });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await cmdFleetDevloop(['--help'], h.deps)).toBe(0);
      expect(String(write.mock.calls[0]?.[0])).toContain('ashlr fleet devloop');
    } finally { write.mockRestore(); }
    expect(h.calls).toEqual([]);
  });
});
