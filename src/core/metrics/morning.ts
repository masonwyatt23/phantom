/**
 * Morning measurement collector (RQ-MORNING-MEASURE-1).
 *
 * Pure: every input is passed in already read, so the hourly routine, the CLI
 * and the tests share one code path. A section whose evidence is absent is
 * `status: 'missing'` with a reason; nothing is estimated or invented.
 * Seven sections, last 24 hours: features, dead code and net lines, Devin
 * absorption, Phantom.app, cost per merged PR, feedback loop, node capacity.
 */
export const MORNING_SCHEMA = 'metrics.morning.v1' as const;
export const MORNING_KEYS = [
  'features_added_and_cut', 'dead_code_deleted_net_lines', 'devin_absorption', 'observability_app_status',
  'cost_per_merged_pr', 'feedback_loop_minutes', 'node_capacity',
] as const;
export type MorningKey = typeof MORNING_KEYS[number];

const DAY_MS = 24 * 60 * 60 * 1000;
export const ASHLR_REPOS = [
  'phantom', 'phantom-secrets', 'ashlr-plugin', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack',
] as const;

export interface MorningPr {
  repo: string; // owner/name
  number: number;
  title: string;
  state: string | null;
  mergedAtMs: number | null;
  additions: number | null;
  deletions: number | null;
  files: { path: string; additions: number; deletions: number }[];
  branch: string | null;
}

export type Missing = { status: 'missing'; reason: string };
const missing = (reason: string): Missing => ({ status: 'missing', reason });

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parse a `gh pr list --json ...` export (JSON array or JSONL). Returns rows plus the count ignored. */
export function parseMorningPrs(text: string): { rows: MorningPr[]; ignored: number } {
  const rows: MorningPr[] = [];
  let ignored = 0;
  const push = (raw: unknown): void => {
    const row = rec(raw);
    const url = str(row?.url);
    const urlMatch = url ? /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url) : null;
    const repoObj = rec(row?.repository);
    const repo = urlMatch?.[1] ?? str(repoObj?.nameWithOwner) ?? str(row?.repo);
    const number = urlMatch ? Number(urlMatch[2]) : int(row?.number);
    if (!row || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !number || number < 1) { ignored++; return; }
    const merged = str(row.mergedAt) ? Date.parse(str(row.mergedAt)!) : NaN;
    const files = (Array.isArray(row.files) ? row.files : []).flatMap((f) => {
      const r = rec(f), path = str(r?.path) ?? str(r?.filename);
      return path ? [{ path, additions: int(r?.additions) ?? 0, deletions: int(r?.deletions) ?? 0 }] : [];
    });
    rows.push({
      repo, number, title: str(row.title) ?? '', state: (str(row.state) ?? '').toUpperCase() || null,
      mergedAtMs: Number.isFinite(merged) ? merged : null,
      additions: int(row.additions), deletions: int(row.deletions), files, branch: str(row.headRefName),
    });
  };
  const trimmed = text.trim();
  if (!trimmed) return { rows, ignored };
  try {
    const value: unknown = JSON.parse(trimmed);
    if (Array.isArray(value)) { value.forEach(push); return { rows, ignored }; }
    push(value);
    return { rows, ignored };
  } catch { /* JSONL */ }
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { push(JSON.parse(line)); } catch { ignored++; }
  }
  return { rows, ignored };
}

const isTest = (p: string): boolean => /(^|\/)(__tests__|tests?|fixtures?)(\/|$)|\.(test|spec)\.[^/]+$/i.test(p);
const DEAD_RE = /\b(dead[- ]code|unused|unreferenced|orphan(?:ed)?|knip|prune|stale)\b/i;
const REMOVE_RE = /^\s*(?:\w+(?:\([^)]*\))?!?:\s*)?(?:remove|removes|removed|delete|deletes|deleted|drop|drops|deprecate|deprecates|retire|prune|purge|cut)\b/i;
const FEAT_RE = /^\s*feat(?:\([^)]*\))?!?:/i;
const NEW_PATH_RE = /^(?:src\/(?:cli|core)\/|lib\/|bin\/|commands\/)/;

