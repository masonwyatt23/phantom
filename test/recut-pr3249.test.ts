/**
 * Recut of #3249: the `phantom_fleet_needs_wait` native MCP tool.
 *
 * Drives the tool through the two real entry points master wires it into:
 * `callNativeTool` (the gateway's tools/call path, with its argument gate,
 * kill-switch gate and audit) and `buildNativeToolSpecsWithFn` (the agent
 * loop's executable spec). Hermetic: an isolated HOME from h1-fixture and a
 * temporary ASHLR_RUNS_DIR holding a fake NEEDS-MASON.md ledger.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { contractedNativeToolNames } from './helpers/native-tool-contract.js';
import { callNativeTool, isNativeTool, nativeToolSafety } from '../src/core/mcp-native.js';
import { buildNativeToolSpecsWithFn } from '../src/core/mcp-native-engineer.js';

const TOOL = 'phantom_fleet_needs_wait';
const ITEM = 'Approve the fake recut deploy';
const ITEM_ID = `nm-${createHash('sha256').update(ITEM).digest('hex').slice(0, 12)}`;

let fx: H1Fixture;
let runs: string;
let previousRuns: string | undefined;

beforeEach(() => {
  fx = makeFixture();
  runs = mkdtempSync(join(tmpdir(), 'recut-pr3249-'));
  previousRuns = process.env.ASHLR_RUNS_DIR;
  process.env.ASHLR_RUNS_DIR = runs;
});

afterEach(() => {
  if (previousRuns === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previousRuns;
  rmSync(runs, { recursive: true, force: true });
  fx.cleanup();
});

const ledger = (body: string): void => writeFileSync(join(runs, 'NEEDS-MASON.md'), body);
const parse = (text: string): unknown => JSON.parse(text);

describe('recut #3249: phantom_fleet_needs_wait through the gateway dispatch', () => {
  it('is a contracted, read-only native tool', () => {
    expect(isNativeTool(TOOL)).toBe(true);
    expect(nativeToolSafety(TOOL)).toBe('read');
    expect(contractedNativeToolNames).toContain(TOOL);
  });

  it('returns resolved once the owner marks the open item resolved mid-wait', async () => {
    ledger(`- [ ] ${ITEM}\n`);
    const pending = callNativeTool(TOOL, { itemId: ITEM_ID, timeoutMs: 5000, pollMs: 100 });
    setTimeout(() => ledger(`- [x] resolved ${ITEM_ID} 2026-11-10T00:00:00Z\n`), 150);
    const response = await pending;
    expect(response.isError).toBeUndefined();
    expect(parse(response.content[0]!.text)).toEqual({ itemId: ITEM_ID, status: 'resolved' });
  });

  it('stays callable with the kill switch engaged because it only reads', async () => {
    fx.setKill(true);
    ledger(`- [x] resolved ${ITEM_ID} done\n`);
    const response = await callNativeTool(TOOL, { itemId: ITEM_ID, timeoutMs: 50 });
    expect(response.isError).toBeUndefined();
    expect(parse(response.content[0]!.text)).toEqual({ itemId: ITEM_ID, status: 'resolved' });
  });

  it('honours the bounded deadline for an item that stays open', async () => {
    ledger(`- [ ] ${ITEM}\n`);
    const started = Date.now();
    const response = await callNativeTool(TOOL, { itemId: ITEM_ID, timeoutMs: 200, pollMs: 100 });
    expect(parse(response.content[0]!.text)).toEqual({ itemId: ITEM_ID, status: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses unknown keys such as a caller-chosen runs directory', async () => {
    const response = await callNativeTool(TOOL, { itemId: ITEM_ID, timeoutMs: 10, runsDir: '/tmp' });
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain('invalid fleet needs wait arguments');
  });
});

describe('recut #3249: phantom_fleet_needs_wait through the agent-loop spec', () => {
  it('executes in-process with read safety and reports unknown ids honestly', async () => {
    const spec = buildNativeToolSpecsWithFn().find(tool => tool.name === TOOL);
    expect(spec?.safety).toBe('read');
    expect(spec?.function.parameters).toMatchObject({ required: ['itemId', 'timeoutMs'], additionalProperties: false });
    ledger(`- [ ] ${ITEM}\n`);
    expect(parse(await spec!.fn({ itemId: 'nm-000000000000', timeoutMs: 50 })))
      .toEqual({ itemId: 'nm-000000000000', status: 'unknown' });
  });
});
