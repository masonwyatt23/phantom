/** Wire contract kept local to the web bundle; narrowed at the display boundary. */
export interface BridgeCheckEnvelope {
  v: 1;
  authority: 'none';
  check: unknown;
}

export interface BridgeSectionStatus { name: 'runtime' | 'claims' | 'peers'; text: string }

export type ParsedBridgeCheck = { kind: 'invalid' } | {
  kind: 'ok';
  verdict: 'READY' | 'BLOCKED';
  asOf: string;
  missing: string[];
  reason: string | null;
  live: number | null;
  sections: BridgeSectionStatus[];
};

export const MAX_MISSING = 16;
export const MAX_MISSING_CHARS = 64;

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const clean = (v: string, max: number): string => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max);

function section(name: BridgeSectionStatus['name'], raw: unknown, extra?: string): BridgeSectionStatus | null {
  if (!object(raw) || typeof raw.status !== 'string') return null;
  const reason = typeof raw.reason === 'string' ? clean(raw.reason, 80) : '';
  const parts = [clean(raw.status, 32) || 'unknown', extra, reason].filter(Boolean);
  return { name, text: `${name}: ${parts.join(' · ')}` };
}

export function parseBridgeCheck(body: unknown): ParsedBridgeCheck {
  if (!object(body) || body.v !== 1 || body.authority !== 'none' || !object(body.check)) return { kind: 'invalid' };
  const check = body.check;
  if (check.verdict !== 'READY' && check.verdict !== 'BLOCKED') return { kind: 'invalid' };
  if (typeof check.asOf !== 'string' || !Number.isFinite(Date.parse(check.asOf))) return { kind: 'invalid' };
  const missing = Array.isArray(check.missing)
    ? check.missing.filter((m): m is string => typeof m === 'string').map(m => clean(m, MAX_MISSING_CHARS)).filter(m => m !== '').slice(0, MAX_MISSING)
    : [];
  const claims = object(check.claims) ? check.claims : null;
  const live = claims && typeof claims.live === 'number' && Number.isSafeInteger(claims.live) && claims.live >= 0 ? claims.live : null;
  const sections = [
    section('runtime', check.runtime),
    section('claims', check.claims, live === null ? undefined : `${live} live`),
    section('peers', check.peers),
  ].filter((s): s is BridgeSectionStatus => s !== null);
  return {
    kind: 'ok', verdict: check.verdict, asOf: check.asOf, missing, sections, live,
    reason: typeof check.reason === 'string' && clean(check.reason, 120) !== '' ? clean(check.reason, 120) : null,
  };
}

export function bridgeCheckHeadline(parsed: ParsedBridgeCheck): { text: string; tone: 'ok' | 'danger' | 'unknown' } {
  if (parsed.kind === 'invalid') return { text: 'Bridge: unknown (invalid response)', tone: 'unknown' };
  // READY is claimed only when the verdict is READY and nothing is missing.
  if (parsed.verdict === 'READY' && parsed.missing.length === 0) {
    return { text: `Bridge: READY · ${parsed.live ?? 'unknown'} live claims`, tone: 'ok' };
  }
  const names = parsed.missing.length > 0 ? parsed.missing.join(', ') : parsed.reason ?? 'unspecified';
  return { text: `Bridge: BLOCKED · missing ${names}`, tone: 'danger' };
}