export type PrClass = 'dead-code' | 'feature-removed' | 'feature-added' | 'unclassified';
export interface PrClassification { class: PrClass; basis: 'title' | 'file-evidence' | 'none' }

/**
 * First match wins: dead-code removal, feature removed or cut, feature added,
 * else unclassified. File evidence is a heuristic: an added-only non-test
 * source file (additions > 0, deletions 0) is a candidate new module, and a
 * deletion-dominated source change with a removal title is a cut.
 */
export function classifyPr(pr: MorningPr): PrClassification {
  const title = pr.title;
  const src = pr.files.filter((f) => !isTest(f.path) && NEW_PATH_RE.test(f.path));
  const addedOnly = src.filter((f) => f.additions > 0 && f.deletions === 0);
  const delTotal = pr.deletions ?? pr.files.reduce((n, f) => n + f.deletions, 0);
  const addTotal = pr.additions ?? pr.files.reduce((n, f) => n + f.additions, 0);
  if (DEAD_RE.test(title) && (REMOVE_RE.test(title) || delTotal > addTotal)) return { class: 'dead-code', basis: 'title' };
  if (REMOVE_RE.test(title)) return { class: 'feature-removed', basis: 'title' };
  if (FEAT_RE.test(title)) return { class: 'feature-added', basis: 'title' };
  if (/\bnew (?:command|module|subcommand)\b/i.test(title)) return { class: 'feature-added', basis: 'title' };
  if (!REMOVE_RE.test(title) && addedOnly.length > 0 && !/^\s*(?:fix|test|docs?|chore|ci|refactor|bridge)\b/i.test(title) && src.length === addedOnly.length) {
    return { class: 'feature-added', basis: 'file-evidence' };
  }
  return { class: 'unclassified', basis: 'none' };
}

const mergedIn = (prs: MorningPr[], nowMs: number): MorningPr[] =>
  prs.filter((p) => p.mergedAtMs !== null && p.mergedAtMs >= nowMs - DAY_MS && p.mergedAtMs < nowMs);

const repoName = (full: string): string => full.slice(full.indexOf('/') + 1);

function prSections(prs: MorningPr[] | null, nowMs: number): Record<'features_added_and_cut' | 'dead_code_deleted_net_lines', unknown> {
  if (prs === null) {
    const m = missing('no PR export supplied; pass --prs <gh pr list --json export covering the seven ashlrai repos>');
    return { features_added_and_cut: m, dead_code_deleted_net_lines: m };
  }
  const merged = mergedIn(prs, nowMs);
  const classes: Record<PrClass, { pr: number; repo: string; basis: string }[]> = {
    'dead-code': [], 'feature-removed': [], 'feature-added': [], unclassified: [],
  };
  for (const pr of merged) {
    const c = classifyPr(pr);
    classes[c.class].push({ pr: pr.number, repo: repoName(pr.repo), basis: c.basis });
  }
  const sorted = (rows: { pr: number; repo: string; basis: string }[]) =>
    [...rows].sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);
  const byRepo: Record<string, { merged: number; additions: number; deletions: number; unknownTotals: number }> = {};
  let additions = 0, deletions = 0, deadDeletions = 0, unknown = 0;
  for (const pr of merged) {
    const r = (byRepo[repoName(pr.repo)] ??= { merged: 0, additions: 0, deletions: 0, unknownTotals: 0 });
    r.merged++;
    if (pr.additions === null || pr.deletions === null) { r.unknownTotals++; unknown++; continue; }
    r.additions += pr.additions; r.deletions += pr.deletions;
    additions += pr.additions; deletions += pr.deletions;
    if (classifyPr(pr).class === 'dead-code') deadDeletions += pr.deletions;
  }
  const knownRepos = new Set(merged.map((p) => repoName(p.repo)));
  const absent = ASHLR_REPOS.filter((r) => !prs.some((p) => repoName(p.repo) === r));
  return {
    features_added_and_cut: {
      status: 'ok', window_hours: 24, merged_prs: merged.length,
      feature_added: sorted(classes['feature-added']), feature_removed_or_cut: sorted(classes['feature-removed']),
      dead_code_removal: sorted(classes['dead-code']), unclassified_count: classes.unclassified.length,
      method: 'title first (feat:, remove/delete/drop/deprecate, dead-code words); source-path added-only files are a heuristic fallback marked file-evidence',
      repos_without_export_rows: absent,
    },
    dead_code_deleted_net_lines: {
      status: unknown ? 'partial' : 'ok', window_hours: 24,
      dead_code_deleted_lines: deadDeletions, dead_code_prs: classes['dead-code'].map((c) => c.pr).sort((a, b) => a - b),
      total_additions: additions, total_deletions: deletions, net_lines: additions - deletions,
      per_repo: Object.fromEntries(Object.entries(byRepo).sort(([a], [b]) => a.localeCompare(b))),
      merged_prs_without_line_totals: unknown, repos_with_merges: knownRepos.size,
      ...(unknown ? { reason: `${unknown} merged PR(s) lack additions/deletions in the export and are excluded from totals` } : {}),
    },
  };
}

