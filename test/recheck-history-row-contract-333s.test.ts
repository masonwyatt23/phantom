import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';
import { appendRecheckRecord, projectRecheck, readRecheckRecords, recheckLogPath, type RecheckRecord } from '../src/core/fleet/recheck-record.js';

const roots: string[] = [];
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'recheck-contract-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const asOf = '2026-11-13T12:00:00.000Z';
function verdict(): FleetRecheck {
  return { schema: 'fleet.recheck.v1', asOf, overall: { state: 'UNKNOWN', missing: ['unavailable'] }, sections: {
    runtime: { state: 'FUTURE_STATE', source: 'runtime-identity', asOf, host: 'host', tailnetName: 'tailnet', installedVersion: '1', sourceVersion: '1', fleetState: { ageSeconds: 0, stale: false }, missing: [] },
    claims: { state: 'UNKNOWN', source: 'coordination', asOf, active: null, expiredClaims: 0, top: [], missing: [] },
    bridge: { state: 'UNKNOWN', source: 'channel-health', asOf, channels: [], missingBridge: null, missing: [] },
    task: { state: 'UNKNOWN', source: 'work-board', asOf, task: null, unowned: 0, unclaimed: 0, missing: [] },
  } };
}
function writeRows(dir: string, rows: unknown[]): void {
  mkdirSync(join(dir, 'fleet'), { recursive: true });
  writeFileSync(recheckLogPath(dir), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

describe('persisted recheck row contract', () => {
  it('returns only complete current and legacy rows, newest first, and counts every malformed row', () => {
    const current = projectRecheck(verdict());
    const legacy = structuredClone(current) as unknown as { sections: { missing?: unknown } };
    delete legacy.sections.missing;
    const bad: unknown[] = [];
    for (const [section, fields] of Object.entries({ runtime: ['state', 'host', 'installedVersion', 'asOf'], claims: ['state', 'active', 'asOf'], bridge: ['state', 'missingBridge', 'asOf'], task: ['state', 'id', 'owner', 'claimReceipt', 'asOf'] })) {
      for (const field of fields) {
        const row = structuredClone(current) as unknown as { sections: Record<string, Record<string, unknown>> };
        delete row.sections[section]![field];
        bad.push(row);
      }
    }
    for (const active of [-1, 1.5, '1', {}]) {
      const row = structuredClone(current) as unknown as { sections: { claims: { active: unknown } } };
      row.sections.claims.active = active;
      bad.push(row);
    }
    for (const key of ['overall', 'runtime', 'claims', 'bridge', 'task'] as const) {
      const row = structuredClone(current);
      row.sections.missing![key] = ['valid', 1 as unknown as string];
      bad.push(row);
    }
    const dir = root();
    writeRows(dir, [legacy, ...bad, current]);
    const result = readRecheckRecords(dir, 100);
    expect(result).toEqual({ rows: [current, { ...legacy, sections: { ...legacy.sections, missing: null } }], skipped: bad.length, missing: false, outcome: 'ok' });
    writeRows(dir, bad);
    expect(readRecheckRecords(dir, 100)).toEqual({ rows: [], skipped: bad.length, missing: false, outcome: 'ok' });
  });

  it('round trips appended projected evidence and accepts nullable and numeric fields', () => {
    const dir = root();
    const input = verdict();
    const expected: RecheckRecord = projectRecheck(input);
    expect(appendRecheckRecord(dir, input, '/fake-home')).toEqual({ ok: true, record: expected });
    expect(readRecheckRecords(dir, 5)).toEqual({ rows: [expected], skipped: 0, missing: false, outcome: 'ok' });
    const numeric = structuredClone(expected);
    numeric.sections.claims.active = 3;
    numeric.sections.bridge.missingBridge = 'reason';
    numeric.sections.task = { state: 'NEW_STATE', id: 'task', owner: 'owner', claimReceipt: 'receipt', asOf };
    writeRows(dir, [expected, numeric]);
    expect(readRecheckRecords(dir, 5)).toEqual({ rows: [numeric, expected], skipped: 0, missing: false, outcome: 'ok' });
  });
});
