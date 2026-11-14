/** `ashlr fleet work-board-changes` — diff the current durable-bus work
 * board against a saved `fleet work-board --json` snapshot and print only the
 * meaningful transitions (a new ask, an assignment, a blocker, a verification,
 * or a way out of BLOCKED), so a task-thread reply carries the delta instead
 * of the whole board. Read-only: the snapshot is never written here. */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ashlrHome } from '../core/cloud/store.js';
import { listWorkBoard, type WorkBoardResult } from '../core/comms/work-board.js';
import { diffWorkBoards, parseWorkBoardSnapshot } from '../core/comms/work-board-changes.js';

const SNAPSHOT_MAX_BYTES = 1024 * 1024;

const usage = 'Usage: ashlr fleet work-board-changes [--previous <absolute>] [--thread <channel_ref>] [--limit <1..100>] [--json]\n'
  + 'Prints one line per meaningful change: ID FROM->TO channel=... ref=... missing=..., then\n'
  + 'changes=N inbox=ok|unavailable as-of=<now>. An unreadable --previous reports\n'
  + 'previous=unreadable and every current item diffs as new. Read-only.';

type PreviousStatus = 'ok' | 'unreadable' | 'none';

function readPrevious(path: string): { board: WorkBoardResult | null; status: PreviousStatus } {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > SNAPSHOT_MAX_BYTES) return { board: null, status: 'unreadable' };
    const board = parseWorkBoardSnapshot(readFileSync(path, 'utf8'));
    return board === null ? { board: null, status: 'unreadable' } : { board, status: 'ok' };
  } catch { return { board: null, status: 'unreadable' }; }
}

export async function cmdFleetWorkBoardChanges(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let previousPath: string | undefined, thread: string | undefined, limit: number | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key !== '--previous' && key !== '--thread' && key !== '--limit') { console.error(usage); return 2; }
    const value = args[++i];
    if (!value || value.startsWith('--')) { console.error(usage); return 2; }
    if (key === '--previous' && previousPath === undefined) previousPath = value;
    else if (key === '--thread' && thread === undefined) thread = value;
    else if (key === '--limit' && limit === undefined && /^\d+(?![\s\S])/.test(value)
      && Number(value) >= 1 && Number(value) <= 100) limit = Number(value);
    else { console.error(usage); return 2; }
  }
  if (previousPath !== undefined && (!isAbsolute(previousPath) || previousPath.includes('\0'))) {
    console.error(usage); return 2;
  }
  const now = Date.now();
  const prev = previousPath === undefined
    ? { board: null, status: 'none' as PreviousStatus }
    : readPrevious(previousPath);
  const board = listWorkBoard({ root: join(ashlrHome(), 'fleet'), now, limit, channelRef: thread });
  const changes = diffWorkBoards(prev.board, board);
  const asOf = new Date(now).toISOString();
  if (json) {
    console.log(JSON.stringify({ changes, inbox: board.inbox, previous: prev.status, asOf }));
    return 0;
  }
  for (const change of changes) {
    console.log(`${change.id} ${change.from ?? 'none'}->${change.to} channel=${change.channel} `
      + `ref=${change.channelRef ?? 'none'} missing=${change.missing.length ? change.missing.join(',') : 'none'}`);
  }
  if (prev.status === 'unreadable') console.log('previous=unreadable');
  console.log(`changes=${changes.length} inbox=${board.inbox} as-of=${asOf}`);
  return 0;
}
