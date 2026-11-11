/**
 * Read-only: how long have allowlisted teammate texts (Dot / "Ashlr.") waited for a reply?
 * Agent-facing verb over the current teammate inbox. Prints counts, ages and timestamps
 * only: never bodies, handles or sender ids.
 *
 * Waiting texts come from the inbox's open set (readTeammateTexts without includeAnswered),
 * not from the pairing in teammateReplyGapFromInbox. That pairing treats an open text as
 * answered whenever a later text was answered, so it can report zero waiting while an older
 * text is still open. Answered texts only contribute a receipt time.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTeammateTexts, type TeammateSourceState } from '../core/comms/imessage-teammate-inbox.js';

const usage = 'Usage: phm fleet teammate-gap [--runs-dir <path>] [--json]';
export const TEAMMATE_GAP_WARN_MINUTES = 5;
const WARN_AFTER_MS = TEAMMATE_GAP_WARN_MINUTES * 60_000;

export interface FleetTeammateGapDeps {
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Overrides --runs-dir / ASHLR_RUNS_DIR / ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => number;
}

export interface TeammateGapEntry {
  /** Generic label (`Teammate N`), numbered by sender-id order inside the store. */
  label: string;
  state: 'ok' | 'late';
  unansweredCount: number;
  oldestUnansweredAt: string | null;
  oldestUnansweredAgeMinutes: number | null;
  lastInboundAt: string | null;
  /** Receipt time of an answered text. The inbox records no send time, so this is not when the reply went out. */
  lastAnsweredReceiptAt: string | null;
}

export interface TeammateGapReport {
  schema: 'fleet.teammate-gap.v1';
  generatedAt: string;
  /** `late` if any teammate waits past the threshold; `unknown` with no store or a degraded store; else `ok`. */
  state: 'ok' | 'late' | 'unknown';
  sourceState: TeammateSourceState;
  warnAfterMinutes: number;
  answeredTimestampBasis: 'inbound-receipt';
  teammates: TeammateGapEntry[];
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Reads the teammate inbox (read-only) and builds the report. Sender ids stay in memory. */
export function buildTeammateGapReport(now: number, runsDir: string): TeammateGapReport {
  const base = { schema: 'fleet.teammate-gap.v1' as const, generatedAt: new Date(now).toISOString(),
    warnAfterMinutes: TEAMMATE_GAP_WARN_MINUTES, answeredTimestampBasis: 'inbound-receipt' as const };
  const all = readTeammateTexts({ runsDir, includeAnswered: true, now: () => now });
  if (all.sourceState === 'missing') return { ...base, state: 'unknown', sourceState: 'missing', teammates: [] };
  const open = new Set(readTeammateTexts({ runsDir, now: () => now }).texts.map(text => text.rowid));
  const senderIds = [...new Set(all.texts.map(text => text.senderId))].sort();
  const groups = new Map(senderIds.map((id, index) => [id, {
    label: `Teammate ${index + 1}`,
    waiting: [] as number[],
    lastInbound: null as number | null,
    lastAnswered: null as number | null,
  }]));
  for (const text of all.texts) {
    const group = groups.get(text.senderId)!;
    const time = Date.parse(text.at);
    group.lastInbound = Math.max(group.lastInbound ?? time, time);
    if (open.has(text.rowid)) group.waiting.push(time);
    else group.lastAnswered = Math.max(group.lastAnswered ?? time, time);
  }
  const teammates = [...groups.values()].map((group): TeammateGapEntry => {
    const oldest = group.waiting.length ? Math.min(...group.waiting) : null;
    const ageMs = oldest === null ? 0 : Math.max(0, now - oldest);
    return {
      label: group.label,
      state: oldest !== null && ageMs >= WARN_AFTER_MS ? 'late' : 'ok',
      unansweredCount: group.waiting.length,
      oldestUnansweredAt: iso(oldest),
      oldestUnansweredAgeMinutes: oldest === null ? null : Math.floor(ageMs / 60_000),
      lastInboundAt: iso(group.lastInbound),
      lastAnsweredReceiptAt: iso(group.lastAnswered),
    };
  }).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const state = teammates.some(t => t.state === 'late') ? 'late'
    : all.sourceState === 'degraded' ? 'unknown' : 'ok';
  return { ...base, state, sourceState: all.sourceState, teammates };
}

function formatLines(report: TeammateGapReport): string[] {
  if (report.sourceState === 'missing') return ['Teammate reply gap: unknown (no teammate store found).'];
  const lines = [`Teammate reply gap: ${report.state} (store ${report.sourceState}, warn after ${report.warnAfterMinutes}m)`];
  for (const t of report.teammates) {
    const waiting = t.unansweredCount > 0
      ? `${t.unansweredCount} waiting, oldest ${t.oldestUnansweredAgeMinutes}m (since ${t.oldestUnansweredAt})`
      : '0 waiting';
    lines.push(`  ${t.label}: ${t.state}, ${waiting}, last inbound ${t.lastInboundAt}`);
  }
  if (report.teammates.length === 0 && report.sourceState === 'healthy') lines.push('  no teammate texts on record');
  lines.push('Answered times are inbound receipt times, not measured send times.');
  return lines;
}

export async function cmdFleetTeammateGap(args: string[], deps: FleetTeammateGapDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output(`${usage}\nShow whether allowlisted teammate texts (Dot / "Ashlr.") are waiting for a reply, with counts, ages and timestamps. Read-only; no bodies, handles or sender ids.\nExit 2 on invalid arguments.`);
    return 0;
  }
  let runsFlag: string | undefined;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir') {
      const value = args[++i];
      if (value === undefined || value === '' || value.startsWith('--')) return invalid();
      runsFlag = value;
    } else return invalid();
  }
  const runsDir = runsFlag ?? deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const report = buildTeammateGapReport((deps.now ?? Date.now)(), runsDir);
  output(json ? JSON.stringify(report) : formatLines(report).join('\n'));
  return 0;

  function invalid(): number {
    error(`error: invalid arguments. ${usage}`);
    return 2;
  }
}
