/**
 * fleet/lane-capacity-read.ts — dispatchd's own lane capacity: running/
 * target/queued/held from <runsDir>/queue/status.json, the held reason from
 * queue/slots.json (readLaneTargets), where dispatchd keeps it today. The
 * independent observation that stands in for a stale standing tick so the
 * lane chips show real running-of-target (RQ-PHX-LANECAPACITYREAD81).
 *
 * Tolerant per field: a lane without a safe running/target pair is dropped
 * (it cannot answer "N of M") and optionals stay null rather than guessed. A
 * missing, unparsable or >10-minute-old status write is `stale`.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { GLOBAL_SLOT_KEYS, LANE_ID_RE, readLaneTargets } from './runs-lane-targets.js';
import type { FleetEngine } from './fleet-types.js';

export interface LaneCapacityLane {
  lane: string;
  running: number;
  target: number;
  queued: number | null;
  held: boolean;
  heldReason: string | null;
}

/** The capacity observation the live API substitutes for a stale standing tick. */
export interface LaneCapacityRead {
  lanes: LaneCapacityLane[];
  /** The status file's `last_tick`; null when it carried no valid one. */
  observedAt: string | null;
  /** True when there is no observation or it is older than LANE_CAPACITY_STALE_MS. */
  stale: boolean;
}

/** A status write older than this cannot stand in for the standing tick. */
export const LANE_CAPACITY_STALE_MS = 10 * 60_000;

const MAX_BYTES = 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const object = (v: unknown): Record<string, unknown> => isObject(v) ? v : {};
const integer = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
const timestamp = (v: unknown): v is string => typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v));

/**
 * The dispatchd lane (queue/status.json id, see LANES in contrib/mac/
 * dispatchd.py) a Fleet lane reads through. codex → codex-cmp, the general
 * pool — codex-personal serves only maintenance lines (drive/pool-routing.ts)
 * and claude-api is API credit with no chip. dispatchd has no grok lane
 * today; the id is named so a future one matches, until then it just misses.
 */
export const DISPATCHD_LANE: Readonly<Record<FleetEngine, string>> = {
  local: 'codex-local',
  'grok-cli': 'grok',
  'claude-cli': 'claude',
  codex: 'codex-cmp',
  'devin-cli': 'devin',
};

/** Bounded, descriptor-bound read of one JSON object; null on any failure. */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_BYTES) return null;
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const chunk = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!chunk.bytesRead) break;
        offset += chunk.bytesRead;
      }
      const parsed: unknown = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
      return isObject(parsed) ? parsed : null;
    } finally { await file.close(); }
  } catch {
    return null;
  }
}

/** The held reason as the operator reads it — scrubbed, path-free, bounded. */
function cleanReason(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return scrubSecrets(value).replace(/(?:[A-Za-z]:\\|~\/|\/)[^\s"'<>]*/g, '[path]')
    .replace(/\p{Cc}/gu, ' ').trim().slice(0, 200) || null;
}

/**
 * dispatchd's per-lane running/target/queued/held. `stale` is the caller's
 * signal to keep the "unobserved" text: it is true exactly when the status
 * write is missing, unreadable, or more than 10 minutes old.
 */
export async function readLaneCapacity(runsDir: string, now: number): Promise<LaneCapacityRead> {
  const [status, slots] = await Promise.all([
    readJson(join(runsDir, 'queue', 'status.json')),
    readLaneTargets({ runsDir }).catch(() => null),
  ]);
  const slotsByLane = new Map((slots?.lanes ?? []).map((l) => [l.lane, l]));
  const lanes: LaneCapacityLane[] = [];
  for (const [lane, raw] of Object.entries(object(status?.lanes))) {
    if (!LANE_ID_RE.test(lane) || GLOBAL_SLOT_KEYS.has(lane) || !isObject(raw)) continue;
    const running = integer(raw.running);
    const target = integer(raw.target);
    // Without both counters the entry cannot answer "N of M" — skip it.
    if (running === null || target === null) continue;
    const slot = slotsByLane.get(lane);
    const held = raw.held === true || slot?.held === true;
    const heldReason = cleanReason(raw.held_reason) ?? cleanReason(slot?.heldReason);
    lanes.push({ lane, running, target, queued: integer(raw.queued), held, heldReason });
  }
  lanes.sort((a, b) => a.lane.localeCompare(b.lane));
  const observedAt = timestamp(status?.last_tick) ? status.last_tick : null;
  return { lanes, observedAt, stale: observedAt === null || now - Date.parse(observedAt) > LANE_CAPACITY_STALE_MS };
}
