import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findQueueDupes } from '../core/fleet/queue-dupes.js';

export async function cmdFleetQueueDupes(args: string[]): Promise<number> {
  const usage = 'Usage: ashlr fleet queue-dupes [--json]';
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(usage); return 2; }
  try {
    const text = await readFile(join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'queue', 'ready.tsv'), 'utf8');
    const result = findQueueDupes(text);
    if (args[0] === '--json') console.log(JSON.stringify(result));
    else {
      console.log('Duplicate IDs\tKeep');
      for (const group of result.dupGroups) console.log(`${group.ids.join(', ')}\t${group.keep ?? 'unknown'}`);
      console.log('Job\tAge');
      for (const row of result.stale) console.log(`${row.id}\t${row.ageMs === null ? 'unknown' : `${Math.floor(row.ageMs / 3_600_000)}h`}`);
    }
    return 0;
  } catch { console.error('fleet queue-dupes: queue unavailable'); return 1; }
}
