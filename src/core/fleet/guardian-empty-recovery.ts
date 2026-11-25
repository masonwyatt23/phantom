import { createHash } from 'node:crypto';
import { classifyEmpty, type EmptyJobResult } from './empty-jobs.js';
import { parseLedgerTs } from '../metrics/loop.js';
import type { FleetMainHealthV1 } from './main-health.js';

const guardian = (id: string): boolean => /^(?:RQ-FIX-MAIN-|FIXUP-MAIN-)[\w.-]+$/.test(id);
export const guardianReceipt = (root: string, tier: string): string => createHash('sha256').update(`${root}:${tier}`).digest('hex');
export interface GuardianEmptyEscalation { job: string; root: string; tier: string; reason: string; exitCode: number | null }

/** Original artifacts stay untouched; one retry per observed repo/check/SHA, across job IDs and tiers. */
export function planGuardianEmptyRecovery(queue: string, ledger: string, receipts: Set<string>, health: FleetMainHealthV1): { lines: string[]; escalations: GuardianEmptyEscalation[] } {
  if (health.source !== 'ok' || health.stale || health.guardianOff) return { lines: [], escalations: [] };
  const entries = queue.split(/\r?\n/).flatMap(line => {
    const m = /^- (READY|DONE|CLAIMED(?: [\w.@:/-]+)*?) ([\w.-]+) \(([^)]*)\): (.+)$/.exec(line);
    if (!m || !guardian(m[2]!)) return [];
    return [{ status: m[1]!, id: m[2]!, attrs: m[3]!, repo: /\brepo=([\w.-]+)/.exec(m[3]!)?.[1],
      pool: /\bpool=([\w.-]+)/.exec(m[3]!)?.[1], tier: /\btier=(frontier|work|mid|fast)\b/.exec(m[3]!)?.[1],
      root: / guardian-retry-root=([\w.-]+) guardian-retry-tier=\w+$/.exec(m[4]!)?.[1] ?? m[2]!,
      failureKey: / guardian-retry-key=([a-f0-9]{64})\b/.exec(m[4]!)?.[1], goal: m[4]! }];
  });
  const latest = new Map<string, Record<string, unknown>>();
  const active = new Map<string, string | undefined>();
  const launched = new Map<string, number>();
  const tiers = new Map<string, string>();
  const published = new Set<string>();
  try {
    const rows = ledger.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>);
    const stamp = (row: Record<string, unknown>): number => parseLedgerTs(row.ts ?? row.timestamp ?? row.at) ?? NaN;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return { lines: [], escalations: [] };
      if (guardian(String(row.job ?? row.job_id ?? row.jobId ?? row.id)) && (!Number.isFinite(stamp(row)) || stamp(row) > Date.now())) return { lines: [], escalations: [] };
    }
    for (const row of rows.sort((a, b) => (stamp(a) || 0) - (stamp(b) || 0))) {
      const id = row.job ?? row.job_id ?? row.jobId ?? row.id;
      if (typeof id !== 'string' || !guardian(id)) continue;
      const event = row.event ?? row.type ?? row.kind;
      if (event === 'claim' || event === 'launch') {
        launched.set(id, stamp(row));
        active.set(id, typeof row.repo === 'string' ? row.repo.replace(/^ashlrai\//, '') : entries.find(e => e.id === id)?.repo);
        latest.delete(id);
        published.delete(id);
        if (typeof row.tier === 'string') tiers.set(id, row.tier);
      } else if (event === 'finish' && launched.has(id) && !published.has(id) && stamp(row) > launched.get(id)!) { latest.set(id, row); active.delete(id); }
      else if (['publish', 'published', 'outcome'].includes(String(event))) {
        const state = row.state ?? row.outcome ?? row.status;
        if (state === 'MERGED' || state === 'CLOSED') { latest.delete(id); active.delete(id); published.add(id); }
        else if (row.url || row.pr || row.prUrl) { latest.delete(id); active.set(id, entries.find(e => e.id === id)?.repo); published.add(id); }
      }
    }
  } catch { return { lines: [], escalations: [] }; } // Torn evidence never authorizes a retry.
  const lines: string[] = [], escalations: GuardianEmptyEscalation[] = [];
  const reserved = new Set<string>();
  const escalated = new Set<string>();
  // Prefer the exhausted child's evidence when the observation also holds its root.
  for (const entry of [...entries].sort((a, b) => Number(b.root !== b.id) - Number(a.root !== a.id))) {
    if (entry.status === 'READY' && entry.root === entry.id) continue; // The source itself is already queued.
    const row = latest.get(entry.id), tier = tiers.get(entry.id) ?? entry.tier;
    if (!row || !entry.repo || !entry.pool || !tier || !['fast', 'mid', 'work', 'frontier'].includes(tier)) continue;
    const observations = health.repos.filter(repo => repo.repo === entry.repo);
    const observed = observations.length === 1 ? observations[0] : undefined;
    const sha = /-([a-f0-9]{7,40})$/i.exec(entry.root)?.[1]?.toLowerCase();
    if (!observed || observed.state !== 'red' || !observed.sha || !observed.failingCheck || !sha || !observed.sha.toLowerCase().startsWith(sha)) continue;
    const key = guardianReceipt(JSON.stringify([entry.repo, observed.sha.toLowerCase(), observed.failingCheck]), 'failure');
    if (entry.failureKey && entry.failureKey !== key) continue;
    if (entries.filter(e => e.id === entry.id).length !== 1) continue;
    const exitCode = typeof row.exit_code === 'number' && Number.isInteger(row.exit_code) ? row.exit_code : null;
    const failure: Pick<EmptyJobResult, 'reason' | 'outcome'> = classifyEmpty(null, null, { exitCode, poolError: Boolean(row.pool_error) });
    if (failure.outcome !== 'failed' && row.empty !== true) continue;
    const child = `${entry.root}-EMPTYRETRY-${tier}-${key.slice(0, 12)}`;
    const retried = receipts.has(key) || ['fast', 'mid', 'work', 'frontier'].some(t => receipts.has(guardianReceipt(entry.root, t)));
    if (entry.root !== entry.id || observed.retryHold || retried && !entries.some(e => e.id === child || e.failureKey === key)) {
      if (!escalated.has(key)) escalations.push({ job: entry.id, root: entry.root, tier, reason: failure.reason, exitCode });
      escalated.add(key); continue;
    }
    if (retried) continue;
    if (reserved.has(entry.repo) || [...active.values()].some(repo => !repo || repo === entry.repo)
      || entries.some(e => e.id !== entry.id && e.repo === entry.repo && e.status !== 'DONE' && !latest.has(e.id))) continue;
    if (entries.some(e => e.id === child || e.failureKey === key || e.root === entry.root && e.id !== entry.id && !e.failureKey)) continue;
    lines.push(`- READY ${child} (${entry.attrs.replace(/\btier=(frontier|work|mid|fast)\b/, `tier=${tier}`)}): ${entry.goal} Previous attempt ${entry.id} failed or finished empty (exit ${exitCode ?? 'unknown'}). ${failure.reason} Inspect ${entry.id}.log and its original finish record before retrying. guardian-retry-key=${key} guardian-retry-root=${entry.root} guardian-retry-tier=${tier}`);
    reserved.add(entry.repo);
  }
  return { lines, escalations };
}
