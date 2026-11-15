import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { BridgeCheckEnvelope } from './bridge-check-model.js';

export const bridgeCheckQuery: QueryDef<BridgeCheckEnvelope | null> = {
  key: 'verse-fleet-bridge-check',
  async fetch(signal) {
    try {
      return await apiGet<BridgeCheckEnvelope>('/api/verse/fleet/runtime-identity/bridge-check', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
