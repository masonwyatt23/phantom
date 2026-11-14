/** Desktop surface for the Fleet Host pane's TailnetPeersCard: sanitized,
 * read-only list of tailnet peers this host can see. Never writes; runs only
 * `tailscale status --json` (via readTailnetPeers) and never returns
 * addresses, DNS names or keys (readTailnetPeers copies only name/os/online/
 * lastSeen). The TailnetPeers fields sit at the top level of the body so the
 * card's narrowTailnetPeers reads them directly. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import {
  defaultTailnetPeersDeps,
  readTailnetPeers,
  type TailnetPeers,
  type TailnetPeersDeps,
} from '../fleet/tailnet-peers.js';
import { UNKNOWN } from '../fleet/runtime-identity.js';

export const VERSE_FLEET_TAILNET_PEERS_PATH = '/api/verse/fleet/tailnet-peers';

export interface FleetTailnetPeersApiDeps {
  /** Reader seams for tests. Default: defaultTailnetPeersDeps(). */
  peersDeps?: TailnetPeersDeps;
  /** Clock seam for tests; stamps generatedAt. */
  now?: () => Date;
}

/** Empty list plus a reason; never carries the thrown message. */
function failedPeers(asOf: string): TailnetPeers {
  return { asOf, self: UNKNOWN, peers: [], reasons: ['tailnet peers: reader failed'] };
}

export function createFleetTailnetPeersApi(deps: FleetTailnetPeersApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_TAILNET_PEERS_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    const generatedAt = now().toISOString();
    let peers: TailnetPeers;
    try {
      peers = readTailnetPeers(deps.peersDeps ?? defaultTailnetPeersDeps());
    } catch {
      peers = failedPeers(generatedAt);
    }
    sendJson(res, 200, { v: 1, generatedAt, ...peers });
    return true;
  };
}

export const handleFleetTailnetPeersApi: ApiModule = createFleetTailnetPeersApi();
