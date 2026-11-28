/**
 * ACE vision playbook journal state evidence → self-improvement
 * backlog items.
 *
 * ~/.ashlr/vision/playbook.jsonl is Phantom's M149 ACE
 * (Agentic Context Engineering) delta-curated lesson store: one JSONL
 * PlaybookEntry per row ({id, section:'strategy'|'judge', text,
 * addedAt, hits, lastUsedAt, retired?} — playbookPath() in
 * src/core/vision/playbook.ts resolves under the user's home directly,
 * deliberately not $ASHLR_HOME). addDelta is the only append API and
 * has exactly two production callers: the strategist's acePlaybook
 * block (src/core/vision/strategist.ts — strategy deltas plus the only
 * curate('strategy') call, both gated on foundry.acePlaybook === true)
 * and leader-apply's vetoPlaybook (src/core/vision/leader-apply.ts —
 * 'strategy' deltas recording Mason's Leader vetoes, UNGATED). Every
 * reader is gated the other way: renderPlaybook('strategy') feeds the
 * strategist prompt and renderPlaybook('judge') feeds the fleet
 * manager's JUDGE_SYSTEM rubric (src/core/fleet/manager.ts), each only
 * when the same flag is on. addDelta('judge', ...) appears only in
 * tests — no production path ever writes a judge-section entry, and
 * curate is never invoked for 'judge' either.
 *
 * Until now the journal's only readers were the playbook module's own
 * render/curate paths, so three recorded states produced evidence only
 * inside a file nobody folded:
 *
 *  - judge-starved: with foundry.acePlaybook enabled the manager
 *    renders an '=== ACCUMULATED JUDGE LESSONS ===' block into every
 *    judgeProposal system prompt, but the judge section can never
 *    hold an entry — the rendered channel has no producer.
 *  - unread-store: with the flag off, vetoPlaybook still appends
 *    strategy deltas on every Mason veto while every render and the
 *    only curate call sit behind the same flag — the store is
 *    write-only and nothing compacts it.
 *  - dead-majority / oversized: curate marks entries retired:true and
 *    deliberately keeps them "so the audit trail is preserved", but
 *    nothing ever deletes a row and readEntries() parses the WHOLE
 *    file — unbounded — on every addDelta dedupe scan, every curate
 *    and every renderPlaybook. Once retired rows pass the live
 *    capacity (2 sections × the 50-entry curate cap) the majority of
 *    every parse is dead weight; past the bounded-read byte cap the
 *    fold itself can no longer prove the state cells at all.
 *
 * visionPlaybookBacklogItems carries the journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readPrivateFileTailCapped
 *    (newest VISION_PLAYBOOK_TAIL_BYTES) with the same no-follow
 *    regular-file discipline every sibling feed applies. Nothing is
 *    written and no network is touched; a missing journal folds as a
 *    provably empty store (readEntries returns [] for it exactly as
 *    for a zero-byte file, so only judge-starved — which needs no
 *    rows — can fire), while an existing path that refuses the read
 *    or another repository yields no items, a clean empty source.
 *  - Writer-contract validation. A row counts only when id, section,
 *    text, addedAt, hits and lastUsedAt satisfy the exact
 *    isValidEntry bar every real reader (readEntries → getEntries,
 *    renderPlaybook, curate, addDelta's dedupe scan) enforces —
 *    malformed lines are skipped exactly the way every reader skips
 *    them, and retired is read by the same truthiness the readers
 *    apply. Section values outside 'strategy'/'judge' still count as
 *    valid rows (the contract accepts any string) but belong to
 *    neither section tally.
 *  - State cells, not events. These are recorded-state verdicts, not
 *    windowed recurrences: each emits only while its condition holds
 *    on the effective config plus a provable file read, and stops
 *    re-adding the moment the state clears.
 *  - Truncated tails prove less. judge-starved and dead-majority
 *    need whole-file counts (a zero or a ratio cannot be proven from
 *    a tail slice), so they emit only on an untruncated read;
 *    unread-store needs only proof that valid rows exist, so it
 *    still fires on a truncated tail with counts stated as lower
 *    bounds; oversized keys off the exact stat size and always fires.
 *  - Config-gated honestly. The flag is read through
 *    loadConfigReadOnly — the same read every consumer makes — with
 *    the same `(foundry as Record<string, unknown>)['acePlaybook']`
 *    cast the three call sites use; a config failure resolves to
 *    flag-off, which can only suppress judge-starved, never invent
 *    it.
 *  - Fleet machinery only. The playbook describes this install's
 *    learned lessons and carries no repo column, so items emit only
 *    for the fleet's own repository ('phantom' last-segment match,
 *    the sibling feeds' rule).
 *  - Quoted text is never raw. Lesson text is model/owner prose, so
 *    prompts quote only counts — never entry bodies.
 *  - Dedup is downstream. Item ids hash only the cell identity
 *    (never counts or timestamps), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new; a playbook
 *    that stops producing the evidence simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the brief names the journal, the writer
 *    and reader call sites, the flag and where the fix surfaces live,
 *    with the usual no-change escape.
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { loadConfigReadOnly } from '../config.js';
import { readPrivateFileTailCapped } from '../verse/preferences.js';

/**
 * Bounded tail read. Playbook rows run a few hundred bytes (a veto
 * note can run longer — addDelta trims but never caps text length),
 * so 4 MiB retains on the order of ten thousand of the newest rows —
 * orders of magnitude past the 100-entry live capacity the curate
 * caps define — while staying a fixed bound on a store with no size
 * cap of its own.
 */
