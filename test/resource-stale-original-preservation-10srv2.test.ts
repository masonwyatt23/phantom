import { describe, expect, it, vi } from 'vitest';
import { cmdResourceStale, staleResources } from '../src/cli/resource-stale.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import type { CodexSessionUsage } from '../src/core/fleet/codex-session-usage.js';

const now = Date.parse('2026-11-09T12:00:00Z');
const old = '2026-11-09T09:00:00Z';
const fresh = '2026-11-09T11:30:00Z';
const row = (lane: string, at: string | null): ResourceLaneRow => ({
  lane, running: null, target: null, held: null, window: 'weekly', usedPct: 100,
  creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
  projectedExhaustion: null, source: null, deadSignal: null,
  quotaEvidence: { state: 'unknown', reason: 'no-reading', holdConflict: null, measuredQuota: null,
    statusQuota: { lane, window: 'weekly', usedPct: 100, resetAt: null, source: null, observedAt: at }, maxAgeMs: 300000 },
});
const ledger = (lanes: ResourceLaneRow[]): ResourceLedgerV1 => ({
  v: 1, generatedAt: new Date(now).toISOString(), asOf: new Date(now).toISOString(),
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, apiSpend: null, jobsMalformedRows: null, lanes,
});
const reading = (at: string | null, pct = 100): CodexSessionUsage => ({
  accountId: 'codex-personal', slot: 'secondary', observedAt: at, planType: null, limitId: null,
  limitName: null, rateLimitReachedType: null, spendControlReached: null, individualLimit: null,
  model: null, originator: null, cliVersion: null, primary: null,
  secondary: { usedPercent: pct, windowMinutes: 10080, resetsAt: null }, credits: null,
});
const inspect = (data: ResourceLedgerV1, probe: () => Promise<CodexSessionUsage>) =>
  staleResources({ now: () => now, ledger: async () => data, probe });

describe('original captured usage age contract', () => {
  it('uses the captured observation ahead of fresh ledger and status times, without mutating evidence', async () => {
    const personal = row('codex-personal', fresh);
    personal.observation = { source: 'codex-personal-sessions', asOf: old };
    const data = ledger([personal, row('claude', old)]);
    const before = structuredClone(data);
    const probe = vi.fn(async () => reading(fresh));
    const result = await inspect(data, probe);
    expect(result.resources[0]).toMatchObject({ observedAt: old, ageMs: 10800000, stale: true,
      refresh: 'current', refreshedAt: fresh, weeklyUsedPct: 100 });
    expect(result.resources[1]).toMatchObject({ stale: true, refresh: 'not-attempted', weeklyUsedPct: null });
    expect(probe).toHaveBeenCalledOnce();
    expect(data).toEqual(before);
  });

  it.each([null, 'not-a-time', '2026-11-09T12:00:01Z'])('keeps unusable captured time %s unknown', async at => {
    const probe = vi.fn(async () => reading(fresh));
    const result = await inspect(ledger([row('codex-personal', at)]), probe);
    expect(result.resources[0]).toMatchObject({ observedAt: null, ageMs: null, stale: null,
      refresh: 'not-attempted', refreshedAt: null, weeklyUsedPct: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not probe fresh personal evidence', async () => {
    const probe = vi.fn(async () => reading(fresh));
    const result = await inspect(ledger([row('codex-personal', fresh)]), probe);
    expect(result.resources[0]).toMatchObject({ ageMs: 1800000, stale: false, refresh: 'not-attempted', weeklyUsedPct: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    ['missing time', reading(null)], ['expired time', reading(old)],
    ['future time', reading('2026-11-09T12:00:01Z')], ['invalid time', reading('invalid')],
    ['missing weekly', { ...reading(fresh), secondary: null }],
    ['invalid percentage', reading(fresh, NaN)], ['short window', { ...reading(fresh), secondary: { usedPercent: 20, windowMinutes: 300, resetsAt: null } }],
  ] satisfies [string, CodexSessionUsage][])('reports failed refresh for %s', async (_label, value) => {
    const result = await inspect(ledger([row('codex-personal', old)]), async () => value);
    expect(result.resources[0]).toMatchObject({ observedAt: old, stale: true, refresh: 'failed', refreshedAt: null, weeklyUsedPct: null });
  });

  it('prints help and rejects invalid arguments without accessing default resources', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdResourceStale(['--help'])).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('not persisted'));
      expect(await cmdResourceStale(['--bad'])).toBe(2);
      expect(await cmdResourceStale(['--json', '--json'])).toBe(2);
      expect(error).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith('Usage: phm resources stale [--json]');
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});
