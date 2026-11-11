import { describe, expect, it } from 'vitest';
import { gatherStatusDigestInput, type StatusDigestSources } from '../src/core/leader/status-digest-sources.js';
import type { InboxEntry } from '../src/core/fleet/mason-inbox.js';

const sources: StatusDigestSources = {
  installedVersion: () => '3.30.9',
  publishedVersion: async () => '3.30.9',
  mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
  runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never, lanes: [] }),
  needs: () => ({ status: 'available', items: [] }),
  inbox: async () => ({ sourceState: 'healthy', entries: [] }),
};

const entry = (text: string, priority = 'P0'): InboxEntry => ({
  at: '2026-11-10 14:48', source: 'Slack', priority, text,
});

async function topP0(entries: InboxEntry[]) {
  const result = await gatherStatusDigestInput('/unused', new Date('2026-11-10T20:00:00Z'), {
    ...sources, inbox: async () => ({ sourceState: 'healthy', entries }),
  });
  return result.topP0;
}

describe('status digest top P0 selection', () => {
  it('skips a status request and selects the next order', async () => {
    expect(await topP0([entry(' Phantom status '), entry('ship 3.30.9')]))
      .toEqual({ ok: true, value: { text: 'ship 3.30.9', ageMs: 12 * 60_000 } });
  });

  it('reports none when only status requests and a CLI misfire are P0', async () => {
    expect(await topP0([entry('status'), entry(' --help '), entry('x', 'P1')]))
      .toEqual({ ok: true, value: null });
  });

  it('keeps a longer status-related order', async () => {
    const text = 'status of the release PR #12 and the updater feed, please check both';
    expect(await topP0([entry(text)])).toEqual({ ok: true, value: { text, ageMs: 12 * 60_000 } });
  });
});
