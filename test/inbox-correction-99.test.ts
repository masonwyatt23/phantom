import { describe, expect, it } from 'vitest';
import {
  CORRECTION_BARE,
  CORRECTION_TO_ID,
  CORRECTION_WINDOW_MS,
  INBOX_ENTRY_ID,
  linkCorrections,
  type InboxCorrectionInput,
} from '../src/core/fleet/inbox-correction.js';

const MIN = 60_000;
const entry = (over: Partial<InboxCorrectionInput> & { key: string }): InboxCorrectionInput => ({ atMs: 0, text: '', ...over });

describe('linkCorrections', () => {
  it('links an id-form correction to the entry carrying that id', () => {
    const links = linkCorrections([
      entry({ key: 'a', channel: 'desktop', atMs: 1_000, id: 'desk-0123456789abcdef', text: 'Fake first order' }),
      entry({ key: 'b', channel: 'desktop', atMs: 2_000, id: 'desk-fedcba9876543210', text: 'CORRECTION to desk-0123456789abcdef: fake replacement order' }),
    ]);
    expect(links.get('a')).toEqual({ correctedBy: 'b' });
    expect(links.get('b')).toEqual({ corrects: 'a' });
    expect(links.size).toBe(2);
  });

  it('links a bare correction to the nearest earlier same-channel entry inside 30 minutes', () => {
    const links = linkCorrections([
      entry({ key: 'a', channel: 'desktop', atMs: 10 * MIN, text: 'Fake earlier order' }),
      entry({ key: 'b', channel: 'desktop', atMs: 12 * MIN, text: 'CORRECTION to the fake note: use the other lane' }),
    ]);
    expect(links.get('a')).toEqual({ correctedBy: 'b' });
    expect(links.get('b')).toEqual({ corrects: 'a' });
  });

  it('does not link a bare correction whose same-channel predecessor is older than 30 minutes', () => {
    const links = linkCorrections([
      entry({ key: 'a', channel: 'desktop', atMs: 0, text: 'Fake stale order' }),
      entry({ key: 'b', channel: 'desktop', atMs: CORRECTION_WINDOW_MS + 1, text: 'CORRECTION: fake fix' }),
    ]);
    expect(links.size).toBe(0);
  });

  it('does not link a bare correction across channels', () => {
    const links = linkCorrections([
      entry({ key: 'a', channel: 'telegram', atMs: 0, text: 'Fake telegram order' }),
      entry({ key: 'b', channel: 'desktop', atMs: 5 * MIN, text: 'CORRECTION: fake fix' }),
    ]);
    expect(links.size).toBe(0);
  });

  it('does not link a bare correction with no channel', () => {
    const links = linkCorrections([
      entry({ key: 'a', atMs: 0, text: 'Fake heading order' }),
      entry({ key: 'b', atMs: 5 * MIN, text: 'CORRECTION: fake fix' }),
    ]);
    expect(links.size).toBe(0);
  });

  it('chains corrections: a later correction can supersede an earlier correction', () => {
    const links = linkCorrections([
      entry({ key: 'o', channel: 'desktop', atMs: 0, text: 'Fake original order' }),
      entry({ key: 'c1', channel: 'desktop', atMs: 2 * MIN, text: 'CORRECTION: fake fix one' }),
      entry({ key: 'c2', channel: 'desktop', atMs: 4 * MIN, text: 'CORRECTION: fake fix two' }),
    ]);
    expect(links.get('o')).toEqual({ correctedBy: 'c1' });
    expect(links.get('c1')).toEqual({ corrects: 'o', correctedBy: 'c2' });
    expect(links.get('c2')).toEqual({ corrects: 'c1' });
  });

  it('leaves an unknown-id correction unresolved with no marker', () => {
    const links = linkCorrections([
      entry({ key: 'a', channel: 'desktop', atMs: 0, id: 'desk-0123456789abcdef', text: 'Fake order' }),
      entry({ key: 'b', channel: 'desktop', atMs: 60_000, text: 'CORRECTION to desk-aaaaaaaaaaaaaaa1: fake fix' }),
    ]);
    expect(links.size).toBe(0);
  });

  it('does not link a correction that names its own id', () => {
    const links = linkCorrections([
      entry({ key: 'a', channel: 'desktop', atMs: 0, id: 'desk-0123456789abcdef', text: 'CORRECTION to desk-0123456789abcdef: fake self fix' }),
    ]);
    expect(links.size).toBe(0);
  });

  it('does not link entries that merely contain "correction" mid-sentence', () => {
    const links = linkCorrections([
      entry({ key: 'a', channel: 'desktop', atMs: 0, text: 'Fake order' }),
      entry({ key: 'b', channel: 'desktop', atMs: 60_000, text: 'Send a correction to the fake group' }),
      entry({ key: 'c', channel: 'desktop', atMs: 120_000, text: 'correction to the fake note: lowercase does not count' }),
      entry({ key: 'd', channel: 'desktop', atMs: 180_000, text: 'CORRECTIONS desk-0123456789abcdef: plural is not the form' }),
    ]);
    expect(links.size).toBe(0);
  });

  it('keeps the newest correction when two corrections target one entry', () => {
    const links = linkCorrections([
      entry({ key: 'a', channel: 'desktop', atMs: 0, id: 'desk-0123456789abcdef', text: 'Fake order' }),
      entry({ key: 'b', channel: 'desktop', atMs: 60_000, text: 'CORRECTION to desk-0123456789abcdef: fake fix one' }),
      entry({ key: 'c', channel: 'desktop', atMs: 120_000, text: 'CORRECTION to desk-0123456789abcdef: fake fix two' }),
    ]);
    expect(links.get('a')).toEqual({ correctedBy: 'c' });
    expect(links.get('b')).toEqual({ corrects: 'a' });
    expect(links.get('c')).toEqual({ corrects: 'a' });
  });

  it('prefers the id form even when a nearer same-channel entry exists', () => {
    const links = linkCorrections([
      entry({ key: 'a', channel: 'desktop', atMs: 0, id: 'desk-0123456789abcdef', text: 'Fake first order' }),
      entry({ key: 'b', channel: 'desktop', atMs: 60_000, text: 'Fake nearer order' }),
      entry({ key: 'c', channel: 'desktop', atMs: 120_000, text: 'CORRECTION to desk-0123456789abcdef: fake fix' }),
    ]);
    expect(links.get('a')).toEqual({ correctedBy: 'c' });
    expect(links.get('b')).toBeUndefined();
    expect(links.get('c')).toEqual({ corrects: 'a' });
  });
});

