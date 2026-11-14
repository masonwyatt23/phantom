/** Read-only runtime identity: which host and build answers, and how fresh its fleet-state read is. */
import { homedir } from 'node:os';
import { defaultRuntimeIdentityDeps, readRuntimeIdentity, sanitizeIdentityText, type RuntimeIdentity } from '../fleet/runtime-identity.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_RUNTIME_IDENTITY_PATH = '/api/verse/fleet/runtime-identity';
// readRuntimeIdentity runs a binary synchronously, so polls share one read.
const CACHE_MS = 30_000;

export interface FleetRuntimeIdentityApiDeps { identity?: () => RuntimeIdentity; now?: () => number }

function home(): string { try { return homedir(); } catch { return ''; } }

// Second pass over every string: the reader already redacts, this guards against drift.
function scrub(value: unknown, h: string): unknown {
  if (typeof value === 'string') return sanitizeIdentityText(value, h).replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
  if (Array.isArray(value)) return value.map(v => scrub(v, h));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, h)]));
  }
  return value;
}

export function createFleetRuntimeIdentityApi(deps: FleetRuntimeIdentityApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  const read = deps.identity ?? (() => readRuntimeIdentity(defaultRuntimeIdentityDeps()));
  let cached: { at: number; body: object } | undefined;
  function snapshot(): object {
    const generatedAt = new Date(now()).toISOString();
    try {
      return { v: 1, generatedAt, identity: scrub(read(), home()) };
    } catch { // Never echo the error, stack or paths.
      return { v: 1, generatedAt, identity: null, reasons: ['read failed'] };
    }
  }
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_RUNTIME_IDENTITY_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!cached || now() - cached.at >= CACHE_MS) cached = { at: now(), body: snapshot() };
    sendJson(res, 200, cached.body);
    return true;
  };
}
export const handleFleetRuntimeIdentityApi: ApiModule = createFleetRuntimeIdentityApi();
