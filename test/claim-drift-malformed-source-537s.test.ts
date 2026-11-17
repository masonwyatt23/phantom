import { describe, expect, it } from 'vitest';
import { readClaimStoreDrift, type ClaimDriftDeps } from '../src/core/fleet/claim-store-drift.js';

const now = 1_800_000_000_000;
const bus = { id: 'fake-537s', cursor: 1, receivedAt: now - 1, owner: 'fake-agent',
  leaseUntil: now + 1_000, completedAt: null };
const coord = { origin: 'message', key: 'queue:fake-537s', owner: 'fake-agent',
  sourceId: `fake-537s:1:${now - 1}`, leaseUntil: now + 1_000, live: true,
  repo: null, branch: null, path: null, started: null };
function read(busResult: unknown, coordResult: unknown) {
  return readClaimStoreDrift({ now,
    inspectBus: () => busResult, listCoord: () => coordResult,
  } as ClaimDriftDeps);
}
const available = (claims: unknown) => ({ source: 'available', claims });

describe('malformed claim source isolation (537s)', () => {
  for (const source of ['bus', 'coordination'] as const) {
    const row = source === 'bus' ? bus : coord;
    const malformed = [null, 7, [], {}, { source: 'future', claims: [] },
      available(null), available({}), available('fake'), available([null]), available([7]),
      available([[]]), available([{}]), available([row, null]), available(Array(1)),
      available([{ ...row, owner: null }]), available([{ ...row, leaseUntil: 'fake' }]),
      available([{ ...row, ...(source === 'bus' ? { cursor: '1' } : { live: 'true' }) }]),
      { source: 'missing', claims: [row] }, { source: 'missing', claims: null }];
    it.each(malformed.map((value, index) => [index, value] as const))(
      `${source} malformed case %i becomes UNKNOWN with a healthy peer`, (_index, value) => {
        for (const peer of [available([]), available([source === 'bus' ? coord : bus])]) {
          const verdict = source === 'bus' ? read(value, peer) : read(peer, value);
          expect(verdict).toMatchObject({ state: 'UNKNOWN', missing: [source], matched: 0,
            bus: source === 'bus' ? 'unavailable' : 'available',
            coordination: source === 'coordination' ? 'unavailable' : 'available',
            busOnly: [], coordOnly: [], ownerMismatch: [] });
        }
      });
  }
  it.each(['available', 'missing'])('retains healthy %s empty semantics', source => {
    expect(read({ source, claims: [] }, { source, claims: [] }))
      .toMatchObject({ state: 'VERIFIED', missing: [], matched: 0 });
  });
  it('retains matching verdicts and omits extra fencing tokens', () => {
    const verdict = read(available([{ ...bus, token: 'fake-bus-fence' }]),
      available([{ ...coord, token: 'fake-coord-fence' }]));
    expect(verdict).toMatchObject({ state: 'VERIFIED', matched: 1, missing: [] });
    expect(JSON.stringify(verdict)).not.toContain('fence');
  });
});
