import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface NeedsMasonRow { id: string; text: string }

export const needsMasonQuery: QueryDef<NeedsMasonRow[]> = {
  key: 'verse-needs-mason',
  async fetch(signal) {
    const response = await apiGet<unknown>('/api/verse/agent-bus/needs-mason', signal);
    if (!response || typeof response !== 'object' || !('items' in response) || !Array.isArray(response.items)) {
      throw new Error('Invalid Needs Mason response');
    }
    return response.items.filter((row: unknown): row is NeedsMasonRow =>
      row !== null && typeof row === 'object' && 'id' in row && typeof row.id === 'string'
      && 'text' in row && typeof row.text === 'string');
  },
};
