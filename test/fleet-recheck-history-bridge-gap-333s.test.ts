import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheckRecord } from '../src/cli/fleet-recheck-record.js';
import { RECHECK_RECORD_SCHEMA, recheckLogPath, type RecheckMissing, type RecheckRecord } from '../src/core/fleet/recheck-record.js';

const dirs: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recheck-bridge-gap-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AS_OF = '2026-11-13T13:13:00.000Z';
const BASE = `${AS_OF} BLOCKED runtime=VERIFIED claims=VERIFIED bridge=BLOCKED task=VERIFIED`;

function record(opts: { overall?: string; missing?: RecheckMissing | null; missingBridge?: string | null }): RecheckRecord {
  const overall = opts.overall ?? 'BLOCKED';
  return {
    schema: RECHECK_RECORD_SCHEMA, asOf: AS_OF, overall,
    sections: {
      runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: 'fake', asOf: AS_OF },
      claims: { state: 'VERIFIED', active: 0, asOf: AS_OF },
      bridge: { state: overall === 'VERIFIED' ? 'VERIFIED' : 'BLOCKED', missingBridge: opts.missingBridge ?? null, asOf: AS_OF },
      task: { state: 'VERIFIED', id: null, owner: null, claimReceipt: null, asOf: AS_OF },
      missing: opts.missing === undefined ? null : opts.missing,
    },
  };
}

function missing(overall: string[]): RecheckMissing {
  return { overall, runtime: [], claims: [], bridge: overall, task: [] };
}

function writeLog(dir: string, rows: RecheckRecord[]): void {
  mkdirSync(join(dir, 'fleet'), { recursive: true });
  writeFileSync(recheckLogPath(dir), `${rows.map(r => JSON.stringify(r)).join('\n')}\n`);
}

async function run(dir: string, args: string[]) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdFleetRecheckRecord(args, { root: dir });
  const stdout = out.mock.calls.map(call => String(call[0]));
  const stderr = err.mock.calls.map(call => String(call[0]));
  out.mockRestore();
  err.mockRestore();
  return { code, stdout, stderr };
}

describe('recheck history text names the recorded bridge dependency', () => {
  it('prints the retained missingBridge when it is the only missing reason', async () => {
    const dir = root();
    writeLog(dir, [record({ missing: missing(['slack: bridge down']), missingBridge: 'slack: bridge down' })]);
    const result = await run(dir, ['--last', '5']);
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([`${BASE} missing=slack: bridge down`]);
    expect(result.stderr).toEqual([]);
  });

  it('does not duplicate missingBridge when other reasons exist', async () => {
    const dir = root();
    writeLog(dir, [record({
      missing: missing(['slack: bridge down', 'task: no claim receipt for fake-item']),
      missingBridge: 'slack: bridge down',
    })]);
    const result = await run(dir, ['--last', '5']);
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([`${BASE} missing=task: no claim receipt for fake-item`]);
    expect(result.stdout[0]).not.toContain('slack: bridge down');
  });

  it('keeps the bounded "+N more" summary alongside the bridge fallback', async () => {
    const dir = root();
    writeLog(dir, [record({
      missing: missing(['imessage: bridge stale', 'task: reason one', 'task: reason two', 'task: reason three']),
      missingBridge: 'slack: bridge down',
    })]);
    const result = await run(dir, ['--last', '5']);
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([`${BASE} missing=imessage: bridge stale (+3 more)`]);
  });

  it('preserves legacy missing=null rows as missing=unrecorded', async () => {
    const dir = root();
    writeLog(dir, [record({ missing: null, missingBridge: 'slack: bridge down' })]);
    const result = await run(dir, ['--last', '5']);
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([`${BASE} missing=unrecorded`]);
  });

  it('keeps VERIFIED rows on the concise base line', async () => {
    const dir = root();
    const verified = record({ overall: 'VERIFIED', missing: null, missingBridge: null });
    verified.sections.bridge.state = 'VERIFIED';
    writeLog(dir, [verified]);
    const result = await run(dir, ['--last', '5']);
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([`${AS_OF} VERIFIED runtime=VERIFIED claims=VERIFIED bridge=VERIFIED task=VERIFIED`]);
  });

  it('prints one terminal line when a retained value carries control characters', async () => {
    const dir = root();
    const dirty = 'slack:\u0007bridge\r\ndown';
    writeLog(dir, [record({ missing: missing([dirty]), missingBridge: dirty })]);
    const result = await run(dir, ['--last', '5']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    expect(result.stdout[0]).not.toMatch(/\p{Cc}/u);
    expect(result.stdout[0]).toContain('missing=slack: bridge down');
  });

  it('caps a retained dependency at the reason length limit', async () => {
    const dir = root();
    const long = `bridge: ${'x'.repeat(500)}`;
    writeLog(dir, [record({ missing: missing([long]), missingBridge: long })]);
    const result = await run(dir, ['--last', '5']);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const printed = result.stdout[0]!.split('missing=')[1]!;
    expect(printed).toHaveLength(160);
  });

  it('leaves --json output shape and exit status unchanged', async () => {
    const dir = root();
    const rows = [record({ missing: missing(['slack: bridge down']), missingBridge: 'slack: bridge down' })];
    writeLog(dir, rows);
    const result = await run(dir, ['--last', '5', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout[0]!)).toEqual(rows);
  });
});
