import { describe, expect, it, vi } from 'vitest';
import { clearPhoneLeaderDraft, loadPhoneLeaderDraft, savePhoneLeaderDraft } from './leader-draft-keep.js';

describe('phone Leader draft storage', () => {
  it('round trips text and clears whitespace', () => {
    const storage = window.localStorage;
    clearPhoneLeaderDraft(storage);
    savePhoneLeaderDraft(storage, '  Hello\nLeader  ');
    expect(loadPhoneLeaderDraft(storage)).toBe('  Hello\nLeader  ');
    savePhoneLeaderDraft(storage, ' \n ');
    expect(loadPhoneLeaderDraft(storage)).toBe('');
  });

  it('caps saved and loaded text', () => {
    const storage = window.localStorage;
    savePhoneLeaderDraft(storage, 'x'.repeat(6100));
    expect(loadPhoneLeaderDraft(storage)).toHaveLength(6000);
    storage.setItem('phantom.mobile.leaderDraft.v1', 'y'.repeat(6100));
    expect(loadPhoneLeaderDraft(storage)).toHaveLength(6000);
    clearPhoneLeaderDraft(storage);
  });

  it('tolerates absent and throwing storage', () => {
    const fail = vi.fn(() => { throw new Error('denied'); });
    const storage = { getItem: fail, setItem: fail, removeItem: fail } as unknown as Storage;
    for (const value of [null, storage]) {
      expect(loadPhoneLeaderDraft(value)).toBe('');
      expect(() => savePhoneLeaderDraft(value, 'text')).not.toThrow();
      expect(() => savePhoneLeaderDraft(value, ' ')).not.toThrow();
      expect(() => clearPhoneLeaderDraft(value)).not.toThrow();
    }
  });
});
