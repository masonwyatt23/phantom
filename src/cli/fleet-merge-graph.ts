/** Read-only hourly merge history from the local jobs ledger. */
import { mergeGraph } from '../core/fleet/merge-graph.js';
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';

const usage = 'Usage: ashlr fleet merge-graph [--json]';

export async function cmdFleetMergeGraph(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nShow unique MERGED job outcomes in 24 hourly buckets by lane, with median known time to merge per bucket. Lane comes from the outcome row, else the latest launch at or before the merge. Reads ~/.ashlr-runs/metrics/jobs.jsonl; an unreadable file reports known:false. JSON preserves metrics.merges.v1.`);
    return 0;
  }
  if (args.length > 1 || args.some(arg => arg !== '--json')) {
    console.error(`error: invalid fleet merge-graph arguments\n${usage}`);
    return 2;
  }
  let raw: string | null;
  try { raw = await read(); } catch { raw = null; }
  const report = mergeGraph(raw, now);
  if (args.includes('--json')) {
    console.log(JSON.stringify(report));
    return 0;
  }
  const lanes = report.lanes ?? [];
  console.log(!report.known ? 'Merge graph: unknown (metrics unreadable)'
    : lanes.length === 0 ? 'Merge graph: no merges in the last 24 hours'
    : lanes.map(lane => {
      const merges = lane.buckets.reduce((sum, bucket) => sum + bucket.merges, 0);
      return `${lane.lane}: ${merges} merge${merges === 1 ? '' : 's'}`;
    }).join('\n'));
  return 0;
}
