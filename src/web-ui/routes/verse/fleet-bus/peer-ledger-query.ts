import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

/** Kept local to the web bundle; the report is narrowed at the display boundary. */
export interface PeerLedgerResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  report: unknown;
}

/** Mirrors VERSE_FLEET_PEER_LEDGER_PATH in src/core/verse/fleet-peer-ledger-api.ts. */
const PEER_LEDGER_PATH = '/api/verse/fleet/peer-ledger';

/**
 * The server returns the flat report; the model parses an envelope. Wrap only a
 * well-formed flat report. Anything else passes through so the parser rejects it.
 */
function toEnvelope(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const flat = body as Record<string, unknown>;
  if (flat.v !== 1 || flat.authority !== 'none' || 'report' in flat) return body;
  const generatedAt = typeof flat.asOf === 'string' ? flat.asOf : new Date().toISOString();
  return { v: 1, authority: 'none', generatedAt, report: body };
}

export const peerLedgerQuery: QueryDef<PeerLedgerResponse | null> = {
  key: 'verse-fleet-peer-ledger',
  async fetch(signal) {
    try {
      return toEnvelope(await apiGet<unknown>(PEER_LEDGER_PATH, signal)) as PeerLedgerResponse;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
