import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGmailArchivePlan } from '../src/cli/fleet-gmail-archive-plan.js';
import { readGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';

let root: string;
let inbox: string;
let impossible: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gmail-plan-outcome-'));
  inbox = join(root, 'inbox');
  mkdirSync(inbox);
  writeFileSync(join(inbox, 'message.eml'), 'From: newsletter@example.test\nMessage-ID: <one@example.test>\nSubject: Fixture\n\nFixture body');
  impossible = join(root, 'file');
  writeFileSync(impossible, 'unchanged');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

async function run(runsDir: string, extra: string[] = []) {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await cmdFleetGmailArchivePlan(['--dir', inbox, '--inbox', 'fixture', '--target', '0', '--runs-dir', runsDir, ...extra]);
    return { code, stdout: stdout.mock.calls.map(call => String(call[0])).join('\n'), stderr: stderr.mock.calls.map(call => String(call[0])).join('\n') };
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
}

describe('Gmail archive plan persistence outcome', () => {
  it('saves the computed report for the existing reader', async () => {
    const runsDir = join(root, 'runs');
    const result = await run(runsDir, ['--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schema: 'fleet.gmail-archive-plan.v1', persistence: 'saved', archivePlan: { unread: 1, target: 0, archiveCandidates: ['one@example.test'] }, topSenders: [{ sender: 'newsletter@example.test', count: 1 }] });
    expect(readGmailArchivePlanLatest(runsDir)?.plans[0]).toMatchObject({ inbox: 'fixture', unread: 1, target: 0, archiveCount: 1, topSenders: report.topSenders });
  });

  it('returns failure while preserving JSON and computed data when saving fails', async () => {
    const result = await run(impossible, ['--json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Could not save the archive plan.');
    expect(JSON.parse(result.stdout)).toMatchObject({ schema: 'fleet.gmail-archive-plan.v1', persistence: 'failed', archivePlan: { unread: 1, target: 0, archiveCandidates: ['one@example.test'] }, topSenders: [{ sender: 'newsletter@example.test', count: 1 }] });
    expect(readFileSync(impossible, 'utf8')).toBe('unchanged');
  });

  it('skips the impossible writer when no save is requested', async () => {
    const result = await run(impossible, ['--json', '--no-save']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ persistence: 'skipped', archivePlan: { unread: 1, target: 0, archiveCandidates: ['one@example.test'] } });
    expect(readFileSync(impossible, 'utf8')).toBe('unchanged');
  });

  it('reports a save failure alongside the human-readable plan', async () => {
    const result = await run(impossible);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Could not save the archive plan.');
    expect(result.stdout).toContain('Would archive 1 of 1 unread (target 0).');
  });
});