export interface DispatchEventLike { at: string; kind: string; message: string }

/** LAUNCH payload is `<job> <lane> ...`; the lane token is validated like runs-job-detail.ts. */
function launchLanes(events: DispatchEventLike[], fromMs: number, toMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.kind !== 'LAUNCH') continue;
    const t = Date.parse(e.at);
    if (!(t >= fromMs && t < toMs)) continue;
    const lane = e.message.split(/\s+/)[1] ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(lane)) continue;
    out[lane] = (out[lane] ?? 0) + 1;
  }
  return out;
}

function devinSection(events: DispatchEventLike[] | null, prs: MorningPr[] | null, nowMs: number, reason: string | null) {
  const absorb = prs?.find((p) => /^ashlrai\/phantom$/.test(p.repo) && p.number === 6236);
  const absorbState = absorb
    ? { pr: 6236, state: absorb.state, merged: absorb.mergedAtMs !== null, title: absorb.title }
    : missing('PR #6236 is not in the PR export; include state=all rows for ashlrai/phantom');
  if (events === null) return { ...missing(reason ?? 'dispatch-events.log unreadable'), RQ_DEVIN_ABSORB_1: absorbState };
  const now = launchLanes(events, nowMs - DAY_MS, nowMs), before = launchLanes(events, nowMs - 2 * DAY_MS, nowMs - DAY_MS);
  const total = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);
  const share = (m: Record<string, number>): number | null => {
    const t = total(m); return t ? (m['devin'] ?? 0) / t : null;
  };
  const devinBefore = (before['devin'] ?? 0) + (before['devin-flash'] ?? 0);
  const devinNow = (now['devin'] ?? 0) + (now['devin-flash'] ?? 0);
  const nonDevinNow = total(now) - devinNow;
  return {
    status: total(now) ? 'ok' : 'partial', window_hours: 24,
    launches_by_lane_24h: now, launches_by_lane_prior_24h: before,
    devin_launches_24h: devinNow, devin_launches_prior_24h: devinBefore,
    devin_share_24h: share(now) === null ? null : Number((devinNow / total(now)).toFixed(4)),
    non_devin_share_24h: total(now) ? Number((nonDevinNow / total(now)).toFixed(4)) : null,
    // Proxy: how much of the prior 24h Devin launch volume is no longer launched on Devin lanes.
    devin_volume_drop_fraction: devinBefore ? Number(Math.max(0, (devinBefore - devinNow) / devinBefore).toFixed(4)) : null,
    note: 'LAUNCH counts cannot prove which jobs were reassigned; the drop fraction is a volume proxy, not an attribution',
    RQ_DEVIN_ABSORB_1: absorbState,
  };
}

