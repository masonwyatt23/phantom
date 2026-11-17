import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** Machinery is adopted through fleet/sync.py; source execution supports review. */
export async function cmdFleetJanitor(args: string[]): Promise<number> {
  const source = fileURLToPath(new URL('../../contrib/mac/fleet_janitor.py', import.meta.url));
  const installed = join(homedir(), '.ashlr-runs/bin/fleet_janitor.py');
  try {
    const result = await promisify(execFile)('python3', [existsSync(source) ? source : installed, ...args],
      { timeout: 35_000, maxBuffer: 2 * 1024 * 1024 });
    process.stdout.write(result.stdout);
    return 0;
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    process.stdout.write(failure.stdout || JSON.stringify({ schema: 'fleet.janitor.v1', error: 'janitor-unavailable' }) + '\n');
    return failure.code === 2 ? 2 : 1;
  }
}
