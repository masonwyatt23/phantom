/** The Nov12 22:30 ET acceptance-item-5 board delta: `fleet work-board`
 * prints current state, but a task-thread reply should carry only what
 * changed since the agent's last look. Pure: no I/O, no clock. */
import { WORK_BOARD_MAX_LIMIT, type WorkBoardItem, type WorkBoardResult } from './work-board.js';
import type { WorkItemState } from './work-item-state.js';

export interface WorkBoardChange {
  id: string;
  channel: string;
  channelRef: string | null;
  /** null when the id was absent from the previous board (a new item). */
  from: WorkItemState | null;
  to: WorkItemState;
  /** Classified timestamp of the evidence behind the current state. */
  asOf: string;
  missing: string[];
}

const KNOWN_STATES: readonly WorkItemState[] = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'];

/** Output order: blockers lead, then the `to` ranking in the contract. */
const ORDER: Record<WorkItemState, number> = { BLOCKED: 0, VERIFIED: 1, ASSIGNED: 2, RECEIVED: 3, RUNNING: 4 };

/** A same-state move is never a change even when asOf advanced. Into
 * ASSIGNED, BLOCKED or VERIFIED always is, and so is any way out of BLOCKED.
 * On a new id (`from null`) those rules apply and a new RECEIVED ask is also
 * kept — someone must see the ask; an item first seen RUNNING was claimed
 * before anyone looked. */
function meaningful(from: WorkItemState | null, to: WorkItemState): boolean {
  if (from === to) return false;
  if (to === 'ASSIGNED' || to === 'BLOCKED' || to === 'VERIFIED') return true;
  if (from === 'BLOCKED') return true;
  return from === null && to === 'RECEIVED';
}

/** Diff two boards. An unreadable side (`inbox` unavailable) yields nothing —
 * a transition is never inferred from a board that could not be read. Ids
 * absent from `current` are not reported; they may be past the board limit. */
export function diffWorkBoards(previous: WorkBoardResult | null, current: WorkBoardResult): WorkBoardChange[] {
  if (current.inbox !== 'ok') return [];
  if (previous !== null && previous.inbox !== 'ok') return [];
  const before = new Map<string, WorkBoardItem>();
  for (const item of previous?.items ?? []) if (!before.has(item.id)) before.set(item.id, item);
  const changes: WorkBoardChange[] = [];
  const seen = new Set<string>();
  for (const item of current.items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const from = before.get(item.id)?.state ?? null;
    if (!meaningful(from, item.state)) continue;
    changes.push({
      id: item.id, channel: item.channel, channelRef: item.channelRef,
      from, to: item.state, asOf: item.asOf, missing: [...item.missing],
    });
  }
  changes.sort((a, b) => ORDER[a.to] - ORDER[b.to] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return changes;
}

const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;

/** Validate `fleet work-board --json` output. Strict on the fields this
 * module consumes — known states only, at most WORK_BOARD_MAX_LIMIT items,
 * strings length-bounded; unknown extra keys are ignored for forward compat. */
export function parseWorkBoardSnapshot(text: string): WorkBoardResult | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const view = data as Record<string, unknown>;
  const inbox = view['inbox'];
  if (inbox !== 'ok' && inbox !== 'unavailable') return null;
  if (typeof view['truncated'] !== 'boolean') return null;
  const raw = view['items'];
  if (!Array.isArray(raw) || raw.length > WORK_BOARD_MAX_LIMIT) return null;
  const items: WorkBoardItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    const missing = row['missing'];
    if (!Array.isArray(missing) || missing.length > 10
      || !missing.every(note => typeof note === 'string' && note.length <= 128)) return null;
    if (!bounded(row['id'], 256) || !bounded(row['channel'], 128)
      || !(row['channelRef'] === null || bounded(row['channelRef'], 1024))
      || !bounded(row['receivedAt'], 64) || !bounded(row['asOf'], 64) || !bounded(row['source'], 256)
      || !(KNOWN_STATES as readonly unknown[]).includes(row['state'])) return null;
    items.push({
      id: row['id'], channel: row['channel'], channelRef: row['channelRef'],
      receivedAt: row['receivedAt'], state: row['state'] as WorkItemState,
      asOf: row['asOf'], source: row['source'], missing: [...missing as string[]],
    });
  }
  return { items, inbox, truncated: view['truncated'] };
}
