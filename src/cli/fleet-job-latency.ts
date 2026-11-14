import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { jobLatency } from '../core/fleet/job-latency.js';

export { jobLatency } from '../core/fleet/job-latency.js';

const usage = 'Usage: phm fleet job-latency [--jobs <jobs.jsonl>] [--json]';
export async function cmdFleetJobLatency(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let path = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl');
  let json = false, seenPath = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--jobs' && !seenPath && args[i + 1] && !args[i + 1]!.startsWith('--')) { path = args[++i]!; seenPath = true; }
    else { console.error(usage); return 2; }
  }
  try {
    const report = jobLatency(await readFile(path, 'utf8'));
    console.log(json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
    return 0;
  } catch { console.error('error: unable to read jobs ledger'); return 1; }
}
