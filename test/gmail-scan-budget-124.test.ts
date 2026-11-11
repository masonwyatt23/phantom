import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { opened } = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    opened.push(String(args[0]));
    return fs.openSync(...args);
  } };
});
import { readEmlInboxDetailed } from '../src/core/comms/gmail-eml-adapter.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); opened.length = 0; });
function setup(contents: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-budget-')); dirs.push(dir);
  contents.forEach((content, i) => {
    const path = join(dir, `${i}.eml`);
    writeFileSync(path, content); utimesSync(path, 100 - i, 100 - i);
  });
  opened.length = 0;
  return dir;
}
const message = (id: string) => `From: sender@example.test\nMessage-ID: <${id}@example.test>\nSubject: Hello\n\nBody`;

describe('saved Gmail examination budget', () => {
  it('counts duplicates against the cap and does not open an older message', () => {
    const dir = setup([message('same'), message('same'), message('older')]);
    const result = readEmlInboxDetailed(dir, { limit: 2 });
    expect(result.messages.map(m => m.id)).toEqual(['same@example.test']);
    expect(result.scope).toEqual({ limit: 2, files: 3, truncated: true });
    expect(opened).toEqual([join(dir, '0.eml'), join(dir, '1.eml')]);
  });
  it('counts malformed files against the cap without backfilling', () => {
    const dir = setup(['Subject: missing sender\n\nBody', message('new'), message('older')]);
    const result = readEmlInboxDetailed(dir, { limit: 2 });
    expect(result.messages.map(m => m.id)).toEqual(['new@example.test']);
    expect(result.scope.truncated).toBe(true);
    expect(opened).toEqual([join(dir, '0.eml'), join(dir, '1.eml')]);
  });
  it('reports exhaustion accurately with fewer unique messages', () => {
    const dir = setup([message('same'), message('same')]);
    const result = readEmlInboxDetailed(dir, { limit: 2 });
    expect(result.messages).toHaveLength(1);
    expect(result.scope).toEqual({ limit: 2, files: 2, truncated: false });
    expect(opened).toHaveLength(2);
  });
  it('retains newest-first results for valid exports', () => {
    const dir = setup([message('new'), message('middle'), message('old')]);
    const result = readEmlInboxDetailed(dir, { limit: 2 });
    expect(result.messages.map(m => m.id)).toEqual(['new@example.test', 'middle@example.test']);
    expect(result.scope).toEqual({ limit: 2, files: 3, truncated: true });
  });
});
