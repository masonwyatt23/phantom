/** Explicit fleet routine execution: run or explain one declared routine through the existing sandbox adapters. */
import { readFile } from 'node:fs/promises';
import { readRoutineLedger, runRoutine, validateRoutine, type Resource, type Routine } from '../core/routines/index.js';
import type { AshlrConfig } from '../core/types.js';

const USAGE = `Usage: phm fleet routines run <routine.json> [--json]
       phm fleet routines explain <routine-id> [--json]

run executes one declared routine through the existing sandboxed engine (admission and sandbox
controls unchanged) and records a private receipt. Completed work is "succeeded"; "merged" appears
only from authenticated merge evidence. explain prints every retained receipt for the routine.
Exits 0 ok, 1 refused/failed, 2 bad usage. Does not schedule anything.
`;

type Adapter = (resource: Resource, routine: Routine, cfg: AshlrConfig) => Promise<{
  outcome: 'succeeded' | 'failed'; costUsd: number; proposalId?: string }>;

/** Default adapter: the existing sandboxed engines. Grok Bot transport is not part of this surface. */
const sandboxAdapter: Adapter = async (resource, routine, cfg) => {
  const { runEngineSandboxed, runApiModelSandboxed } = await import('../core/run/sandboxed-engine.js');
  if (resource.provider === 'grok') throw new Error('Grok routine execution is not supported here.');
  const engine = { local: 'local-coder', codex: 'codex', claude: 'claude', devin: 'devin-cli' } as const;
  const config = resource.provider === 'local' ? {
    ...cfg, foundry: { ...cfg.foundry, engines: { ...cfg.foundry?.engines,
      'local-coder': { id: 'local-coder', kind: 'api-model' as const, tier: 'mid' as const,
        api: { envKey: '', defaultBaseUrl: 'http://127.0.0.1:8000/v1', defaultModel: resource.model, protocol: 'openai' as const },
        capabilities: ['agent', 'edit', 'tools'] },
    } },
  } as AshlrConfig : cfg;
  const run = resource.provider === 'local' ? runApiModelSandboxed : runEngineSandboxed;
  const result = await run(engine[resource.provider], routine.goal, config, { sourceRepo: routine.sourceRepo, model: resource.model });
  // Completion is not a merge; the ledger later joins authenticated inbox evidence.
  return { outcome: result.state.status === 'done' ? 'succeeded' : 'failed', costUsd: result.state.usage.estCostUsd, proposalId: result.proposalId };
};

export interface FleetRoutinesDeps { adapter?: Adapter; loadConfig?: () => AshlrConfig }

export async function cmdFleetRoutines(args: string[], deps: FleetRoutinesDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { process.stdout.write(USAGE); return 0; }
  const json = args.includes('--json');
  const [verb, target, ...extra] = args.filter(a => a !== '--json');
  if ((verb !== 'run' && verb !== 'explain') || !target || target.startsWith('--') || extra.length) {
    process.stderr.write(USAGE); return 2;
  }
  try {
    if (verb === 'explain') {
      const rows = readRoutineLedger().filter(x => x.routineId === target);
      if (!rows.length) throw new Error('No recorded placement for routine.');
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return 0;
    }
    const routine = JSON.parse(await readFile(target, 'utf8')) as Routine;
    validateRoutine(routine);
    const cfg = deps.loadConfig ? deps.loadConfig() : (await import('../core/config.js')).loadConfig();
    const adapter = deps.adapter ?? sandboxAdapter;
    const receipt = await runRoutine(routine, resource => adapter(resource, routine, cfg));
    process.stdout.write(json ? JSON.stringify(receipt, null, 2) + '\n'
      : `${receipt.routineId}: ${receipt.outcome} via ${receipt.provider}/${receipt.model} (${receipt.metric}, $${receipt.costUsd})\n`);
    return receipt.outcome === 'failed' ? 1 : 0;
  } catch {
    process.stderr.write('Routine refused or failed; inspect configuration and private ledger.\n');
    return 1;
  }
}