export interface AppObservation {
  version: string | null; installedAtMs: number | null; running: boolean | null;
  views: { url: string; ok: boolean; httpStatus: number | null }[] | null; reason?: string;
}

function appSection(app: AppObservation | null) {
  if (!app) return missing('no app observation supplied');
  if (app.version === null) return missing(app.reason ?? 'Phantom.app Info.plist not readable');
  return {
    status: 'ok', installed_version: app.version,
    installed_at: app.installedAtMs === null ? null : new Date(app.installedAtMs).toISOString(),
    running: app.running,
    views: app.views ?? missing('views not probed; pass --probe-url <loopback url> (read-only GET, 127.0.0.1 or localhost only)'),
  };
}

export interface LedgerNode { node: string; ncpu: number | null; memory_bytes: number | null; load1: number | null; status: string | null; lanes: number | null }

function memoryBytes(r: Record<string, unknown>): number | null {
  for (const k of ['memory_bytes', 'memBytes', 'mem_bytes', 'memoryBytes']) { const v = int(r[k]); if (v !== null) return v; }
  for (const k of ['memory_gb', 'mem_gb', 'memoryGb', 'memGb']) {
    const v = r[k]; if (typeof v === 'number' && v >= 0 && Number.isFinite(v)) return Math.round(v * 1024 ** 3);
  }
  return null;
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Tolerant reader: `nodes` as an array or a name-keyed object. Unknown shapes yield no nodes. */
export function parseLedgerNodes(ledger: unknown): LedgerNode[] {
  const root = rec(ledger);
  const raw = root?.nodes ?? root?.hosts;
  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((n, i) => [str(rec(n)?.node) ?? str(rec(n)?.name) ?? str(rec(n)?.host) ?? `node-${i}`, n])
    : rec(raw) ? Object.entries(rec(raw)!) : [];
  return entries.flatMap(([name, value]) => {
    const r = rec(value);
    if (!r) return [];
    const lanes = rec(r.lanes) ? Object.values(rec(r.lanes)!).reduce<number>((a, b) => a + (num(b) ?? 0), 0) : num(r.lanes) ?? num(r.running);
    return [{
      node: name, ncpu: int(r.ncpu) ?? int(r.cpus) ?? int(r.cpu_count),
      memory_bytes: memoryBytes(r), load1: num(r.load1) ?? num(r.load) ?? num(rec(r.load)?.load1),
      status: str(r.status) ?? str(r.state), lanes,
    }];
  });
}

function nodesSection(ledger: unknown, reason: string | null) {
  if (ledger === null) return missing(reason ?? 'fleet-ledger.json unreadable');
  const nodes = parseLedgerNodes(ledger);
  if (!nodes.length) return missing('fleet-ledger.json has no per-node rows (expected nodes[] or nodes{} with ncpu, memory, load, status)');
  return {
    status: 'ok', nodes,
    measured_lanes_per_node: nodes.some((n) => n.lanes !== null) ? 'ledger' : missing('ledger rows carry no per-node lane count'),
  };
}

/** Cost per merged PR only from a sanctioned reader; the resource ledger's apiSpend covers API calls, not subscription lanes. */
function costSection(ledger: unknown, mergedCount: number | null) {
  const spend = rec(rec(ledger)?.apiSpend);
  const usd = num(spend?.usdToday);
  if (usd === null || !mergedCount) {
    return missing('no sanctioned per-job cost reader: the fleet ledger has no cost fields and phm usage does not join spend to merged PRs; build a jobs.jsonl cost join (phm usage --by-job) before reporting this');
  }
  return {
    status: 'partial', api_spend_usd_today: usd, merged_prs_24h: mergedCount,
    usd_per_merged_pr_api_only: Number((usd / mergedCount).toFixed(4)),
    reason: 'apiSpend excludes subscription-lane work and calendar-day spend is compared to 24h merges; treat as a floor, not a unit cost',
  };
}

const JOB_RE = /\b(RQ-[A-Z0-9][A-Z0-9-]*)\b/;
export const jobIdOfPr = (pr: MorningPr): string | null => JOB_RE.exec(pr.title)?.[1] ?? JOB_RE.exec(pr.branch ?? '')?.[1] ?? null;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function loopSection(prs: MorningPr[] | null, ideaAtMs: ReadonlyMap<string, number>, app: AppObservation | null, nowMs: number) {
  if (prs === null) return missing('no PR export supplied');
  const bridge = mergedIn(prs, nowMs).flatMap((p) => { const job = jobIdOfPr(p); return job && /^bridge\b|codex-bridge\//i.test(`${p.title} ${p.branch ?? ''}`) ? [{ p, job }] : []; });
  const minutes: number[] = [];
  for (const { p, job } of bridge) {
    const at = ideaAtMs.get(job);
    if (at !== undefined && p.mergedAtMs !== null && p.mergedAtMs >= at) minutes.push((p.mergedAtMs - at) / 60000);
  }
  const release = app?.version && app.installedAtMs !== null && app.installedAtMs >= nowMs - DAY_MS
    ? mergedIn(prs, nowMs).filter((p) => p.title.includes(app.version!) && /release|version|bump/i.test(p.title)).sort((a, b) => a.mergedAtMs! - b.mergedAtMs!)[0]
    : undefined;
  const installed = release ? Number(((app!.installedAtMs! - release.mergedAtMs!) / 60000).toFixed(1))
    : missing(app?.installedAtMs == null ? 'install time unknown' : app.installedAtMs < nowMs - DAY_MS ? 'no release installed in the last 24h' : 'no merged release PR matching the installed version');
  const p50 = median(minutes);
  return {
    status: p50 === null ? 'missing' : minutes.length < bridge.length ? 'partial' : 'ok',
    ...(p50 === null ? { reason: bridge.length ? 'no merged bridge PR had a ready.tsv row with a readable prompt mtime' : 'no merged bridge PRs in the window' } : {}),
    idea_to_merged_p50: p50 === null ? null : Number(p50.toFixed(1)),
    sample: minutes.length, merged_bridge_prs: bridge.length,
    merged_to_installed: installed,
    idea_time_source: 'ready.tsv prompt file mtime (rows already claimed and removed are not measurable)',
  };
}

export interface MorningInput {
  nowMs: number;
  prs: MorningPr[] | null;
  dispatchEvents: DispatchEventLike[] | null; dispatchReason?: string | null;
  app: AppObservation | null;
  ledger: unknown | null; ledgerReason?: string | null;
  ideaAtMs?: ReadonlyMap<string, number>;
}

export function buildMorningReport(input: MorningInput) {
  const { features_added_and_cut, dead_code_deleted_net_lines } = prSections(input.prs, input.nowMs);
  const mergedCount = input.prs ? mergedIn(input.prs, input.nowMs).length : null;
  return {
    schema: MORNING_SCHEMA,
    generated_at: new Date(input.nowMs).toISOString(),
    window: { since: new Date(input.nowMs - DAY_MS).toISOString(), until: new Date(input.nowMs).toISOString() },
    features_added_and_cut, dead_code_deleted_net_lines,
    devin_absorption: devinSection(input.dispatchEvents, input.prs, input.nowMs, input.dispatchReason ?? null),
    observability_app_status: appSection(input.app),
    cost_per_merged_pr: costSection(input.ledger, mergedCount),
    feedback_loop_minutes: loopSection(input.prs, input.ideaAtMs ?? new Map(), input.app, input.nowMs),
    node_capacity: nodesSection(input.ledger, input.ledgerReason ?? null),
  } as const;
}

/** Merge only the owned keys into an existing report object; every other key survives untouched. */
export function mergeMorningReport(existing: Record<string, unknown>, report: ReturnType<typeof buildMorningReport>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const key of MORNING_KEYS) merged[key] = report[key];
  merged['morning_measure'] = { schema: report.schema, generated_at: report.generated_at, window: report.window };
  return merged;
}
