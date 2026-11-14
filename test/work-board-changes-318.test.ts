/** Pure rules for the work-board transition diff and the snapshot parser.
 * Fixtures are plainly fake; no durable stores are touched. */
import { describe, expect, it } from 'vitest';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';
import type { WorkItemState } from '../src/core/comms/work-item-state.js';
import { diffWorkBoards, parseWorkBoardSnapshot } from '../src/core/comms/work-board-changes.js';

const T0 = '2026-11-12T00:00:00.000Z';
const item = (id: string, state: WorkItemState, over: Partial<WorkBoardItem> = {}): WorkBoardItem => ({
  id, channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1', receivedAt: T0,
  state, asOf: T0, source: 'fake-source', missing: [], ...over,
});
const board = (items: WorkBoardItem[], inbox: 'ok' | 'unavailable' = 'ok'): WorkBoardResult =>
  ({ items, inbox, truncated: false });
const moves = (changes: { id: string; from: WorkItemState | null; to: WorkItemState }[]) =>
  changes.map(c => `${c.id} ${c.from}->${c.to}`);

describe('diffWorkBoards', () => {
  it('new ids report from null: RECEIVED asks are kept, RUNNING is not; null previous means all new', () => {
    const changes = diffWorkBoards(board([]),
      board([item('new-ask', 'RECEIVED', { missing: ['named owner'] }), item('new-run', 'RUNNING')]));
    expect(changes).toEqual([{ id: 'new-ask', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
      from: null, to: 'RECEIVED', asOf: T0, missing: ['named owner'] }]);
    expect(moves(diffWorkBoards(null, board([item('a', 'RECEIVED'), item('b', 'BLOCKED')]))))
      .toEqual(['b null->BLOCKED', 'a null->RECEIVED']);
  });

  it('keeps moves into ASSIGNED, BLOCKED and VERIFIED, and every way out of BLOCKED', () => {
    expect(moves(diffWorkBoards(
      board([item('a', 'RECEIVED'), item('b', 'RUNNING'), item('c', 'ASSIGNED')]),
      board([item('a', 'ASSIGNED'), item('b', 'BLOCKED'), item('c', 'VERIFIED')]))))
      .toEqual(['b RUNNING->BLOCKED', 'c ASSIGNED->VERIFIED', 'a RECEIVED->ASSIGNED']);
    expect(moves(diffWorkBoards(
      board([item('x', 'BLOCKED'), item('y', 'BLOCKED')]),
      board([item('x', 'RUNNING'), item('y', 'RECEIVED')]))))
      .toEqual(['y BLOCKED->RECEIVED', 'x BLOCKED->RUNNING']);
  });

  it('drops non-meaningful moves, same-state pairs and asOf refreshes', () => {
    expect(diffWorkBoards(
      board([item('a', 'RECEIVED'), item('b', 'ASSIGNED'), item('c', 'RUNNING')]),
      board([item('a', 'RUNNING'), item('b', 'RECEIVED'), item('c', 'RECEIVED')]))).toEqual([]);
    expect(diffWorkBoards(board([item('r', 'RUNNING', { asOf: T0 })]),
      board([item('r', 'RUNNING', { asOf: '2026-11-12T00:29:00.000Z' })]))).toEqual([]);
  });

  it('ids missing from current are not reported; an unavailable side yields nothing', () => {
    expect(diffWorkBoards(board([item('gone', 'BLOCKED'), item('stay', 'RECEIVED')]),
      board([item('stay', 'RECEIVED')]))).toEqual([]);
    expect(diffWorkBoards(board([], 'unavailable'), board([item('a', 'RECEIVED')]))).toEqual([]);
    expect(diffWorkBoards(board([]), board([item('a', 'RECEIVED')], 'unavailable'))).toEqual([]);
    expect(diffWorkBoards(null, board([item('a', 'RECEIVED')], 'unavailable'))).toEqual([]);
  });

  it('sorts BLOCKED, VERIFIED, ASSIGNED, RECEIVED, then id', () => {
    expect(diffWorkBoards(board([]), board([
      item('z-recv', 'RECEIVED'), item('a-recv', 'RECEIVED'), item('m-asn', 'ASSIGNED'),
      item('v', 'VERIFIED'), item('blk', 'BLOCKED'),
    ])).map(c => c.id)).toEqual(['blk', 'v', 'm-asn', 'a-recv', 'z-recv']);
  });
});

describe('parseWorkBoardSnapshot', () => {
  const good = {
    items: [{ id: 'req-1', channel: 'slack', channelRef: 'T/C/1', receivedAt: T0,
      state: 'BLOCKED', asOf: T0, source: 'bus-reply:r1', missing: [] }],
    inbox: 'ok', truncated: false, asOf: T0,
  };
  const wrap = (items: unknown) => JSON.stringify({ items, inbox: 'ok', truncated: false });

  it('accepts `fleet work-board --json` documents and rejects other top-level shapes', () => {
    expect(parseWorkBoardSnapshot(JSON.stringify(good)))
      .toEqual({ items: [good.items[0]], inbox: 'ok', truncated: false });
    expect(parseWorkBoardSnapshot(JSON.stringify({ items: [], inbox: 'unavailable', truncated: false })))
      .toEqual({ items: [], inbox: 'unavailable', truncated: false });
    for (const text of ['not json', '42', '"str"', '[]', 'null',
      JSON.stringify({ items: 'x', inbox: 'ok', truncated: false }),
      JSON.stringify({ items: [], inbox: 'reading', truncated: false }),
      JSON.stringify({ items: [], inbox: 'ok', truncated: 'no' }),
      JSON.stringify({ inbox: 'ok', truncated: false })]) {
      expect(parseWorkBoardSnapshot(text), text).toBeNull();
    }
  });

  it('rejects more than 100 items, unknown states and wrongly typed or oversized fields', () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ ...good.items[0]!, id: `r-${i}` }));
    expect(parseWorkBoardSnapshot(wrap(items))).toBeNull();
    items.pop();
    expect(parseWorkBoardSnapshot(wrap(items))).not.toBeNull();
    const cases: unknown[] = [
      { ...good.items[0], state: 'DONE' }, { ...good.items[0], state: 3 }, { ...good.items[0], id: 7 },
      { ...good.items[0], id: '' }, { ...good.items[0], id: 'x'.repeat(257) },
      { ...good.items[0], channel: 'c'.repeat(129) }, { ...good.items[0], channelRef: 5 },
      { ...good.items[0], channelRef: 'r'.repeat(1025) }, { ...good.items[0], asOf: 't'.repeat(65) },
      { ...good.items[0], source: 's'.repeat(257) }, { ...good.items[0], missing: 'named owner' },
      { ...good.items[0], missing: [42] },
      { ...good.items[0], missing: Array.from({ length: 11 }, () => 'note') },
      { ...good.items[0], missing: ['n'.repeat(129)] },
      'a string', null, [],
    ];
    for (const entry of cases) {
      expect(parseWorkBoardSnapshot(wrap([entry])), JSON.stringify(entry)).toBeNull();
    }
  });

  it('ignores extra keys so a newer snapshot still loads, then diffs as a baseline', () => {
    const previous = parseWorkBoardSnapshot(
      JSON.stringify({ ...good, future: 1, items: [{ ...good.items[0], extra: 'y' }] }))!;
    expect(previous.items[0]).not.toHaveProperty('extra');
    expect(moves(diffWorkBoards(previous, board([item('req-1', 'VERIFIED')]))))
      .toEqual(['req-1 BLOCKED->VERIFIED']);
  });
});
