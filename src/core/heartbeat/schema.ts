import { z } from 'zod';
import { scrubSecrets } from '../util/scrub.js';

export const FINDING_TTL_MS = 15 * 60_000;
export const EXPIRE_MS = 30 * 60_000;
export const MAX_DIGEST_BYTES = 24 * 1024;
const safeText = (max: number) => z.string().min(1).max(max).refine(s => s.trim().length > 0 && scrubSecrets(s) === s);
const target = safeText(100).refine(s => /^[A-Za-z0-9_.:-]+$/.test(s));
export const findingSchema = z.object({
  kind: z.enum(['stale_job', 'idle_lane_with_queue', 'merge_stall', 'admission_flap', 'quota_waste', 'empty_signal_spike', 'worktree_leak']),
  severity: z.enum(['low', 'medium', 'high']),
  job: target.optional(), lane: target.optional(), evidence: safeText(600),
}).strict();
export const modelOutputSchema = z.object({
  findings: z.array(findingSchema).max(16),
  suggested_actions: z.array(safeText(300)).max(8),
}).strict();
const id = z.string().regex(/^[a-f0-9]{16}$/);
export const emittedFindingSchema = findingSchema.extend({ id });
export const tickSchema = z.object({
  schema: z.literal('heartbeat.fast.v1'), event: z.literal('heartbeat.tick'),
  ts: z.string().datetime(), interval_s: z.union([z.literal(60), z.literal(300), z.literal(900)]),
  interval_reason: safeText(160), model: z.literal('local:fast'),
  status: z.enum(['healthy', 'degraded']),
  findings: z.array(emittedFindingSchema).max(16),
  observed_ids: z.array(id).max(16),
  suggested_actions: z.array(safeText(300)).max(8),
}).strict();
export const entrySchema = z.object({
  finding: emittedFindingSchema, fingerprint: id,
  last_seen: z.number().finite().nonnegative(), last_emitted: z.number().finite().nonnegative(),
}).strict();
export const stateSchema = z.object({
  v: z.literal(1), last_tick: z.string().datetime(),
  interval_s: tickSchema.shape.interval_s, interval_reason: safeText(160),
  model_health: z.enum(['healthy', 'degraded']), consecutive_failures: z.number().int().nonnegative(),
  admissions: z.array(z.object({ at: z.number().finite(), admit: z.boolean() }).strict()).max(12),
  entries: z.array(entrySchema).max(128),
}).strict();
export type Finding = z.infer<typeof findingSchema>;
export type Tick = z.infer<typeof tickSchema>;
export type HeartbeatState = z.infer<typeof stateSchema>;
export type FindingEntry = z.infer<typeof entrySchema>;

/** Unconfirmed evidence loses a severity level every ten minutes, then expires. */
export function decayedFinding(entry: FindingEntry, now: number): FindingEntry['finding'] | null {
  const age = now - entry.last_seen;
  if (age < 0 || age >= EXPIRE_MS) return null;
  const levels = ['low', 'medium', 'high'] as const;
  return { ...entry.finding, severity: levels[Math.max(0, levels.indexOf(entry.finding.severity) - Math.floor(age / 600_000))]! };
}
