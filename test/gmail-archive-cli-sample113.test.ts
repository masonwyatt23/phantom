import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetGmailArchivePlan } from '../src/cli/fleet-gmail-archive-plan.js';

it('plans only from the newest 100 exported messages without changing the export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-sample-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    for (let i = 0; i < 120; i++) {
      const path = join(dir, `message-${String(i).padStart(3, '0')}.eml`);
      const review = i % 3 === 0;
      writeFileSync(path, `From: ${review ? 'person' : 'noreply'}@example.test\nTo: owner@example.test\nMessage-ID: <m${i}@example.test>\nSubject: ${review ? 'Please review this?' : 'Update'}\n\nSynthetic message ${i}.\n`);
      const time = new Date(Date.UTC(2024, 0, 1, 0, i));
      utimesSync(path, time, time);
    }
    const snapshot = () => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name)).toString('base64')]);
    const before = snapshot();
    const args = ['--dir', dir, '--inbox', 'synthetic', '--no-save'];
    expect(await cmdFleetGmailArchivePlan([...args, '--target', '90', '--json'])).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)![0])) as {
      schema: string; archivePlan: { unread: number; target: number; archiveCandidates: string[] };
    };
    expect(result.schema).toBe('fleet.gmail-archive-plan.v1');
    expect(result.archivePlan.unread).toBe(100);
    expect(result.archivePlan.target).toBe(90);
    const expected = Array.from({ length: 100 }, (_, i) => i + 20)
      .filter(i => i % 3 !== 0).slice(0, 10).map(i => `m${i}@example.test`);
    expect(result.archivePlan.archiveCandidates).toEqual(expected);

    expect(await cmdFleetGmailArchivePlan([...args, '--json'])).toBe(0);
    const defaultResult = JSON.parse(String(log.mock.calls.at(-1)![0])) as typeof result;
    expect(defaultResult.archivePlan).toEqual({ unread: 100, target: 100, archiveCandidates: [] });
    log.mockClear();
    expect(await cmdFleetGmailArchivePlan([...args, '--target', '90'])).toBe(0);
    expect(String(log.mock.calls[0]![0])).toContain('10 of 100 messages in the unread sample');
    expect(snapshot()).toEqual(before);
  } finally {
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
