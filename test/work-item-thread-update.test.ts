// Nov12 22:30 ET contract: thread updates only on meaningful state changes.
import { describe, expect, it } from 'vitest';
import { decideThreadUpdate, THREAD_LINE_MAX, type PostedThreadState } from '../src/core/comms/work-item-thread-update.js';
import type { WorkItemClassification, WorkItemState } from '../src/core/comms/work-item-state.js';

const ID = 'fake-item-1';
const cls = (state: WorkItemState, asOf: string, source: string, missing: string[] = []): { id: string } & WorkItemClassification =>
  ({ id: ID, state, asOf, source, missing });
const prevOf = (state: WorkItemState, source: string, postedAt = '2026-01-01T00:00:00Z'): PostedThreadState =>
  ({ id: ID, state, source, postedAt });

describe('decideThreadUpdate rules', () => {
  const T1 = '2026-01-01T00:00:00Z';
  const T2 = '2026-01-01T00:10:00Z';
  const table: Array<[string, PostedThreadState | undefined, ReturnType<typeof cls>, boolean, string?]> = [
    ['1 first RECEIVED posts', undefined, cls('RECEIVED', T1, 'receivedAt', ['named owner']), true],
    ['1 first VERIFIED posts', undefined, cls('VERIFIED', T1, 'ci'), true],
    ['2 same state+source', prevOf('ASSIGNED', 'claim:x'), cls('ASSIGNED', T2, 'claim:x'), false, 'unchanged'],
    ['3 RUNNING heartbeat same source', prevOf('RUNNING', 'w'), cls('RUNNING', T2, 'w'), false, 'unchanged'],
    ['3 RUNNING heartbeat new source', prevOf('RUNNING', 'w'), cls('RUNNING', T2, 'w2'), false, 'heartbeat'],
    ['4 into ASSIGNED', prevOf('RECEIVED', 'receivedAt'), cls('ASSIGNED', T2, 'claim:x'), true],
    ['4 into BLOCKED', prevOf('RUNNING', 'w'), cls('BLOCKED', T2, 'dep'), true],
    ['4 into VERIFIED', prevOf('BLOCKED', 'dep'), cls('VERIFIED', T2, 'ci'), true],
    ['4 into RUNNING', prevOf('ASSIGNED', 'claim:x'), cls('RUNNING', T2, 'w'), true],
    ['5 RUNNING to ASSIGNED stale', prevOf('RUNNING', 'w'), cls('ASSIGNED', T2, 'claim:x', ['fresh running evidence']), true],
    ['6 VERIFIED to RUNNING', prevOf('VERIFIED', 'ci'), cls('RUNNING', T2, 'w'), false, 'already-verified'],
    ['6 VERIFIED to BLOCKED', prevOf('VERIFIED', 'ci'), cls('BLOCKED', T2, 'dep'), false, 'already-verified'],
    ['6 VERIFIED again', prevOf('VERIFIED', 'ci'), cls('VERIFIED', T2, 'ci2'), false, 'already-verified'],
    ['regression to RECEIVED', prevOf('ASSIGNED', 'claim:x'), cls('RECEIVED', T2, 'receivedAt'), false, 'regression'],
  ];
  it.each(table)('%s', (_n, prev, next, post, reason) => {
    const d = decideThreadUpdate(prev, next);
    expect(d.post).toBe(post);
    if (!d.post) expect(d.reason).toBe(reason);
    else {
      expect(d.record).toEqual({ id: ID, state: next.state, source: next.source, postedAt: next.asOf });
      expect(d.line).toMatch(new RegExp(`^\\[${next.state}\\] ${ID} as-of `));
    }
  });

  it('5 names missing evidence even if classifier omitted it', () => {
    const d = decideThreadUpdate(prevOf('RUNNING', 'w'), cls('ASSIGNED', T2, 'claim:x'));
    expect(d.post && d.line).toBe(`[ASSIGNED] ${ID} as-of ${T2} via claim:x missing: fresh running evidence`);
  });

  it('formats line without missing suffix', () => {
    const d = decideThreadUpdate(undefined, cls('RUNNING', T1, 'w'));
    expect(d.post && d.line).toBe(`[RUNNING] ${ID} as-of ${T1} via w`);
  });

  it('7 id mismatch throws TypeError', () => {
    expect(() => decideThreadUpdate({ ...prevOf('RUNNING', 'w'), id: 'other-fake' }, cls('RUNNING', T2, 'w'))).toThrow(TypeError);
  });

  it('caps at 280 chars, one ASCII line, scrubbed', () => {
    const d = decideThreadUpdate(undefined, cls('RECEIVED', T1, 'src\né ' + 'x'.repeat(400), ['a']));
    expect(d.post).toBe(true);
    if (d.post) {
      expect(d.line.length).toBeLessThanOrEqual(THREAD_LINE_MAX);
      expect(d.line).toMatch(/^[\x20-\x7e]+$/);
    }
    const s = decideThreadUpdate(undefined, cls('RUNNING', T1, 'token=sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE1234'));
    expect(s.post && s.line).not.toContain('FAKEFAKEFAKE');
  });

  it('full sequence posts exactly 5 times', () => {
    const steps = [
      cls('RECEIVED', '2026-01-01T00:00:00Z', 'receivedAt', ['named owner']),
      cls('ASSIGNED', '2026-01-01T00:01:00Z', 'claim:x'),
      cls('RUNNING', '2026-01-01T00:02:00Z', 'w'),
      cls('RUNNING', '2026-01-01T00:12:00Z', 'w'),
      cls('ASSIGNED', '2026-01-01T00:50:00Z', 'claim:x', ['fresh running evidence']),
      cls('VERIFIED', '2026-01-01T01:00:00Z', 'ci'),
      cls('RUNNING', '2026-01-01T01:05:00Z', 'w'),
    ];
    let prev: PostedThreadState | undefined;
    const posted: boolean[] = [];
    for (const s of steps) {
      const d = decideThreadUpdate(prev, s);
      posted.push(d.post);
      if (d.post) prev = d.record;
    }
    expect(posted).toEqual([true, true, true, false, true, true, false]);
    expect(posted.filter(Boolean)).toHaveLength(5);
  });
});
