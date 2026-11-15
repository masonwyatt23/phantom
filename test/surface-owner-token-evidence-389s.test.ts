import { describe, expect, it } from 'vitest';
import { readSurfaceOwner, type SurfaceOwnerDeps } from '../src/core/fleet/surface-owner.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const PATH = 'src/core/agents/slack-status.ts';
const claim = (task: string, agent = 'fake-agent', repo = 'ashlrai/phantom', expiresAt = NOW + 60_000) =>
  ({ id: `claim-${agent}`, repo, task, agent, claimedAt: NOW - 1000, expiresAt });
type Claim = ReturnType<typeof claim>;
const report = (claims: Claim[]) => {
  const deps: SurfaceOwnerDeps = {
    now: () => NOW,
    board: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims, messages: [], proposals: [], expiredClaims: 0 }),
    log: async path => path === PATH
      ? [{ sha: 'abc1234', date: '2026-11-13T12:00:00Z', subject: 'bridge(RQ-FAKE1): work (#42)', filesChanged: 1 }]
      : [],
  };
  return readSurfaceOwner('slack-bridge', deps);
};

describe('surface owner lexical evidence', () => {
  it.each(['"slack-bridge"', '`slack-bridge`', '(slack-bridge)', `edit ${PATH}.`, `edit [${PATH}], please`])
  ('accepts a complete reference in prose: %s', async task => {
    expect(await report([claim(task)])).toMatchObject({ owner: 'fake-agent', ownerSource: 'advisory-claim', authority: 'none' });
  });

  it.each([
    'not-slack-bridge', 'slack-bridge-old', 'prefixslack-bridge', 'slack-bridge_extra',
    `${PATH}.backup`, `${PATH}/extra`, `other/${PATH}`, `prefix${PATH}`, `${PATH}x`,
  ])('rejects a fragment: %s', async task => {
    expect(await report([claim(task)])).toMatchObject({ owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [] });
  });

  it('selects only the exact claim when another agent names a misleading fragment', async () => {
    const result = await report([claim('not-slack-bridge', 'misleading'), claim(`work on ${PATH}.`, 'actual')]);
    expect(result).toMatchObject({ owner: 'actual', ownerSource: 'advisory-claim', liveClaims: [{ agent: 'actual' }] });
  });

  it('keeps expired and foreign claims out while retaining landed history', async () => {
    const result = await report([
      claim('slack-bridge', 'expired', 'ashlrai/phantom', NOW),
      claim('slack-bridge', 'foreign', 'ashlrai/lexicon'),
    ]);
    expect(result).toMatchObject({ authority: 'none', owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [],
      lastLanded: { jobId: 'RQ-FAKE1', pr: 42, path: PATH } });
    expect(result!.reasons).toContain('1 live claim(s) naming this surface belong to other repositories and were ignored');
  });

  it('keeps multiple exact claims ambiguous', async () => {
    expect(await report([claim('slack-bridge', 'one'), claim(`edit ${PATH}`, 'two')]))
      .toMatchObject({ owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [{ agent: 'one' }, { agent: 'two' }] });
  });
});
