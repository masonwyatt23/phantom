import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetGmailTriage } from '../src/cli/fleet-gmail-triage.js';
import { readGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

let root: string;
let mail: string;
let blocker: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'triage-outcome-'));
  mail = join(root, 'mail');
  blocker = join(root, 'blocker');
  mkdirSync(mail);
  writeFileSync(blocker, 'regular file');
  writeFileSync(join(mail, 'update.eml'), 'From: news@example.test\nTo: me@example.test\nMessage-ID: <news@example.test>\nSubject: Weekly digest\n\nFixture body');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('reports a saved summary that round-trips through the reader', async () => {
  const runs = join(root, 'runs');
  expect(await cmdFleetGmailTriage(['--dir', mail, '--runs-dir', runs, '--json'])).toBe(0);
  const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]![0]));
  expect(output).toMatchObject({ schema: 'fleet.gmail-triage.v1', persistence: 'saved', report: { scanned: 1 }, archivePlan: { unread: 1, target: 100, archiveCandidates: [] } });
  expect(readGmailTriageLatest(runs)).toMatchObject({ scanned: output.report.scanned, updates: output.report.updates.length, unreadInSample: output.archivePlan.unread });
  expect(console.error).not.toHaveBeenCalled();
});

it('preserves computed JSON and reports a failed save separately on stderr', async () => {
  expect(await cmdFleetGmailTriage(['--dir', mail, '--runs-dir', blocker, '--json'])).toBe(1);
  const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]![0]));
  expect(output).toMatchObject({ schema: 'fleet.gmail-triage.v1', persistence: 'failed', report: { scanned: 1 }, archivePlan: { unread: 1, target: 100, archiveCandidates: [] } });
  expect(console.error).toHaveBeenCalledExactlyOnceWith('Could not save the triage summary.');
  expect(vi.mocked(console.log).mock.calls).toHaveLength(1);
});

it('skips the summary writer at an impossible location when requested', async () => {
  expect(await cmdFleetGmailTriage(['--dir', mail, '--runs-dir', blocker, '--json', '--no-save'])).toBe(0);
  const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]![0]));
  expect(output).toMatchObject({ persistence: 'skipped', report: { scanned: 1 }, archivePlan: { unread: 1 } });
  expect(console.error).not.toHaveBeenCalled();
  expect(readFileSync(blocker, 'utf8')).toBe('regular file');
});

it('reports a save failure in human output without losing the report', async () => {
  expect(await cmdFleetGmailTriage(['--dir', mail, '--runs-dir', blocker])).toBe(1);
  expect(console.error).toHaveBeenCalledExactlyOnceWith('Could not save the triage summary.');
  expect(vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n')).toContain('Scanned: 1;');
});
