import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Outcome of one child run; the subset of spawnSync's result this verb reads. */
export interface FleetDevloopRun {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

export interface FleetDevloopDeps {
  /** Absolute path of the gate script. Defaults to this checkout's scripts/gate.mjs. */
  script?: string;
  exists?: (path: string) => boolean;
  run?: (command: string, args: string[]) => FleetDevloopRun;
  err?: (line: string) => void;
}

const USAGE = `Usage: ashlr fleet devloop [gate options]
Runs the repository development check: node scripts/gate.mjs --check, with every
further argument forwarded unchanged (for example --base <ref> or --json).
Output streams straight through and the exit code is the gate's own.
Exit: 0 pass, 1 fail, 2 usage error or gate script missing.`;

const DEFAULT_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/gate.mjs');

/** `ashlr fleet devloop`: run the existing gate in --check mode. Never builds or edits anything itself. */
export async function cmdFleetDevloop(args: string[], deps: FleetDevloopDeps = {}): Promise<number> {
  const err = deps.err ?? ((line: string) => { process.stderr.write(line + '\n'); });
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const script = deps.script ?? DEFAULT_SCRIPT;
  if (!(deps.exists ?? existsSync)(script)) {
    err(`fleet devloop: gate script not found at ${script}`);
    return 2;
  }
  // Argument array, no shell: forwarded args cannot be reinterpreted.
  const run = deps.run ?? ((command, argv) => spawnSync(command, argv, { stdio: 'inherit' }));
  const result = run(process.execPath, [script, '--check', ...args]);
  if (result.error) {
    err(`fleet devloop: could not run the gate: ${result.error.message}`);
    return 1;
  }
  if (result.status === null) {
    err(`fleet devloop: gate terminated by signal ${result.signal ?? 'unknown'}`);
    return 1;
  }
  return result.status;
}