export const VISION_PLAYBOOK_TAIL_BYTES = 4 * 1024 * 1024;
/**
 * The dead-majority floor: the curate cap is 50 active entries per
 * section and the contract defines exactly two sections, so 100 live
 * rows is the whole designed capacity. Retired rows are kept forever
 * by contract, so once they alone reach that count the audit trail
 * outweighs everything the store can ever render.
 */
export const VISION_PLAYBOOK_DEAD_FLOOR = 100;
/** Items one call may emit; the cell set is bounded at four. */
export const VISION_PLAYBOOK_MAX_ITEMS = 4;
const VISION_PLAYBOOK_ITEM_HARD_MAX = 25;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: playbook evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';

/** One parsed playbook row: the isValidEntry bar plus the section/retired fields the fold needs. */
export interface VisionPlaybookRow {
  id: string;
  /** Any string the contract accepts; only 'strategy' and 'judge' have producers/readers today. */
  section: string;
  text: string;
  addedAt: string;
  hits: number;
  lastUsedAt: string;
  /** Reader-semantics truthiness: every consumer tests `!e.retired`, so any truthy value retires the row. */
  retired: boolean;
}

/**
 * The writer-contract bar, mirroring isValidEntry in
 * src/core/vision/playbook.ts exactly: id, section, text, addedAt,
 * hits and lastUsedAt must all be present with the recorded types.
 * Malformed, foreign or schema-drifted lines return null — the same
 * rows every real reader skips.
 */
export function parseVisionPlaybookLine(line: string): VisionPlaybookRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (
    typeof row['id'] !== 'string' ||
    typeof row['section'] !== 'string' ||
    typeof row['text'] !== 'string' ||
    typeof row['addedAt'] !== 'string' ||
    typeof row['hits'] !== 'number' ||
    typeof row['lastUsedAt'] !== 'string'
  ) {
    return null;
  }
  return {
    id: row['id'],
    section: row['section'],
    text: row['text'],
    addedAt: row['addedAt'],
    hits: row['hits'],
    lastUsedAt: row['lastUsedAt'],
    retired: Boolean(row['retired']),
  };
}

