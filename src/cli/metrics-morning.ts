import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dispatchTimestampMs, readDispatchEvents } from '../core/fabric/dispatch-events.js';
import { dispatchEventsCandidates } from '../core/fleet/dispatch-events-path.js';
import { parseReadyRows } from '../core/fleet/ready-row-edit.js';
import {
  buildMorningReport, mergeMorningReport, parseMorningPrs, type AppObservation, type DispatchEventLike,
} from '../core/metrics/morning.js';
import { writePrivateFileAtomic } from '../core/verse/preferences.js';

export const MORNING_USAGE = `Usage: phm metrics morning [--json] [--prs <gh-export.json>] [--runs-dir <dir>] [--app <Phantom.app>] [--probe-url <loopback url>] [--merge-into <report.json>] [--now <iso>]
Last-24h morning measurements: features added and cut, dead code and net lines, Devin absorption, Phantom.app status,
cost per merged PR, feedback loop minutes and node capacity. Read-only except --merge-into, which backs the file up
(<file>.bak-<timestamp>) and replaces only the seven owned keys. Unreadable sources are reported as missing with a reason.
--prs takes a gh export, for example: gh pr list --repo ashlrai/<repo> --state all --limit 300 --json number,title,state,url,mergedAt,additions,deletions,headRefName,files
Exit 0: report or help. Exit 1: --merge-into failed. Exit 2: invalid arguments.
`;

interface Io { out: (line: string) => void; err: (line: string) => void }

const reasonOf = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES' ? 'permission denied (not readable from this process)' : code === 'ENOENT' ? 'file not found' : 'unreadable';
};
const readText = (path: string): { text: string } | { reason: string } => {
  try {
    if (!lstatSync(path).isFile()) return { reason: 'not a regular file' };
    return { text: readFileSync(path, 'utf8') };
  } catch (e) { return { reason: reasonOf(e) }; }
};

function plistVersion(appPath: string): { version: string | null; installedAtMs: number | null; reason?: string } {
  const plist = join(appPath, 'Contents', 'Info.plist');
  try {
    const version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { version: version || null, installedAtMs: lstatSync(plist).mtimeMs };
  } catch (e) { return { version: null, installedAtMs: null, reason: `Info.plist ${reasonOf(e)}` }; }
}

function isRunning(appPath: string): boolean | null {
  try {
    // pgrep exits 1 when nothing matches (running: false); any other failure leaves it unknown.
    const pattern = `^${appPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Contents/MacOS/`;
    execFileSync('/usr/bin/pgrep', ['-f', pattern], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (e) { return (e as { status?: number }).status === 1 ? false : null; }
}

/** Loopback only: this probe must never leave the machine. */
async function probe(url: string): Promise<{ url: string; ok: boolean; httpStatus: number | null }> {
  const u = new URL(url);
  if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) throw new Error('--probe-url must be http://127.0.0.1 or http://localhost');
  try {
    const res = await fetch(u, { method: 'GET', signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return { url: u.origin + u.pathname, ok: res.status >= 200 && res.status < 400, httpStatus: res.status };
  } catch { return { url: u.origin + u.pathname, ok: false, httpStatus: null }; }
}

async function readIdeaTimes(readyPath: string): Promise<Map<string, number>> {
  const ideas = new Map<string, number>();
  const ready = readText(readyPath);
  if (!('text' in ready)) return ideas;
  for (const row of parseReadyRows(ready.text)) {
    if (!row.id || !row.promptPath) continue;
    try {
      const st = lstatSync(row.promptPath);
      if (st.isFile()) ideas.set(row.id, st.mtimeMs);
    } catch { /* prompt gone: not measurable */ }
  }
  return ideas;
}

export async function cmdMetricsMorning(args: string[], io: Io): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { io.out(MORNING_USAGE.trimEnd()); return 0; }
  const opts = new Map<string, string>();
  let json = false, bad = args[0] !== 'morning';
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (['--prs', '--runs-dir', '--app', '--probe-url', '--merge-into', '--now'].includes(a) && !opts.has(a)) {
      const v = args[++i];
      if (!v || v.startsWith('-')) bad = true; else opts.set(a, v);
    } else bad = true;
  }
  const nowMs = opts.has('--now') ? dispatchTimestampMs(opts.get('--now')!) : Date.now();
  if (bad || nowMs === null) { io.err(MORNING_USAGE.trimEnd()); return 2; }

  const runs = opts.get('--runs-dir') ?? join(homedir(), '.ashlr-runs');
  const appPath = (opts.get('--app') ?? '/Applications/Phantom.app').replace(/\/+$/, '');

  let prs = null as ReturnType<typeof parseMorningPrs>['rows'] | null;
  if (opts.has('--prs')) {
    const f = readText(opts.get('--prs')!);
    if ('text' in f) prs = parseMorningPrs(f.text).rows;
  }

  let events: DispatchEventLike[] | null = null, dispatchReason: string | null = null;
  for (const path of dispatchEventsCandidates(runs)) {
    try {
      const rep = await readDispatchEvents({ path, since: new Date(nowMs - 2 * 86_400_000).toISOString(), max: 200_000 });
      if (rep.source === 'present') { events = rep.events; break; }
      dispatchReason = 'dispatch-events.log not found';
    } catch (e) { dispatchReason = `dispatch-events.log ${reasonOf(e)}`; }
  }

  let ledger: unknown = null, ledgerReason: string | null = null;
  const lf = readText(join(runs, 'queue', 'fleet-ledger.json'));
  if ('text' in lf) { try { ledger = JSON.parse(lf.text); } catch { ledgerReason = 'fleet-ledger.json is not valid JSON'; } } else ledgerReason = `fleet-ledger.json ${lf.reason}`;

  const meta = plistVersion(appPath);
  let views: AppObservation['views'] = null;
  if (opts.has('--probe-url')) {
    try { views = [await probe(opts.get('--probe-url')!)]; } catch (e) { io.err((e as Error).message); return 2; }
  }
  const app: AppObservation = { ...meta, running: meta.version === null ? null : isRunning(appPath), views };

  const report = buildMorningReport({
    nowMs, prs, dispatchEvents: events, dispatchReason, app, ledger, ledgerReason,
    ideaAtMs: await readIdeaTimes(join(runs, 'queue', 'ready.tsv')),
  });

  const target = opts.get('--merge-into');
  if (target) {
    try {
      let existing: Record<string, unknown> = {};
      try {
        if (lstatSync(target).isSymbolicLink()) throw new Error('refusing a symlink');
        const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('existing report is not a JSON object');
        existing = parsed as Record<string, unknown>;
        copyFileSync(target, `${target}.bak-${new Date(nowMs).toISOString().replace(/[-:.]/g, '')}`);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      writePrivateFileAtomic(target, JSON.stringify(mergeMorningReport(existing, report), null, 2) + '\n');
    } catch (e) {
      io.err(`phm metrics morning: could not merge into the report (${(e as Error).message}); existing file left unchanged.`);
      return 1;
    }
  }
  io.out(json || !target ? JSON.stringify(report, null, 2) : `Merged morning metrics into ${target}`);
  return 0;
}
