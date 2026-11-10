const LAST_VERSION = 'phantom.updated-once.last-version';
const DISMISSED_VERSION = 'phantom.updated-once.dismissed-version';
type Store = Pick<Storage, 'getItem' | 'setItem'>;

function parse(version: string): { core: bigint[]; pre: string[] | null } | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? null;
  if (pre?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], pre };
}

function before(a: NonNullable<ReturnType<typeof parse>>, b: NonNullable<ReturnType<typeof parse>>): boolean {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]!;
  }
  if (!a.pre || !b.pre) return a.pre !== null && b.pre === null;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined && y !== undefined;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y);
    if (xn !== yn) return xn;
    return x < y;
  }
  return false;
}

export function updatedNotice(storage: Store, currentVersion: string): { from: string; to: string } | null {
  try {
    const current = parse(currentVersion);
    if (!current) return null;
    const previous = storage.getItem(LAST_VERSION);
    const dismissed = storage.getItem(DISMISSED_VERSION);
    storage.setItem(LAST_VERSION, currentVersion);
    const old = previous === null ? null : parse(previous);
    return old && previous && dismissed !== currentVersion && before(old, current) ? { from: previous, to: currentVersion } : null;
  } catch { return null; }
}

export function dismissUpdated(storage: Store, version: string): void {
  try { storage.setItem(DISMISSED_VERSION, version); } catch { /* Storage may be unavailable. */ }
}
