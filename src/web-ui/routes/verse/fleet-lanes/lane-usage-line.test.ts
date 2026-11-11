import { describe, expect, it } from 'vitest';
import { laneProvider, laneUsageLine } from './lane-usage-line.js';

const now = Date.parse('2026-11-10T12:00:00.000Z');
const reading = { usedPct: 42, asOf: '2026-11-10T11:59:00.000Z', resetsAt: '2026-11-10T14:00:00.000Z', sourceState: 'healthy' as const };
describe('lane usage', () => {
  it.each([['codex-personal', 'codex-personal'], ['codex-cmp', 'codex-cmp'], ['claude', 'claude-a'], ['devin', 'devin'], ['devin-flash', 'devin'], ['codex-local', 'local']])('maps %s', (lane, provider) => expect(laneProvider(lane)).toBe(provider));
  it('omits unmapped lanes', () => expect(laneUsageLine('other', { rows: [], personal: null }, now)).toBeNull());
  it('shows current personal usage', () => expect(laneUsageLine('codex-personal', { rows: [], personal: reading }, now)?.text).toBe('42% used · resets in 2 h'));
  it('does not invent missing, stale, or expired readings', () => {
    for (const personal of [null, { ...reading, asOf: '2026-11-01T00:00:00.000Z' }, { ...reading, resetsAt: '2026-11-10T11:00:00.000Z' }]) {
      expect(laneUsageLine('codex-personal', { rows: [], personal }, now)?.text).toBe('usage unknown');
    }
  });
});
