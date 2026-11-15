/** Teammate framing over the shared, freshness-attributed fleet evidence plane. */
import { buildFleetVitals } from '../fleet/vitals.js';
import { formatFleetVitals } from '../fleet/vitals-format.js';
import { scrubSecrets } from '../util/scrub.js';

export { FLEET_VITALS_STALE_MS as TEAMMATE_LIVE_STATUS_STALE_MS } from '../fleet/vitals.js';
export const CONTEXT_MAX_CHARS = 20000;

export function buildTeammateOperationalContext(runsDir: string, nowMs: number): string {
  const vitals = buildFleetVitals(runsDir, nowMs);
  const sections = [
    `Context assembled: ${vitals.assembledAt} (assembly time; each source's file time is listed with it)`,
    `Responder source: ${scrubSecrets(process.env.PHANTOM_COMMS_SOURCE_SHA ?? 'unknown').slice(0, 120)}`,
    `Installed desktop version: ${scrubSecrets(process.env.PHANTOM_COMMS_DESKTOP_VERSION ?? 'unknown').slice(0, 120)}`,
    formatFleetVitals(vitals),
  ];
  return sections.join('\n').slice(0, CONTEXT_MAX_CHARS);
}
