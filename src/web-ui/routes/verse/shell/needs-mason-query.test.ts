import { expect, it, vi } from 'vitest';
import { apiGet } from '../../../data/client.js';
import { needsMasonQuery } from './needs-mason-query.js';

vi.mock('../../../data/client.js', () => ({ apiGet: vi.fn() }));

it('keeps valid rows and drops malformed rows', async () => {
  vi.mocked(apiGet).mockResolvedValueOnce({ items: [{ id: 'a', text: 'ask' }, null, { id: 1, text: 'bad' }, { id: 'b' }] });
  await expect(needsMasonQuery.fetch()).resolves.toEqual([{ id: 'a', text: 'ask' }]);
});

it('accepts an empty list and rejects an invalid envelope', async () => {
  vi.mocked(apiGet).mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({});
  await expect(needsMasonQuery.fetch()).resolves.toEqual([]);
  await expect(needsMasonQuery.fetch()).rejects.toThrow('Invalid Needs Mason response');
});
