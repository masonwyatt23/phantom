/**
 * `ashlr fleet salvage` — one read of the retained diffs a finished job left
 * behind when its publish aborted (RQ-PHX-SALVAGEREAD86).
 *
 * READ-ONLY verb: it reports what `src/core/fleet/salvage-index.ts` sees under
 * `salvage/` — entry id, file count, size, age and whether a phantom PR ever
 * came out of it — so a planner or the Leader can find finished work to recut.
 * Nothing moves, deletes or republishes.
 *
 * Exit codes: 0 the read ran (including `absent`), 1 the salvage dir exists
 * but cannot be read, 2 bad usage.
 */

import { readSalvageIndex, type SalvageEntry } from '../core/fleet/salvage-index.js';

const usage = 'Usage: ashlr fleet salvage [--json] [--unpublished]\n'
  + 'List retained diffs under salvage/ for finished jobs whose publish aborted, newest first. '
  + '--unpublished keeps only entries that never became a PR. Read-only.';

export interface FleetSalvageOptions {
  /** Runs root; defaults to $ASHLR_RUNS_DIR then ~/.ashlr-runs. */
  runsDir?: string;
  /** Clock for the age column; defaults to Date.now(). */
  now?: number;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

function ageText(modifiedAt: string, now: number): string {
  const ms = Date.parse(modifiedAt);
  const minutes = Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / 60_000)) : 0;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function formatEntry(entry: SalvageEntry, now: number): string {
  const pr = entry.publishedPr === null ? 'no PR' : `PR #${entry.publishedPr}`;
  return `${entry.id}\t${entry.fileCount} files\t${Math.round(entry.bytes / 1024)} KB\t${ageText(entry.modifiedAt, now)}\t${pr}`;
}

export async function cmdFleetSalvage(args: string[], options: FleetSalvageOptions = {}): Promise<number> {
  const output = options.output ?? console.log;
  const error = options.error ?? console.error;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { output(usage); return 0; }
  let json = false, unpublishedOnly = false;
  const seen = new Set<string>();
  for (const flag of args) {
    if (!['--json', '--unpublished'].includes(flag) || seen.has(flag)) { error(usage); return 2; }
    seen.add(flag);
    if (flag === '--json') json = true; else unpublishedOnly = true;
  }
  const report = await readSalvageIndex(options.runsDir);
  if (report.state === 'unavailable') { error('error: salvage index unavailable (cannot read salvage/)'); return 1; }
  const entries = unpublishedOnly ? report.entries.filter(entry => entry.publishedPr === null) : report.entries;
  if (json) { output(JSON.stringify({ ...report, entries })); return 0; }
  if (!entries.length) { output('No salvaged work.'); return 0; }
  const now = options.now ?? Date.now();
  for (const entry of entries) output(formatEntry(entry, now));
  return 0;
}
