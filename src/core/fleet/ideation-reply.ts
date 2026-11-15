/** Latest daily ideation plan for the owner's Slack thread. The ideation loop
 * (research/ideation-loop.ts) writes docs/strategy/IDEATION-<YYYY-MM-DD>.md on
 * `fleet ideation complete --apply`; this reads the newest one by filename
 * date and formats a bounded, read-only reply. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readResearchFile } from '../research/queue.js';
import { scrubSecrets } from '../util/scrub-secrets.js';

const STRATEGY_DIR = join('docs', 'strategy');
const NAME = /^IDEATION-(\d{4}-\d{2}-\d{2})\.md$/;
const MAX_ENTRIES = 400;
const MAX_BYTES = 64 * 1024;
const STALE_DAYS = 2;
const MAX_TITLES = 5;
const MAX_TITLE = 120;
const DAY_MS = 86_400_000;

export interface IdeationRead {
  status: 'ok' | 'absent' | 'unavailable';
  /** YYYY-MM-DD from the newest file's name. */
  day?: string;
  /** Repo-relative path of the newest file (forward slashes). */
  relPath?: string;
  /** Selected proposal titles, or markdown headings when none parse. */
  titles?: string[];
  /** Fixed reason when status is 'unavailable'. */
  reason?: string;
}

/** Reader seams so tests never touch a real checkout. */
export interface IdeationReadDeps {
  /** Directory listing; the default is readdir with dirents. */
  readDir?: (dir: string) => Promise<Array<{ name: string; isFile(): boolean }>>;
  /** Bounded file read; the default is readResearchFile (O_NOFOLLOW). */
  readFile?: (path: string, maxBytes: number) => Promise<string>;
}

/** Reject rollover dates like IDEATION-2026-13-99.md. */
function validDay(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

/** Selected-proposal bullets, else markdown headings; ≤5, each ≤120 chars. */
function extractTitles(markdown: string): string[] {
  const lines = markdown.split('\n');
  const bullets: string[] = [];
  let inSelected = false;
  for (const line of lines) {
    const heading = /^#{1,6}\s+(\S.*)$/.exec(line.trim());
    if (heading !== null) {
      inSelected = /^selected\b/i.test(heading[1]);
      continue;
    }
    const bullet = inSelected ? /^[-*]\s+(\S.*)$/.exec(line.trim())?.[1] : undefined;
    if (bullet !== undefined) bullets.push(bullet);
    if (bullets.length >= MAX_TITLES) break;
  }
  const titles = bullets.length > 0
    ? bullets
    : lines.flatMap(line => /^#{1,6}\s+(\S.*)$/.exec(line.trim())?.slice(1) ?? []).slice(0, MAX_TITLES);
  return titles.map(title => title.replace(/\p{Cc}/gu, ' ').slice(0, MAX_TITLE));
}

/** Newest regular IDEATION-*.md under <repoRoot>/docs/strategy, bounded. */
export async function readLatestIdeation(repoRoot: string, deps: IdeationReadDeps = {}): Promise<IdeationRead> {
  const dir = join(repoRoot, STRATEGY_DIR);
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await (deps.readDir ?? (d => readdir(d, { withFileTypes: true })))(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { status: 'absent' }
      : { status: 'unavailable', reason: 'strategy directory unreadable' };
  }
  const newest = entries.slice(0, MAX_ENTRIES)
    .flatMap(entry => {
      if (!entry.isFile()) return [];
      const day = NAME.exec(entry.name)?.[1];
      return day !== undefined && validDay(day) ? [{ name: entry.name, day }] : [];
    })
    .sort((a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name))[0];
  if (newest === undefined) return { status: 'absent' };
  let markdown: string;
  try {
    markdown = await (deps.readFile ?? readResearchFile)(join(dir, newest.name), MAX_BYTES);
  } catch {
    return { status: 'unavailable', reason: 'ideation file unreadable' };
  }
  return { status: 'ok', day: newest.day, relPath: `docs/strategy/${newest.name}`, titles: extractTitles(markdown) };
}

/** Plain Slack text; `stale` is said plainly past 2 days. Never throws. */
export function formatIdeationReply(read: IdeationRead, now: Date): string {
  if (read.status === 'absent') {
    return 'No ideation plan on this checkout yet (docs/strategy/IDEATION-*.md absent).';
  }
  if (read.status !== 'ok' || read.day === undefined || read.relPath === undefined) {
    return scrubSecrets(`Ideation unknown: ${read.reason ?? 'ideation read failed'}`);
  }
  const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(`${read.day}T00:00:00Z`)) / DAY_MS));
  const stale = ageDays > STALE_DAYS ? ' · stale' : '';
  const lines = [
    `Ideation plan ${read.day} · ${ageDays} day${ageDays === 1 ? '' : 's'} old${stale}`,
    ...(read.titles ?? []),
    `source: ${read.relPath}, as of ${now.toISOString()}`,
  ];
  return scrubSecrets(lines.join('\n'));
}
