/** Read-only peer-bus budget evidence under the existing identity prefix:
 * the merged peer ledger's rate-limit, capacity and hop-cap view for the
 * console and reconnecting agents. Never writes; a thrown reader degrades to
 * a fixed unavailable report and never leaks the error text. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { PEER_MAX_HOPS, PEER_PAIR_LIMIT, PEER_WINDOW_MS } from '../agentnet/peer-bus.js';
import { readPeerLedger, type PeerLedgerReport } from '../agentnet/peer-ledger.js';

export const VERSE_FLEET_PEER_LEDGER_PATH = '/api/verse/fleet/runtime-identity/peer-ledger';

export interface FleetPeerLedgerResponse {
  v: 1;
  authority: 'none';
  generatedAt: string;
  report: PeerLedgerReport;
}

export interface FleetPeerLedgerApiDeps {
  /** Reader seam for tests. Default: readPeerLedger(). */
  read?: () => PeerLedgerReport;
  /** Clock seam for tests; stamps generatedAt and a degraded report's asOf. */
  now?: () => Date;
}

/** Fixed shape when the reader fails; never carries the thrown message. */
function unavailableReport(asOf: string): PeerLedgerReport {
  return {
    v: 1, authority: 'none', status: 'unavailable', reason: 'peer-ledger-reader-failed', asOf,
    liveRows: 0, capacity: 1024, windowMs: PEER_WINDOW_MS, pairLimit: PEER_PAIR_LIMIT, maxHops: PEER_MAX_HOPS,
    pairs: [], origins: [], truncated: { pairs: false, origins: false },
  };
}

export function createFleetPeerLedgerApi(deps: FleetPeerLedgerApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const read = deps.read ?? (() => readPeerLedger());
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_PEER_LEDGER_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const generatedAt = now().toISOString();
    // The router already stripped the query from `path`; read it from req.url.
    // This endpoint accepts no parameters at all.
    if ([...new URL(req.url ?? '', 'http://local').searchParams.keys()].length > 0) {
      sendJson(res, 400, { v: 1, authority: 'none', error: 'no parameters accepted' });
      return true;
    }
    let report: PeerLedgerReport;
    try {
      const candidate = read();
      report = typeof candidate === 'object' && candidate !== null ? candidate : unavailableReport(generatedAt);
    } catch {
      report = unavailableReport(generatedAt);
    }
    const response: FleetPeerLedgerResponse = { v: 1, authority: 'none', generatedAt, report };
    sendJson(res, 200, response);
    return true;
  };
}

export const handleFleetPeerLedgerApi: ApiModule = createFleetPeerLedgerApi();
