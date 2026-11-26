import { createHash } from 'node:crypto';
import { classifyEmpty, type EmptyJobResult } from './empty-jobs.js';
import { parseLedgerTs } from '../metrics/loop.js';

const guardian = (id: string): boolean => /^(?:RQ-FIX-MAIN-|FIXUP-MAIN-)[\w.-]+$/.test(id);
// Scan prefixes and numbered attempts identify the same failed repo/commit.
const failureIdentity = (root: string): string => root.replace(/-EMPTYRETRY-(frontier|work|mid|fast)$/, '')
  .replace(/^(?:RQ-FIX-MAIN-|FIXUP-MAIN-)(.+)-([a-fA-F0-9]{7,40})(?:-r\d+)?$/, (_, repo: string, sha: string) => `FIXUP-MAIN-${repo}-${sha.toLowerCase()}`);
const legacyReceipt = (root: string, tier: string): string => createHash('sha256').update(`${root}:${tier}`).digest('hex');
export const guardianReceipt = (root: string, tier: string): string => legacyReceipt(failureIdentity(root), tier);
export interface GuardianEmptyEscalation { job: string; root: string; tier: string; reason: string; exitCode: number | null }

/** Original artifacts stay untouched; deterministic child IDs and receipts bound retries per tier. */
export function planGuardianEmptyRecovery(queue: string, ledger: string, receipts: Set<string>): { lines: string[]; escalations: GuardianEmptyEscalation[] } {
  const entries = queue.split(/\r?\n/).flatMap(line => {
    const m = /^- (READY|DONE|CLAIMED(?: [\w.@:/-]+)*?) ([\w.-]+) \(([^)]*)\): (.+)$/.exec(line);
    if (!m || !guardian(m[2]!)) return [];
    const root = / guardian-retry-root=([\w.-]+) guardian-retry-tier=\w+$/.exec(m[4]!)?.[1] ?? m[2]!;
    return [{ status: m[1]!, id: m[2]!, root, failure: failureIdentity(root), attrs: m[3]!, repo: /\brepo=([\w.-]+)/.exec(m[3]!)?.[1],
      pool: /\bpool=([\w.-]+)/.exec(m[3]!)?.[1], tier: /\btier=(frontier|work|mid|fast)\b/.exec(m[3]!)?.[1],
      goal: m[4]! }];
  });
  const latest = new Map<string, Record<string, unknown>>();
  const active = new Map<string, string | undefined>();
  const launched = new Map<string, number>();
  const tiers = new Map<string, string>();
  const failed = new Map<string, Map<string, { job: string; row: Record<string, unknown> }>>();
  const resolved = new Set<string>();
  const roots = new Set(entries.map(entry => entry.root));
  const emptyFailure = (row: Record<string, unknown>): Pick<EmptyJobResult, 'reason' | 'outcome'> => classifyEmpty(null, null, {
    exitCode: typeof row.exit_code === 'number' && Number.isInteger(row.exit_code) ? row.exit_code : null, poolError: Boolean(row.pool_error),
  });
  try {
    const rows = ledger.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>);
    const stamp = (row: Record<string, unknown>): number => parseLedgerTs(row.ts ?? row.timestamp ?? row.at ?? row.mergedAt ?? row.closedAt) ?? NaN;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return { lines: [], escalations: [] };
      if (guardian(String(row.job ?? row.job_id ?? row.jobId ?? row.id)) && (!Number.isFinite(stamp(row)) || stamp(row) > Date.now())) return { lines: [], escalations: [] };
    }
    for (const row of rows.sort((a, b) => (stamp(a) || 0) - (stamp(b) || 0))) {
      const id = row.job ?? row.job_id ?? row.jobId ?? row.id;
      if (typeof id !== 'string' || !guardian(id)) continue;
      const event = row.event ?? row.type ?? row.kind;
      const identity = entries.find(e => e.id === id)?.failure ?? failureIdentity(id);
      roots.add(id.replace(/-EMPTYRETRY-(frontier|work|mid|fast)$/, ''));
      roots.add(identity); roots.add(identity.replace(/^FIXUP-MAIN-/, 'RQ-FIX-MAIN-'));
      const state = row.state ?? row.outcome ?? row.status;
      // A merged repair suppresses stale recovery, but does not assert CI green.
      if (state === 'MERGED') { resolved.add(identity); latest.delete(id); active.delete(id); continue; }
      if (state === 'CLOSED') { latest.delete(id); active.delete(id); continue; }
      if (event === 'claim' || event === 'launch') {
        launched.set(id, stamp(row));
        active.set(id, typeof row.repo === 'string' ? row.repo.replace(/^ashlrai\//, '') : entries.find(e => e.id === id)?.repo);
        latest.delete(id);
        if (typeof row.tier === 'string') tiers.set(id, row.tier);
      } else if (event === 'finish' && stamp(row) > (launched.get(id) ?? -Infinity)) {
        latest.set(id, row); active.delete(id);
        const attempts = failed.get(identity) ?? new Map();
        const attempt = `${id}:${launched.get(id) ?? stamp(row)}`;
        // The latest finish for a launch replaces earlier, possibly corrected evidence.
        attempts.delete(attempt);
        if (row.empty === true && emptyFailure(row).outcome === 'failed') {
          attempts.set(attempt, { job: id, row });
        }
        failed.set(identity, attempts);
      }
      else if (['publish', 'published', 'outcome'].includes(String(event))) {
        if (row.url || row.pr || row.prUrl) { latest.delete(id); active.set(id, entries.find(e => e.id === id)?.repo); }
      }
    }
  } catch { return { lines: [], escalations: [] }; } // Torn evidence never authorizes a retry.
  const lines: string[] = [], escalations: GuardianEmptyEscalation[] = [];
  const reserved = new Set<string>();
  const escalated = new Set<string>();
  for (const entry of entries) {
    if (resolved.has(entry.failure)) continue;
    if (entry.status === 'READY' && entry.root === entry.id) continue; // The source itself is already queued.
    const row = latest.get(entry.id), tier = tiers.get(entry.id) ?? entry.tier;
    if (!row || row.empty !== true || !entry.repo || !entry.pool || !tier || !['fast', 'mid', 'work', 'frontier'].includes(tier)) continue;
    if (entries.filter(e => e.id === entry.id).length !== 1) continue;
    const exitCode = typeof row.exit_code === 'number' && Number.isInteger(row.exit_code) ? row.exit_code : null;
    const failure = emptyFailure(row);
    if (failure.outcome !== 'failed') continue;
    const key = guardianReceipt(entry.root, tier);
    const child = `${entry.root}-EMPTYRETRY-${tier}`;
    if (reserved.has(entry.repo) || [...active.values()].some(repo => !repo || repo === entry.repo)
      || entries.some(e => e.id !== entry.id && e.repo === entry.repo && e.status !== 'DONE' && !latest.has(e.id))) continue;
    const consumed = receipts.has(key) || [...roots].some(root => failureIdentity(root) === entry.failure && receipts.has(legacyReceipt(root, tier)));
    if (entry.root !== entry.id || (failed.get(entry.failure)?.size ?? 0) >= 2 || consumed && !entries.some(e => e.id === child)) {
      const last = [...failed.get(entry.failure)!.values()].at(-1)!;
      if (!escalated.has(entry.failure)) {
        escalations.push({ job: last.job, root: entries.find(e => e.id === last.job)?.root ?? entry.root,
          tier: tiers.get(last.job) ?? tier, reason: emptyFailure(last.row).reason,
          exitCode: typeof last.row.exit_code === 'number' && Number.isInteger(last.row.exit_code) ? last.row.exit_code : null });
        escalated.add(entry.failure);
      }
      continue;
    }
    if (consumed || entries.some(e => e.id === child || e.failure === entry.failure && e.root !== e.id)) continue;
    lines.push(`- READY ${child} (${entry.attrs.replace(/\btier=(frontier|work|mid|fast)\b/, `tier=${tier}`)}): ${entry.goal} Previous attempt ${entry.id} failed empty (exit ${exitCode ?? 'unknown'}). ${failure.reason} Inspect ${entry.id}.log and its original finish record before retrying. guardian-retry-root=${entry.root} guardian-retry-tier=${tier}`);
    reserved.add(entry.repo);
  }
  return { lines, escalations };
}
