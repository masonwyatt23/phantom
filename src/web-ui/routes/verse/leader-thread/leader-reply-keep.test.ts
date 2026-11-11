import { describe, expect, it, vi } from 'vitest';
import { clearLeaderReply, loadLeaderReply, saveLeaderReply } from './leader-reply-keep.js';

describe('leader reply storage', () => {
  it('round trips, clears whitespace and caps text', () => {
    const storage = window.localStorage;
    clearLeaderReply(storage);
    saveLeaderReply(storage, 'Hello');
    expect(loadLeaderReply(storage)).toBe('Hello');
    saveLeaderReply(storage, 'x'.repeat(6001));
    expect(loadLeaderReply(storage)).toBe('x'.repeat(6000));
    saveLeaderReply(storage, ' \n ');
    expect(loadLeaderReply(storage)).toBe('');
  });

  it('tolerates absent and throwing storage', () => {
    const broken = { getItem: vi.fn(() => { throw new Error(); }), setItem: vi.fn(() => { throw new Error(); }), removeItem: vi.fn(() => { throw new Error(); }) } as unknown as Storage;
    for (const storage of [null, broken]) {
      expect(loadLeaderReply(storage)).toBe('');
      expect(() => saveLeaderReply(storage, 'text')).not.toThrow();
      expect(() => saveLeaderReply(storage, ' ')).not.toThrow();
      expect(() => clearLeaderReply(storage)).not.toThrow();
    }
    expect(loadLeaderReply({ getItem: () => 42 } as unknown as Storage)).toBe('');
  });
});
