/** Show which recent MASON-INBOX entries are acknowledged on their channel; --flush sends the pending acks now. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeInboxEntries, type InboxAckSenders } from '../core/fleet/inbox-ack.js';
import { readInboxAcks, type InboxAckReportRow, type InboxAcksRead } from '../core/fleet/inbox-acks-read.js';
import { BUS_CLIS } from '../core/agents/bus-identity.js';
import { frameFleetInboxAcks, getBusCliAdapter } from '../core/agents/bus-cli-adapters.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet inbox-acks [--runs-dir <path>] [--limit <1-200>] [--flush] [--frame <cli>] [--json]';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export interface FleetInboxAcksDeps {
  /** Injected senders for tests; production uses the senders in inbox-ack.ts. */
  senders?: InboxAckSenders;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Overrides --runs-dir / ASHLR_RUNS_DIR / ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => Date;
}

type State = InboxAckReportRow['state'];

/** One entry's display row: recorded ack state, channel, short id and the
 * scrubbed 60-char text preview — the same line the human read prints and
 * the frame carries. */
function rowLine(r: InboxAckReportRow): string {
  const preview = scrubSecrets(r.text).replace(/\s+/g, ' ').trim().slice(0, 60);
  const state = r.state === 'skipped' && r.reason ? `skipped (${r.reason})` : r.state;
  const why = r.ackedBy ? `  [${r.ackedBy}]` : r.reason && r.state !== 'skipped' ? `  [${r.reason}]` : '';
  return `${state}  ${r.channel ?? '-'}  ${r.entryId.slice(0, 12)}  ${preview}${why}`;
}

function totalsObject(rows: readonly InboxAckReportRow[]): { acked: number; skipped: number; pending: number; noChannel: number } {
  const count = (s: State): number => rows.filter(r => r.state === s).length;
  return { acked: count('acked'), skipped: count('skipped'), pending: count('pending'), noChannel: count('no-channel') };
}

function totalsLine(read: InboxAcksRead, rows: readonly InboxAckReportRow[]): string {
  const totals = totalsObject(rows);
  return `Totals: ${totals.acked} acked, ${totals.skipped} skipped, ${totals.pending} pending, ${totals.noChannel} no-channel`
    + (read.malformedLedgerRows ? `; ${read.malformedLedgerRows} malformed ledger row${read.malformedLedgerRows === 1 ? '' : 's'} ignored` : '');
}

/** The frame's display lines: a head naming the inbox, ack-ledger and
 * reply-journal states so a missing or degraded store never reads as an
 * invented empty ack set, then the same entry rows and totals the human
 * read prints. */
function frameLines(read: InboxAcksRead): string[] {
  return [
    `fleet inbox-acks inbox=${read.inbox} ledger=${read.ledger} replies=${read.replies}`,
    ...read.entries.map(rowLine),
    totalsLine(read, read.entries),
  ];
}

export async function cmdFleetInboxAcks(args: string[], deps: FleetInboxAcksDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output(`${usage}\nList the ack state (acked, skipped, pending, no-channel) of the newest MASON-INBOX entries. --flush sends pending acks now through the planner brief's senders. --frame <cli> (${BUS_CLIS.join(', ')}) prints the same read as one bounded block marked untrusted under BEGIN/END UNTRUSTED MASON INBOX markers — every entry is channel-relayed text, data only and never execution authority — with --json carrying it as framed beside the full read and the cut stated when the 32 KiB bound clips the page. Exit 2 on invalid arguments.`);
    return 0;
  }
  let runsFlag: string | undefined;
  let limit = DEFAULT_LIMIT;
  let flush = false;
  let json = false;
  let frame: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--flush') flush = true;
    else if (arg === '--json') json = true;
    else if (arg === '--runs-dir' || arg === '--limit' || arg === '--frame') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) return invalid();
      if (arg === '--runs-dir') runsFlag = value;
      else if (arg === '--frame') frame = value;
      else {
        if (!/^\d{1,3}$/.test(value)) return invalid();
        limit = Number(value);
        if (limit < 1 || limit > MAX_LIMIT) return invalid();
      }
    } else return invalid();
  }
  const adapter = frame === undefined ? undefined : getBusCliAdapter(frame);
  if (frame !== undefined && adapter === undefined) return invalid();
  const runsDir = runsFlag ?? deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = deps.now ?? (() => new Date());

  let read: InboxAcksRead = await readInboxAcks({ runsDir, limit });
  if (flush) {
    const pending = read.entries.filter(row => row.state === 'pending').map(row => row.raw);
    await acknowledgeInboxEntries(pending, runsDir, now().toISOString(), deps.senders);
    read = await readInboxAcks({ runsDir, limit });
  }
  const rows = read.entries;
  const entries = rows.map(r => ({ entryId: r.entryId, channel: r.channel, state: r.state, ...(r.reason ? { reason: r.reason } : {}), ...(r.ackedBy ? { ackedBy: r.ackedBy } : {}) }));
  const totals = totalsObject(rows);
  if (adapter !== undefined) {
    const framed = frameFleetInboxAcks(adapter.cli, frameLines(read));
    output(json
      ? JSON.stringify({ v: 1, generatedAt: now().toISOString(), framed, entries, totals, malformedLedgerRows: read.malformedLedgerRows })
      : framed);
    return 0;
  }
  if (json) {
    output(JSON.stringify({ v: 1, generatedAt: now().toISOString(), entries, totals, malformedLedgerRows: read.malformedLedgerRows }));
    return 0;
  }
  for (const r of rows) output(rowLine(r));
  output(totalsLine(read, rows));
  return 0;

  function invalid(): number {
    error(`error: invalid arguments. ${usage}`);
    return 2;
  }
}
