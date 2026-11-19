import { homedir } from 'node:os';
import { join } from 'node:path';
import { dedupeQueueFile } from '../core/queue/dedupe.js';
import { launchDedupeFile } from '../core/queue/launch-dedupe.js';
import { readLaunchEvidence } from '../core/queue/launch-evidence.js';

const help = `Usage: phm queue dedupe [--file <router-queue.md>] [--launch] [--apply] [--json]
Find repeated READY jobs; claimed/running goals take precedence over new work.
By default, show matches and reasons. Add --apply to mark repeats.
Semantic repeats share a file/module and >=50% goal tokens: DUPLICATE-OF-<id>.
Jobs missing a repo, file/module or goal tokens are unknown and left alone.
--launch also skips READY jobs that main (last 14 days) or an open PR already
covers, and reports the empty launches avoided. Run it from the repo checkout.`;
export async function cmdQueueDedupe(args: string[]): Promise<number> {
  let file = join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'queue', 'router-queue.md');
  let apply = false, json = false, launch = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { console.log(help); return 0; }
    if (args[i] === '--apply') apply = true;
    else if (args[i] === '--launch') launch = true;
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--file' && args[i + 1] && !args[i + 1]!.startsWith('--')) file = args[++i]!;
    else { console.error(help); return 2; }
  }
  try {
    if (launch) {
      const report = await launchDedupeFile(file, await readLaunchEvidence(), apply);
      if (json) console.log(JSON.stringify(report));
      else {
        console.log(`${report.avoidedEmptyLaunches} empty launches avoided${report.applied ? ' (marked)' : ' (preview)'}; ${report.launch} of ${report.candidates} READY jobs left to launch.`);
        for (const row of report.avoided) console.log(`${row.id} already covered by ${row.of} (${row.via}, ${row.match})`);
        console.log(`Stale evidence ignored: ${report.stale.length}`);
        for (const gap of report.gaps) console.log(`Gap: ${gap}`);
      }
      return 0;
    }
    const report = await dedupeQueueFile(file, apply);
    if (json) console.log(JSON.stringify(report));
    else {
      console.log(`${report.count} repeats${report.applied ? ' marked' : ' (preview)'}.`);
      for (const row of report.repeats) console.log(`${row.id} repeats ${row.repeatOf} (${row.reason ?? row.match})`);
      console.log(`Unknown: ${report.unknown.length}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue unavailable';
    if (json) console.log(JSON.stringify({ error: message })); else console.error(message);
    return 1;
  }
}
