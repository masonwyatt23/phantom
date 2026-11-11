import { describe, expect, it } from 'vitest';
import { countNewBelow, pillLabel } from './new-below-model.js';

describe('new lines below', () => {
  it('counts leader and system lines after the anchor, excluding the owner', () => {
    const lines = [{ key: 'a', countable: true }, { key: 'b', countable: false }, { key: 'c', countable: true }, { key: 'd', countable: true }];
    expect(countNewBelow(lines, 'a')).toBe(2);
    expect(countNewBelow(lines, 'missing')).toBe(0);
    expect(countNewBelow(lines, null)).toBe(0);
  });
  it('formats singular, plural and capped counts', () => {
    expect(pillLabel(1)).toBe('1 new message');
    expect(pillLabel(2)).toBe('2 new messages');
    expect(pillLabel(100)).toBe('99+ new messages');
  });
});
