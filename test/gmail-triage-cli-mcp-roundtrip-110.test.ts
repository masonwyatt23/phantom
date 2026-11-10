import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetGmailTriage } from '../src/cli/fleet-gmail-triage.js';
import { readFleetGmailTriageLatest } from '../src/mcp/fleet-gmail-triage-latest.js';

it('projects the latest completed CLI sample without exposing mail content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gmail-roundtrip-'));
  const runs = join(root, 'runs');
  const inbox = join(root, 'synthetic-inbox');
  mkdirSync(inbox);
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(readFleetGmailTriageLatest(runs)).toEqual({
      schema: 'fleet.mcp.gmail-triage-latest.v1', state: 'missing', latest: null,
      overTarget: null, ageSeconds: null,
    });

    function populate(count: number): void {
      rmSync(inbox, { recursive: true });
      mkdirSync(inbox);
      for (let i = 0; i < count; i++) {
        writeFileSync(join(inbox, `sample-${i}.eml`),
          `From: newsletter@example.test\nSubject: Private subject ${i}\nMessage-ID: <private-id-${i}@example.test>\n\nPrivate body ${i}\n`);
      }
    }
    async function run(noSave = false) {
      log.mockClear();
      expect(await cmdFleetGmailTriage(['--dir', inbox, '--runs-dir', runs, '--json', ...(noSave ? ['--no-save'] : [])])).toBe(0);
      expect(error).not.toHaveBeenCalled();
      return JSON.parse(String(log.mock.calls[0]![0])) as {
        report: { scanned: number; updates: string[]; drafted: number; review: number; failed: number };
        archivePlan: { unread: number; target: number; archiveCandidates: string[] };
      };
    }
    function check(cli: Awaited<ReturnType<typeof run>>, now: string, expectedAge: number) {
      const result = readFleetGmailTriageLatest(runs, () => new Date(now));
      expect(result.state).toBe('present');
      expect(result.latest).toMatchObject({
        dir: 'synthetic-inbox', scanned: cli.report.scanned, updates: cli.report.updates.length,
        drafted: cli.report.drafted, review: cli.report.review, failed: cli.report.failed,
        unreadInSample: cli.archivePlan.unread, target: cli.archivePlan.target,
        archiveCandidateCount: cli.archivePlan.archiveCandidates.length,
      });
      expect(result.overTarget).toBe(cli.archivePlan.unread > cli.archivePlan.target);
      expect(result.ageSeconds).toBe(expectedAge);
      const projection = JSON.stringify(result);
      for (const privateValue of ['Private subject', 'Private body', 'private-id-', 'example.test', inbox, root]) {
        expect(projection).not.toContain(privateValue);
      }
      return result;
    }

    populate(100);
    vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
    const firstCli = await run();
    expect(firstCli.report.scanned).toBe(100);
    const first = check(firstCli, '2026-11-10T12:00:45.000Z', 45);
    expect(first.latest?.at).toBe('2026-11-10T12:00:00.000Z');

    populate(2);
    vi.setSystemTime(new Date('2026-11-10T12:05:00.000Z'));
    const secondCli = await run();
    expect(secondCli.report.scanned).toBe(2);
    const second = check(secondCli, '2026-11-10T12:05:12.900Z', 12);
    expect(second.latest?.at).toBe('2026-11-10T12:05:00.000Z');
    expect(second.latest).not.toEqual(first.latest);

    populate(3);
    vi.setSystemTime(new Date('2026-11-10T12:10:00.000Z'));
    expect((await run(true)).report.scanned).toBe(3);
    expect(readFleetGmailTriageLatest(runs, () => new Date('2026-11-10T12:05:12.900Z'))).toEqual(second);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
