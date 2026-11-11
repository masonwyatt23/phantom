import { describe, expect, it } from 'vitest';
import { windowItems } from './thread-window-model.js';

const day = (key: string) => ({ type: 'day', key });
const row = (key: string) => ({ type: 'line', key });

describe('windowItems', () => {
  const items = [day('d1'), row('1'), row('2'), day('d2'), row('3'), row('4')];
  it('returns all rows under the limit', () => {
    expect(windowItems(items, 10)).toEqual({ shown: items, hidden: 0 });
  });
  it('keeps the newest rows and their heading, counting only hidden rows', () => {
    expect(windowItems(items, 3)).toEqual({ shown: [day('d1'), row('2'), day('d2'), row('3'), row('4')], hidden: 1 });
  });
  it('does not include an orphan heading when no rows are shown', () => {
    expect(windowItems(items, 0)).toEqual({ shown: [], hidden: 4 });
    expect(windowItems([day('empty')], 10)).toEqual({ shown: [], hidden: 0 });
  });
  it('does not invent a heading for undated rows', () => {
    expect(windowItems([row('1'), row('2')], 1)).toEqual({ shown: [row('2')], hidden: 1 });
  });
});
