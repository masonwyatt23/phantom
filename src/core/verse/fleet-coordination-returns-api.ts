/** Read-only retained RESULT receipts; agent evidence grants no authority. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readFleetBoard, type FleetBoard } from '../fleet/coordination.js';
import { projectCoordinationReturns } from '../fleet/coordination-returns-view.js';

export const VERSE_FLEET_COORDINATION_RETURNS_PATH = '/api/verse/fleet/coordination-claims/returns';

export function createFleetCoordinationReturnsApi(deps: { read?: () => FleetBoard; now?: () => Date } = {}): ApiModule {
  const read = deps.read ?? (() => readFleetBoard());
  const now = deps.now ?? (() => new Date());
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_COORDINATION_RETURNS_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    // The router strips queries from path; validate req.url before any host read.
    const params = new URL(req.url ?? '', 'http://local').searchParams;
    if ([...params.keys()].length > 0) {
      sendJson(res, 400, { v: 1, authority: 'none', error: 'no query accepted' });
      return true;
    }
    const at = now();
    let board: FleetBoard | null = null;
    try { board = read(); } catch { /* Project a fixed unknown reason, never the exception. */ }
    const projection = projectCoordinationReturns(board, at.getTime());
    sendJson(res, 200, { ...projection, v: 1, authority: 'none', generatedAt: at.toISOString() });
    return true;
  };
}

export const handleFleetCoordinationReturnsApi: ApiModule = createFleetCoordinationReturnsApi();
