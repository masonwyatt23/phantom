/**
 * core/queue/launch-dedupe.ts: skip a READY job whose work already exists.
 *
 * `dedupeQueue` compares READY rows with other queue rows. This adds the other
 * two places finished or in-flight work lives, so a worker is never launched
 * just to find an empty diff:
 *   main      a recent default-branch commit already carries the job id, or
 *             changed the named file with a matching subject;
 *   open PR   a live PR already carries the job id, or touches the named file
 *             with a matching title.
 * Evidence is injected (see launch-evidence.ts), so this is pure and offline.
 *
 * Rules, all deliberately conservative: same repo only; an exact job id in a
 * commit subject, PR title or branch is proof; a goal match needs a shared
 * file AND at least 60% of the evidence title's goal tokens (three or more
 * tokens). Stale evidence never suppresses (a commit older than `mainWindowMs`,
 * a PR idle longer than `prStaleMs`, or any record without a date), and
 * unavailable evidence is a gap, not a verdict. Repeats are marked
 * SUPERSEDED-BY-main-<sha> / SUPERSEDED-BY-pr-<n>; the restocker only admits
 * READY rows, so a marked row cannot launch.
 */
import { readFile } from 'node:fs/promises';
import { dedupeQueue, replaceQueueText } from './dedupe.js';
import { goalSignature } from './semantic-dedupe.js';
import { repoKey } from './supersede.js';

export interface MainCommit { sha: string; subject: string; at: number | null; paths: string[] }
export interface OpenPrRecord { number: number; title: string; headRef: string; updatedAt: number | null; paths: string[] }
/** `null` means that source could not be read; it never counts as "nothing there". */
export interface LaunchEvidence { repo: string; main: MainCommit[] | null; openPrs: OpenPrRecord[] | null }
export interface LaunchDedupeOptions { now?: number; mainWindowMs?: number; prStaleMs?: number }

export interface LaunchAvoid { id: string; via: 'queued' | 'main' | 'open-pr'; of: string; match: 'job-id' | 'goal' | 'acceptance' | 'quoted' | 'semantic-goal' }
export interface LaunchStale { kind: 'main' | 'open-pr'; ref: string; reason: 'older-than-window' | 'undated' }
export interface LaunchDedupeReport {
  schema: 'queue.launch-dedupe.v1';
  /** READY rows looked at. */
  candidates: number;
  /** READY rows left to launch. */
  launch: number;
  avoided: LaunchAvoid[];
  /** One avoided worker launch each: the work already exists, so the run would finish empty. */
  avoidedEmptyLaunches: number;
  stale: LaunchStale[];
  unknown: { id: string | null; line: number; reason: string }[];
  /** Evidence that could not be read; nothing was suppressed on its account. */
  gaps: string[];
  applied: boolean;
}

const DAY = 86_400_000;
const READY = /^\s*-\s+READY\s+(?:\S+\s+)*?([A-Za-z0-9][\w.-]*)(?: r\d+)?\s+\(([^)]*)\):\s*(.*)/i;
const hasPath = (paths: readonly string[], wanted: ReadonlySet<string>): boolean =>
  paths.some(p => [...wanted].some(w => p.toLowerCase() === w || (!w.includes('/') && p.toLowerCase().endsWith(`/${w}`))));
const mentions = (haystack: string, id: string): boolean => new RegExp(`(?<![\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`, 'i').test(haystack);

/** Pure: mark READY rows that main or an open PR already covers. */
export function launchDedupe(text: string, evidence: LaunchEvidence, options: LaunchDedupeOptions = {}): { report: LaunchDedupeReport; output: string } {
  const now = options.now ?? Date.now(), mainWindowMs = options.mainWindowMs ?? 14 * DAY, prStaleMs = options.prStaleMs ?? 3 * DAY;
  const queued = dedupeQueue(text);
  const avoided: LaunchAvoid[] = queued.report.repeats.map(r => ({ id: r.id, via: 'queued', of: r.repeatOf, match: r.match }));
  const stale: LaunchStale[] = [], gaps: string[] = [];
  if (!evidence.repo) gaps.push('repo: identity unavailable');
  if (evidence.main === null) gaps.push('main: default-branch history unavailable');
  if (evidence.openPrs === null) gaps.push('open-pr: snapshot unavailable');
  const live = <T extends { at: number | null }>(kind: LaunchStale['kind'], ref: (r: T) => string, rows: T[] | null, maxAge: number): T[] =>
    (rows ?? []).filter(r => {
      if (r.at === null) { stale.push({ kind, ref: ref(r), reason: 'undated' }); return false; }
      if (now - r.at > maxAge) { stale.push({ kind, ref: ref(r), reason: 'older-than-window' }); return false; }
      return true;
    });
  const main = live('main', c => c.sha.slice(0, 7), evidence.main?.map(c => ({ ...c })) ?? null, mainWindowMs);
  const prs = live('open-pr', p => `#${p.number}`, evidence.openPrs?.map(p => ({ ...p, at: p.updatedAt })) ?? null, prStaleMs);
  const sources = [
    ...main.map(c => ({ via: 'main' as const, ref: `main-${c.sha.slice(0, 7)}`, of: c.sha.slice(0, 7), text: c.subject, paths: c.paths })),
    ...prs.map(p => ({ via: 'open-pr' as const, ref: `pr-${p.number}`, of: `#${p.number}`, text: `${p.title} ${p.headRef}`, paths: p.paths })),
  ].map(s => ({ ...s, tokens: goalSignature(s.text.replace(/^\w+\([^)]*\):?\s*/, '')).tokens }));
  const output = queued.output.split(/(?<=\n)/).map(line => {
    const row = READY.exec(line);
    if (!row) return line;
    const id = row[1]!, repo = /\brepo=(\S+?)(?=[,;\s)]|$)/i.exec(row[2]!)?.[1];
    if (!repo || repoKey(repo) !== repoKey(evidence.repo)) return line;
    const { files, tokens } = goalSignature(row[3]!);
    const exact = sources.find(s => mentions(s.text, id));
    const goal = exact || !files.size || tokens.size < 3 ? undefined : sources.find(s => s.tokens.size >= 3 && hasPath(s.paths, files) &&
      [...s.tokens].filter(t => tokens.has(t)).length / s.tokens.size >= 0.6);
    const hit = exact ?? goal;
    if (!hit) return line;
    avoided.push({ id, via: hit.via, of: hit.of, match: exact ? 'job-id' : 'goal' });
    return line.replace(/^(\s*-\s+)READY\b/i, `$1SUPERSEDED-BY-${hit.ref}`);
  }).join('');
  const ready = (text.match(/^\s*-\s+READY\b/gim) ?? []).length;
  const report: LaunchDedupeReport = { schema: 'queue.launch-dedupe.v1', candidates: ready, launch: ready - avoided.length, avoided,
    avoidedEmptyLaunches: avoided.length, stale, unknown: queued.report.unknown, gaps, applied: false };
  return { report, output };
}

/** Preview, or with `apply` mark the rows under the dispatcher's lock; refuses a queue that changed since it was read. */
export async function launchDedupeFile(path: string, evidence: LaunchEvidence, apply = false, options: LaunchDedupeOptions = {}): Promise<LaunchDedupeReport> {
  const before = await readFile(path, 'utf8');
  const { report, output } = launchDedupe(before, evidence, options);
  if (apply && output !== before) { replaceQueueText(path, before, output); report.applied = true; }
  return report;
}
