import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildFleetVitals } from '../core/fleet/vitals.js';
import { formatFleetVitals } from '../core/fleet/vitals-format.js';

const usage = 'Usage: phm fleet vitals [--json] [--section sources|lanes|budget|admission|host|recent|findings]\nRead bounded, scrubbed fleet evidence; unknown is never zero. No writes or provider calls.';
const sections = ['sources', 'lanes', 'budget', 'admission', 'host', 'recent', 'findings'] as const;

export async function cmdFleetVitals(args: string[], deps: { runsDir?: string; now?: () => number } = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let json = false;
  let section: typeof sections[number] | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--section' && section === undefined) {
      const value = args[++i];
      section = sections.find(s => s === value);
      if (section) continue;
      console.error(usage); return 2;
    } else { console.error(usage); return 2; }
  }
  const vitals = buildFleetVitals(deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), (deps.now ?? Date.now)());
  const selected = section ? { schema: vitals.schema, assembledAt: vitals.assembledAt, truncated: vitals.truncated, [section]: vitals[section] } : vitals;
  console.log(json || section ? JSON.stringify(selected) : formatFleetVitals(vitals));
  return 0;
}
