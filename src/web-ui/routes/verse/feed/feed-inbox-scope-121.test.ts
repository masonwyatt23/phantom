import { describe, expect, it } from 'vitest';
import { buildFeed, inboxOverAdapter } from './feed-model.js';

const SCHEMA = 'fleet.gmail-archive-plan-latest.v1';
const AT = '2026-11-09T10:00:00.000Z';
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const plan = (inbox: string, unread: number, target = 100, at = AT) =>
  ({ inbox, at, unread, target, archiveCount: Math.max(0, unread - target), topSenders: [{ sender: 'news@example.test', count: 40 }] });
const payload = (evidence: unknown, ...plans: unknown[]) =>
  ({ schema: SCHEMA, latest: { schema: SCHEMA, plans }, ...(evidence === undefined ? {} : { evidence }) });
const SAMPLE = { scope: 'saved-local-export-sample', liveInboxTargetState: 'unknown', archiveExecution: 'unverified' };

describe('inboxOverAdapter evidence scope', () => {
  it('says the count is from the saved export when the scope is saved-local-export-sample', () => {
    const [item] = inboxOverAdapter(payload(SAMPLE, plan('work@example.test', 130)), NOW);
    expect(item!.title).toBe('work@example.test: 130 unread in the saved export, target 100');
    expect(item!.title).toContain('unread in the saved export');
    expect(item!.body).toBe('The archive plan would archive 30. Top senders: news@example.test (40) Live inbox not checked by Phantom; nothing has been archived.');
    expect(item!.body).toContain('Live inbox not checked');
  });

  it('keeps the old title and flags the count source as unknown when evidence is missing', () => {
    const [item] = inboxOverAdapter(payload(undefined, plan('work@example.test', 130)), NOW);
    expect(item!.title).toBe('work@example.test: 130 unread, target 100');
    expect(item!.body?.startsWith('Count source unknown.')).toBe(true);
    expect(item!.body).toContain('Live inbox not checked by Phantom; nothing has been archived.');
  });

  it('treats any other scope, even "live", as unknown', () => {
    for (const evidence of [{ scope: 'live' }, { scope: 'unknown' }, 'junk']) {
      const [item] = inboxOverAdapter(payload(evidence, plan('work@example.test', 130)), NOW);
      expect(item!.title).toBe('work@example.test: 130 unread, target 100');
      expect(item!.body?.startsWith('Count source unknown.')).toBe(true);
    }
  });

  it('keeps the stale suffix on the saved-export title', () => {
    const [item] = inboxOverAdapter(payload(SAMPLE, plan('work@example.test', 130)), Date.parse(AT) + 25 * 3_600_000);
    expect(item!.title).toBe('work@example.test: 130 unread in the saved export, target 100 (plan is stale)');
  });
});

describe('buildFeed with scoped inbox plans', () => {
  it('routes the item to the fleet-inbox pane', () => {
    const items = buildFeed({ inboxPlans: payload(SAMPLE, plan('work@example.test', 130)) });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(`inbox-over:work@example.test:${AT}`);
    expect(items[0]!.pane).toBe('fleet-inbox');
  });
});
