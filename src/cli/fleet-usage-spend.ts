import { readUsageSpend } from '../core/usage/spend.js';

export async function cmdFleetUsageSpend(args: string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error('Usage: phm fleet usage-spend [--json]');
    return 2;
  }
  const snapshot = await readUsageSpend();
  if (args[0] === '--json') console.log(JSON.stringify(snapshot, null, 2));
  else for (const row of snapshot.pools) console.log(row.reason ? `${row.pool}: unknown (${row.reason})` : `${row.pool}: ${row.usedPercent}% used; reset ${row.resetAt}; ${row.hoursLeft!.toFixed(1)} hours left; ${row.burnPerHour}% per hour; ${row.projectedUnusedPercent!.toFixed(1)}% projected unused at reset`);
  return 0;
}