/** Parse a bounded file slice into rows; `dropFirst` discards the possibly-torn leading line of a truncated tail. */
function parsePlaybookLines(text: string, dropFirst: boolean): { rows: VisionPlaybookRow[]; skipped: number } {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  const rows: VisionPlaybookRow[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = parseVisionPlaybookLine(line);
    if (row === null) skipped += 1;
    else rows.push(row);
  }
  return { rows, skipped };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

export type VisionPlaybookCellKey = 'judge-starved' | 'unread-store' | 'dead-majority' | 'oversized';

export interface VisionPlaybookCell {
  key: VisionPlaybookCellKey;
  /** Valid rows seen in the bounded read (a proven floor when the read truncated). */
  validRows: number;
  /** Malformed lines skipped under the writer contract (never quoted). */
  skippedRows: number;
  strategyActive: number;
  strategyRetired: number;
  judgeActive: number;
  judgeRetired: number;
  /** Other-section valid rows (the contract accepts any section string). */
  otherRows: number;
  fileBytes: number | null;
  /** True when the bounded read could not see the whole file — counts are floors. */
  lowerBound: boolean;
}

export interface VisionPlaybookFoldInput {
  /** Valid rows parsed from the bounded read. */
  rows: readonly VisionPlaybookRow[];
  /** Non-empty lines the writer contract rejected. */
  skipped: number;
  /** True when the tail read cut older lines — the rows are the newest span only. */
  truncated: boolean;
  /** Exact file size in bytes when the read reported one. */
  fileBytes: number | null;
  /** The effective foundry.acePlaybook flag (=== true semantics, same as every consumer). */
  acePlaybook: boolean;
}

function tally(rows: readonly VisionPlaybookRow[]): Pick<VisionPlaybookCell, 'strategyActive' | 'strategyRetired' | 'judgeActive' | 'judgeRetired' | 'otherRows'> {
  let strategyActive = 0;
  let strategyRetired = 0;
  let judgeActive = 0;
  let judgeRetired = 0;
  let otherRows = 0;
  for (const row of rows) {
    const bucket = row.section === 'strategy' ? 'strategy' : row.section === 'judge' ? 'judge' : 'other';
    if (bucket === 'strategy') {
      if (row.retired) strategyRetired += 1;
      else strategyActive += 1;
    } else if (bucket === 'judge') {
      if (row.retired) judgeRetired += 1;
      else judgeActive += 1;
    } else {
      otherRows += 1;
    }
  }
  return { strategyActive, strategyRetired, judgeActive, judgeRetired, otherRows };
}

/**
 * Fold one bounded read into state cells. Pure: every verdict derives
 * only from the recorded rows, the truncation flag, the file size and
 * the effective acePlaybook flag — nothing is inferred.
 */
export function foldVisionPlaybookCells(input: VisionPlaybookFoldInput): VisionPlaybookCell[] {
  const counts = tally(input.rows);
  const base = {
    validRows: input.rows.length,
    skippedRows: input.skipped,
    ...counts,
    fileBytes: input.fileBytes,
    lowerBound: input.truncated,
  };
  const cells: VisionPlaybookCell[] = [];

  // --- judge-starved: the rendered judge channel has no producer ---
  // Needs a whole-file read: a zero active-judge count cannot be proven
  // from a tail slice that may have dropped older judge rows.
  if (input.acePlaybook && !input.truncated && counts.judgeActive === 0) {
    cells.push({ ...base, key: 'judge-starved' });
  }

  // --- unread-store: writes continue while every reader is gated off ---
  // Any valid row proves content exists; a truncated tail still proves
  // that, with counts stated as floors.
  if (!input.acePlaybook && input.rows.length > 0) {
    cells.push({ ...base, key: 'unread-store' });
  }

  // --- dead-majority: retired audit rows outweigh the whole live capacity ---
  // Same whole-file requirement as judge-starved: the ratio cannot be
  // proven from a tail slice. "Live" is what renderPlaybook can emit —
  // active strategy/judge rows only; other-section rows have no reader
  // at all, so they count as dead weight alongside the retired ones.
  const retiredTotal = counts.strategyRetired + counts.judgeRetired + counts.otherRows;
  const activeTotal = counts.strategyActive + counts.judgeActive;
  if (!input.truncated && retiredTotal >= VISION_PLAYBOOK_DEAD_FLOOR && retiredTotal > activeTotal) {
    cells.push({ ...base, key: 'dead-majority' });
  }

  // --- oversized: the file passed the bounded read ---
  // fileBytes is the exact stat size, provable under any truncation.
  if (input.fileBytes !== null && input.fileBytes > VISION_PLAYBOOK_TAIL_BYTES) {
    cells.push({ ...base, key: 'oversized' });
  }

  return cells;
}

const NO_CHANGE = 'If the flag state changed deliberately since the evidence was recorded (acePlaybook enabled or disabled on purpose), the playbook entries are genuine one-off lessons rather than the structural patterns the cells describe, the retired rows are deliberate audit retention the owner wants kept, the oversized file reflects a deliberate retention choice, or the cause is owner-only (editing ~/.ashlr/vision/playbook.jsonl itself, host permissions) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal path and call sites are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is ~/.ashlr/vision/playbook.jsonl (playbookPath in src/core/vision/playbook.ts — resolved under the user\'s home directly, not $ASHLR_HOME): addDelta is the only append API, curate the only compaction, renderPlaybook the only renderer, and readEntries parses the whole file on every call. Production writers: the strategist\'s acePlaybook block (src/core/vision/strategist.ts — strategy deltas and the only curate call, both gated on foundry.acePlaybook === true) and leader-apply\'s vetoPlaybook (src/core/vision/leader-apply.ts — strategy deltas on every Mason veto, ungated). Production readers: renderPlaybook(\'strategy\') into the strategist prompt (strategist.ts) and renderPlaybook(\'judge\') into the fleet manager\'s JUDGE_SYSTEM rubric (src/core/fleet/manager.ts), each only when the same flag is on. addDelta(\'judge\', ...) appears only in tests.';

const sectionSummary = (cell: VisionPlaybookCell): string =>
  `${cell.validRows} valid row(s) — strategy ${cell.strategyActive} active / ${cell.strategyRetired} retired, judge ${cell.judgeActive} active / ${cell.judgeRetired} retired${cell.otherRows > 0 ? `, other sections ${cell.otherRows}` : ''}${cell.skippedRows > 0 ? `, ${cell.skippedRows} malformed line(s) skipped` : ''}`;

const boundText = (cell: VisionPlaybookCell): string =>
  cell.lowerBound ? ' The bounded tail read could not see the whole file, so these counts cover only the newest retained rows — a proven lower bound, not the full store.' : '';

function judgeStarvedPrompt(cell: VisionPlaybookCell): string {
  return [
    `Phantom's ACE judge playbook channel is wired read-side but has no producer — foundry.acePlaybook is enabled, so the fleet manager renders an '=== ACCUMULATED JUDGE LESSONS ===' block into every judgeProposal system prompt, yet the playbook journal holds ${cell.judgeActive} active judge-section ${cell.judgeActive === 1 ? 'entry' : 'entries'} (${sectionSummary(cell)}).`,
    '',
    `addDelta is the only way a lesson enters the store, and its only production callers write 'strategy' rows: the strategist's acePlaybook block delta-curates strategy lessons, and leader-apply's vetoPlaybook records Mason's Leader vetoes as strategy deltas. addDelta('judge', ...) appears only in tests — no judge-verdict distillation, no leader-feedback path and no scheduled job ever calls it, and curate is likewise only ever invoked for 'strategy'. The judge render path (manager.ts judgePlaybookCtx → JUDGE_SYSTEM) therefore always renders an empty block: judge proposals run without the accumulated-judgment context the flag exists to provide, and judge lessons can never accumulate no matter how many verdicts the fleet records.${cell.judgeRetired > 0 ? ` ${cell.judgeRetired} retired judge row(s) exist, so judge entries were written at some point and then curated away — or written by hand.` : ''}`,
    '',
    EVIDENCE,
    '',
    `Decide the honest fix in this repository's src/: wire a judge-lesson producer — for example distilling recurring judge-verdict patterns from the judge-trace store into addDelta('judge', ...) on a bounded cadence, mirroring how the strategy side learns — or remove the dead render path (the judge half of the acePlaybook flag: manager.ts's judgePlaybookCtx and the JUDGE_SYSTEM injection) if judge lessons were deliberately dropped. If a producer exists on a path this fold cannot see (another store feeding judge entries), report no-change and name the evidence. ` + NO_CHANGE,
  ].join('\n');
}

function unreadStorePrompt(cell: VisionPlaybookCell): string {
  return [
    `Phantom's ACE playbook store is write-only — foundry.acePlaybook is not enabled, yet ~/.ashlr/vision/playbook.jsonl holds ${cell.validRows} valid ${cell.validRows === 1 ? 'entry' : 'entries'} (${sectionSummary(cell)}).`,
    '',
    `vetoPlaybook (src/core/vision/leader-apply.ts) calls addPlaybookDelta → playbook.addDelta('strategy', ...) on EVERY Mason veto of a Leader action — scheduled or applied — with no acePlaybook gate, so veto lessons keep appending while the flag is off. But every reader sits behind the same flag: renderPlaybook('strategy') feeds the strategist prompt and renderPlaybook('judge') feeds the JUDGE_SYSTEM rubric only when acePlaybook === true, and the only curate call lives inside the strategist's gated block. Flag off therefore means the store accumulates lessons nothing renders, nothing scores and nothing compacts — each addDelta still pays the full-file dedupe scan, and retired rows are never even produced because curate never runs.${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Decide the honest fix in this repository's src/: gate vetoPlaybook (or the addPlaybookDelta port) on the same foundry.acePlaybook flag so a disabled feature stops writing, give the store a flag-off consumer (e.g., surface accumulated veto lessons in the leader review path that already exists), or document the write-only accumulation as deliberate if the lessons are meant to be harvested when the flag is later enabled. If the entries predate a deliberate flag-off decision and the owner wants them kept for that day, report no-change and name the evidence. ` + NO_CHANGE,
  ].join('\n');
}

function deadMajorityPrompt(cell: VisionPlaybookCell): string {
  const deadTotal = cell.strategyRetired + cell.judgeRetired + cell.otherRows;
  const liveTotal = cell.strategyActive + cell.judgeActive;
  return [
    `Phantom's ACE playbook journal is mostly dead rows — ${deadTotal} retired or reader-less ${deadTotal === 1 ? 'entry' : 'entries'} against ${liveTotal} live ${liveTotal === 1 ? 'entry' : 'entries'} (${sectionSummary(cell)}).`,
    '',
    `curate marks entries retired:true and deliberately keeps them "so the audit trail is preserved" — but nothing ever deletes a row: readEntries() parses the WHOLE file on every addDelta dedupe scan, every curate and every renderPlaybook, with no size cap and no retired-row horizon. The designed live capacity is ${VISION_PLAYBOOK_DEAD_FLOOR} rows (the 50-entry curate cap across the two contract sections), so once the audit trail alone reaches that floor the majority of every parse is dead weight, and the cost grows monotonically forever. renderPlaybook and getEntries have no bound either — the dead rows are parsed on every prompt render the flag enables.`,
    '',
    EVIDENCE,
    '',
    `Decide the honest fix in this repository's src/core/vision/playbook.ts: compact or drop retired rows past a retention horizon inside curate (the audit argument has a natural bound — a retired row older than any plausible review window), bound readEntries/getEntries/renderPlaybook to the live set plus a capped retired tail, or make writeEntries atomic (it currently writeFileSyncs the whole file — a crash mid-curate can tear it) while touching the same code. Rewriting ~/.ashlr/vision/playbook.jsonl by hand is owner-only — the store is the module's own. If the retired accumulation is deliberate audit retention the owner wants unbounded, report no-change and name the evidence. ` + NO_CHANGE,
  ].join('\n');
}

function oversizedPrompt(cell: VisionPlaybookCell): string {
  const mib = cell.fileBytes === null ? 'an unknown number of' : `${(cell.fileBytes / 1048576).toFixed(1)} MiB of`;
  return [
    `Phantom's ACE playbook journal is ${mib} bytes — past the ${Math.round(VISION_PLAYBOOK_TAIL_BYTES / 1048576)} MiB bounded read, on a store with no size cap of its own.`,
    '',
    `playbook.jsonl has no retention bound anywhere in its contract: addDelta appends (or full-rewrites on a dedupe hit), curate marks retired and keeps every row "so the audit trail is preserved", and writeEntries rewrites the whole file with a plain writeFileSync — non-atomic, so a crash mid-curate can tear it. Every operation — the addDelta near-duplicate scan, curate's merge pass, renderPlaybook's scoring, getEntries — parses the entire file unbounded. Past the bounded-read cap the state cells above can no longer prove their verdicts: they go silent not because the evidence cleared but because the reads truncated, which is itself the recorded symptom.`,
    '',
    EVIDENCE,
    '',
    `Decide the honest fix in this repository's src/core/vision/playbook.ts: add a size cap or retired-row retention horizon so the store stays bounded by design, make writeEntries atomic (temp file + rename) since it already rewrites the whole file, and/or bound the read paths the way sibling journals bound theirs. Check \`phm vision\` surfaces and the playbook module's own tests for the recorded row counts first. Rewriting ~/.ashlr/vision/playbook.jsonl by hand is owner-only. If the size reflects deliberate unbounded retention, report no-change and name the evidence. ` + NO_CHANGE,
  ].join('\n');
}

function cellItem(cell: VisionPlaybookCell, repo: string): CloudBacklogItem {
  const titles: Record<VisionPlaybookCellKey, string> = {
    'judge-starved': 'ACE judge playbook channel renders but has no producer',
    'unread-store': 'ACE playbook store accumulates lessons nothing reads while acePlaybook is off',
    'dead-majority': 'ACE playbook journal is mostly retired audit rows',
    oversized: 'ACE playbook journal exceeds the bounded read with no size cap',
  };
  const prompts: Record<VisionPlaybookCellKey, string> = {
    'judge-starved': judgeStarvedPrompt(cell),
    'unread-store': unreadStorePrompt(cell),
    'dead-majority': deadMajorityPrompt(cell),
    oversized: oversizedPrompt(cell),
  };
  const id = `vision-playbook-${createHash('sha256').update(`vision-playbook:${cell.key}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: titles[cell.key].slice(0, MAX_TITLE_CHARS),
    prompt: prompts[cell.key],
    area: 'vision-playbook',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

export interface VisionPlaybookItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Home the default playbook path resolves under (default: os.homedir()). */
  homeDir?: string;
  /** Direct playbook-journal override (default: <home>/.ashlr/vision/playbook.jsonl — the writer's own resolution). */
  playbookPath?: string;
  /** Most items one call emits (default VISION_PLAYBOOK_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/**
 * The effective foundry.acePlaybook flag exactly as the three consumer
 * call sites read it — `(cfg.foundry as Record<string, unknown>)
 * ['acePlaybook'] === true` — through the same loadConfigReadOnly the
 * fleet uses. A config failure resolves to flag-off: it can suppress
 * judge-starved but can never invent it, and unread-store still
 * requires recorded rows as its own proof.
 */
function acePlaybookEnabled(): boolean {
  try {
    const foundry = loadConfigReadOnly().foundry as Record<string, unknown> | undefined;
    return foundry?.['acePlaybook'] === true;
  } catch {
    return false;
  }
}

/**
 * Backlog items for ACE playbook journal evidence: the rendered-but-
 * unwritten judge channel, the write-only store while the flag is
 * off, the retired-row dead majority, and the unbounded file itself.
 * Total: an unreadable journal, another repository, or any read or
 * fold failure yields no items rather than throwing into discovery;
 * a missing journal folds as empty so judge-starved can still prove
 * its zero.
 */
export async function visionPlaybookBacklogItems(opts: VisionPlaybookItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const playbookPath = opts.playbookPath ?? join(home, '.ashlr', 'vision', 'playbook.jsonl');

    const read = readPrivateFileTailCapped(playbookPath, VISION_PLAYBOOK_TAIL_BYTES);
    // A missing journal is a provably empty store — readEntries returns
    // [] for it exactly as for a zero-byte file — so the fold still runs
    // with zero rows and only judge-starved can fire (its verdict needs
    // no rows, only the flag and a whole-file zero). A path that exists
    // but refuses the bounded read (permissions, non-regular file,
    // symlink) stays a clean empty: its contents cannot be proven.
    if (read === null && existsSync(playbookPath)) return [];
    const parsed = read === null
      ? { rows: [] as VisionPlaybookRow[], skipped: 0 }
      : parsePlaybookLines(read.text, read.truncated);

    const cells = foldVisionPlaybookCells({
      rows: parsed.rows,
      skipped: parsed.skipped,
      truncated: read?.truncated ?? false,
      fileBytes: read?.bytes ?? null,
      acePlaybook: acePlaybookEnabled(),
    });
    const limit = Math.max(1, Math.min(opts.limit ?? VISION_PLAYBOOK_MAX_ITEMS, VISION_PLAYBOOK_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => cellItem(cell, repo));
  } catch {
    return [];
  }
}
