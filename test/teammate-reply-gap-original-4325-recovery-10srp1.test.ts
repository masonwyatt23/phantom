import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { teammateReplyGapFromInbox } from '../src/core/comms/teammate-reply-gap.js';

const now = Date.UTC(2026, 10, 9, 12);
const dirs: string[] = [];
function inbox(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'reply-gap-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'imessage'));
  return { dir, path: join(dir, 'imessage', 'teammates.jsonl') };
}
const row = (rowid: number, senderId: string, minutes: number) => JSON.stringify({
  v: 1, rowid, senderId, at: new Date(now - minutes * 60_000).toISOString(), text: 'synthetic private text',
});
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('recovered inbox reply gap', () => {
  it('tracks individual answers and independent teammates without writes or private data', () => {
    const { dir, path } = inbox();
    writeFileSync(path, [row(1, 'fake-id-a', 8), row(2, 'fake-id-a', 2), row(3, 'fake-id-b', 5)].join('\n') + '\n');
    const original = readFileSync(path, 'utf8');
    const initial = teammateReplyGapFromInbox(now, dir);
    expect(initial).toMatchObject([
      { teammate: 'Teammate 1', unansweredCount: 2, oldestUnansweredMs: 480_000, state: 'late' },
      { teammate: 'Teammate 2', unansweredCount: 1, oldestUnansweredMs: 300_000, state: 'late' },
    ]);
    expect(teammateReplyGapFromInbox(now - 60_000, dir)[1]).toMatchObject({ state: 'ok', oldestUnansweredMs: 240_000 });
    expect(readFileSync(path, 'utf8')).toBe(original);
    appendFileSync(path, JSON.stringify({ v: 1, answered: 2, at: new Date(now).toISOString() }) + '\n');
    expect(teammateReplyGapFromInbox(now, dir)[0]).toMatchObject({ unansweredCount: 1, oldestUnansweredMs: 480_000, state: 'late' });
    appendFileSync(path, JSON.stringify({ v: 1, answered: 1, at: new Date(now).toISOString() }) + '\n');
    const beforeRead = readFileSync(path, 'utf8');
    const result = teammateReplyGapFromInbox(now, dir, { 'fake-id-a': 'private label' });
    expect(result).toMatchObject([{ unansweredCount: 0, state: 'ok' }, { unansweredCount: 1, state: 'late' }]);
    expect(JSON.stringify(result)).not.toMatch(/fake-id|synthetic private text|private label|rowid/);
    expect(readFileSync(path, 'utf8')).toBe(beforeRead);
  });

  it('reports missing and malformed evidence as unknown, including malformed objects', () => {
    const { dir, path } = inbox();
    expect(teammateReplyGapFromInbox(now, dir)[0]?.state).toBe('unknown');
    writeFileSync(path, `${row(1, 'fake-id-a', 1)}\n{bad json\n`);
    expect(teammateReplyGapFromInbox(now, dir)[0]?.state).toBe('unknown');
    writeFileSync(path, '{"rowid":1}\n');
    expect(teammateReplyGapFromInbox(now, dir)[0]?.state).toBe('unknown');
  });
});
