/** Desktop/remote surface for the fleet recheck verdict (fleet.recheck.v1):
 * the same answer `ashlr fleet recheck` prints. Read-only evidence; it grants
 * no dispatch, claim or merge authority. The route takes no query, path, root
 * or cwd input. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { FLEET_RECHECK_SCHEMA, readFleetRecheck, type FleetRecheck } from '../fleet/fleet-recheck.js';

export const VERSE_FLEET_RECHECK_PATH = '/api/verse/fleet/recheck';

export interface FleetRecheckApiDeps {
  /** Reader seam for tests. Default: readFleetRecheck(). */
  read?: () => Promise<FleetRecheck>;
}

export function createFleetRecheckApi(deps: FleetRecheckApiDeps = {}): ApiModule {
  const read = deps.read ?? (() => readFleetRecheck());
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_RECHECK_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    try {
      sendJson(res, 200, await read());
    } catch {
      // Never a fake VERIFIED, and never any error text in the body.
      sendJson(res, 200, {
        schema: FLEET_RECHECK_SCHEMA,
        asOf: new Date().toISOString(),
        overall: { state: 'UNKNOWN', missing: ['recheck: reader failed'] },
        sections: null,
      });
    }
    return true;
  };
}

export const handleFleetRecheckApi: ApiModule = createFleetRecheckApi();
