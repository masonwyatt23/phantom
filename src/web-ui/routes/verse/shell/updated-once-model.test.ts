import { describe, expect, it, vi } from 'vitest';
import { dismissUpdated, updatedNotice } from './updated-once-model.js';

describe('updatedNotice', () => {
  it('records first install and ignores the same version', () => {
    const storage = new Map<string, string>();
    const store = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } };
    expect(updatedNotice(store, '1.0.0')).toBeNull();
    expect(updatedNotice(store, '1.0.0')).toBeNull();
    expect(updatedNotice(store, '1.1.0')).toEqual({ from: '1.0.0', to: '1.1.0' });
    dismissUpdated(store, '1.1.0');
    expect(updatedNotice(store, '1.0.0')).toBeNull();
    expect(updatedNotice(store, '1.1.0')).toBeNull();
    expect(updatedNotice(store, '1.2.0')).toEqual({ from: '1.1.0', to: '1.2.0' });
  });
  it('ignores garbage and records a valid version', () => {
    const storage = { getItem: () => 'garbage', setItem: vi.fn() };
    expect(updatedNotice(storage, '1.0.0')).toBeNull();
    expect(storage.setItem).toHaveBeenCalledWith(expect.any(String), '1.0.0');
  });
  it('tolerates storage errors', () => {
    const storage = { getItem: () => { throw new Error(); }, setItem: () => { throw new Error(); } };
    expect(updatedNotice(storage, '1.0.0')).toBeNull();
    expect(() => dismissUpdated(storage, '1.0.0')).not.toThrow();
  });
});
