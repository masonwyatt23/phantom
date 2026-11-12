import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRoutines } from '../src/cli/fleet-routines.js';
import { placeRoutine, readRoutineLedger, runRoutine, type Routine } from '../src/core/routines/index.js';

const engineRun = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ state: { status: 'done', usage: { estCostUsd: 0 } }, proposalId: undefined as string | undefined })));
vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({ foundry: { engines: {} } }) }));
vi.mock('../src/core/run/sandboxed-engine.js', () => ({ runEngineSandboxed: engineRun, runApiModelSandboxed: engineRun }));

let home: string;
let stdout: string[];
let stderr: string[];
beforeEach(() => {
  engineRun.mockClear();
  home = mkdtempSync(join(tmpdir(), 'fleet-routines-183-'));
  vi.stubEnv('HOME', home);
  stdout = []; stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => { stdout.push(String(s)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => { stderr.push(String(s)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

const watchdog = (): Routine => ({ id: 'watchdog', goal: 'Check stalled jobs', sourceRepo: '/repo', budgetUsd: 3,
  quotaSince: '2026-01-01T00:00:00Z', resources: [
    { provider: 'local', model: 'local-model', costUsd: 0, latencyMs: 1000, quality: 0.9, freeQuota: 0 },
    { provider: 'codex', model: 'frontier-model', costUsd: 1, latencyMs: 2000, quality: 0.98, freeQuota: 0 },
  ] });
const routineFile = (r: Routine = watchdog()): string => {
  const file = join(home, 'routine.json');
  writeFileSync(file, JSON.stringify(r));
  return file;
};

describe('fleet routines recovery', () => {
  it('runs a routine command -> core -> mocked sandbox adapter -> ledger without a merge claim', async () => {
    expect(await cmdFleetRoutines(['run', routineFile(), '--json'])).toBe(0);
    expect(engineRun).toHaveBeenCalledWith('local-coder', 'Check stalled jobs', expect.objectContaining({
      foundry: expect.objectContaining({ engines: expect.objectContaining({
        'local-coder': expect.objectContaining({ api: { envKey: '', defaultBaseUrl: 'http://127.0.0.1:8000/v1', defaultModel: 'local-model', protocol: 'openai' } }),
      }) }),
    }), expect.objectContaining({ sourceRepo: '/repo', model: 'local-model' }));
    const receipt = JSON.parse(stdout.join(''));
    expect(receipt).toMatchObject({ provider: 'local', outcome: 'succeeded', metric: 'operational' });
    expect(readRoutineLedger()).toHaveLength(1);
  });

  it('escalates to the codex adapter after repeated local failures and explains every receipt', async () => {
    const providers: string[] = [];
    const adapter = async (r: { provider: string; costUsd: number }) => {
      providers.push(r.provider);
      return { outcome: r.provider === 'local' ? 'failed' as const : 'succeeded' as const, costUsd: r.costUsd };
    };
    const file = routineFile();
    for (let i = 0; i < 4; i++) await cmdFleetRoutines(['run', file], { adapter });
    expect(providers).toEqual(['local', 'local', 'local', 'codex']);
    stdout.length = 0;
    expect(await cmdFleetRoutines(['explain', 'watchdog'])).toBe(0);
    const rows = JSON.parse(stdout.join(''));
    expect(rows).toHaveLength(4);
    expect(rows[3].decision).toMatchObject({ selected: { provider: 'codex' }, localFailureRate: 1 });
  });

  it('uses the real codex engine adapter when placement selects codex', async () => {
    const routine = watchdog();
    routine.minQuality = 0.95;
    expect(await cmdFleetRoutines(['run', routineFile(routine)])).toBe(0);
    expect(engineRun).toHaveBeenCalledWith('codex', 'Check stalled jobs', expect.anything(),
      expect.objectContaining({ sourceRepo: '/repo', model: 'frontier-model' }));
  });

  it('reserves before execution, blocks a duplicate running receipt and records thrown failures', async () => {
    let inner = 0;
    const code = await cmdFleetRoutines(['run', routineFile()], { adapter: async () => {
      expect(readRoutineLedger()[0]?.outcome).toBe('running');
      inner = await cmdFleetRoutines(['run', routineFile()], { adapter: async () => { throw new Error('must not run'); } });
      throw new Error('local unavailable');
    } });
    expect(inner).toBe(1);
    expect(code).toBe(1);
    expect(readRoutineLedger()).toHaveLength(1);
    expect(readRoutineLedger()[0]).toMatchObject({ outcome: 'failed', costUsd: 0 });
  });

  it('keeps completed engineering work distinct from verified merge outcomes', async () => {
    const routine = { ...watchdog(), outcome: 'merge' as const };
    await runRoutine(routine, async () => ({ outcome: 'succeeded', costUsd: 0 }));
    expect(readRoutineLedger()[0]!.outcome).toBe('succeeded');
    expect(placeRoutine(routine, readRoutineLedger()).candidates[0]!.quality).toBeCloseTo(0.6);
    // Unauthenticated adapter claims of 'merged' cannot come from the CLI's default adapter path.
    expect(engineRun).not.toHaveBeenCalled();
  });

  it('enforces declared budget and measurements; rejects invalid routines before any adapter call', async () => {
    const routine = watchdog();
    routine.minQuality = 0.95;
    routine.budgetUsd = 0;
    expect(await cmdFleetRoutines(['run', routineFile(routine)])).toBe(1);
    expect(engineRun).not.toHaveBeenCalled();
    routine.resources[0]!.costUsd = NaN;
    expect(() => placeRoutine(routine, [])).toThrow('Invalid routine');
    expect(await cmdFleetRoutines(['run', routineFile({ ...watchdog(), sourceRepo: 'relative' })])).toBe(1);
    expect(engineRun).not.toHaveBeenCalled();
  });

  it('refuses grok resources here, fails closed on a corrupt ledger and rejects bad usage', async () => {
    const grok = watchdog();
    grok.resources = [grok.resources[0]!, { provider: 'grok', model: 'g', costUsd: 1, latencyMs: 1, quality: 1, freeQuota: 0 }];
    grok.minQuality = 0.99;
    expect(await cmdFleetRoutines(['run', routineFile(grok)])).toBe(1);
    expect(readRoutineLedger()[0]!.outcome).toBe('failed');
    writeFileSync(join(home, '.ashlr/routines/ledger.json'), '[{"costUsd":-1}]');
    expect(await cmdFleetRoutines(['run', routineFile()])).toBe(1);
    expect(await cmdFleetRoutines(['explain', 'nope'])).toBe(1);
    expect(await cmdFleetRoutines(['bogus'])).toBe(2);
    expect(await cmdFleetRoutines(['run'])).toBe(2);
    expect(await cmdFleetRoutines(['--help'])).toBe(0);
    expect(stderr.join('')).toContain('Usage: phm fleet routines');
  });
});