describe('exported regexes', () => {
  it('matches the appendInboxEntry id shape', () => {
    expect(INBOX_ENTRY_ID.test('desk-0123456789abcdef')).toBe(true);
    expect(INBOX_ENTRY_ID.test('phone-aaaabbbbccccdddd')).toBe(true);
    expect(INBOX_ENTRY_ID.test('masbot-install')).toBe(false);
    expect(INBOX_ENTRY_ID.test('desk-0123456789abcdefg')).toBe(false);
  });

  it('anchors the two correction forms', () => {
    expect(CORRECTION_TO_ID.exec('CORRECTION to desk-0123456789abcdef: fake')?.[1]).toBe('desk-0123456789abcdef');
    expect(CORRECTION_TO_ID.test('CORRECTION to desk-0123456789abcdef no colon')).toBe(false);
    for (const text of ['CORRECTION: fake', 'CORRECTION to the fake note: x', 'CORRECTION 2: x', 'CORRECTION use the other lane']) {
      expect(CORRECTION_BARE.test(text), text).toBe(true);
    }
    for (const text of ['CORRECTION', 'correction: fake', 'CORRECTIONS: fake', 'note: CORRECTION: fake']) {
      expect(CORRECTION_BARE.test(text), text).toBe(false);
    }
  });
});
