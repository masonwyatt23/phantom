import { readFleetHealth } from '../core/fleet/health.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export async function cmdFleetHealth(args: string[], opts: Parameters<typeof readFleetHealth>[0] = {}): Promise<number> {
  const usage = 'Usage: phm fleet health [--json]\nFive read-only answers: main, merges, pools, wasted starts and unreleased work.';
  if (args.some(arg => arg === '--help' || arg === '-h')) { console.log(usage); return 0; }
  if (args.some(arg => arg !== '--json')) { console.error(usage); return 2; }
  const report = await readFleetHealth(opts);
  console.log(args.includes('--json') ? JSON.stringify(sanitizePublicJson(report)) : sanitizePublicJson(report.lines.map(line => line.text).join('\n')));
  return 0;
}
