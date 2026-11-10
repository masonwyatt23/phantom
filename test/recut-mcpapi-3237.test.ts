/**
 * Recut of #3237: phantom_fleet_needs_resolve through the real MCP call path.
 * The tool records an answer Mason already gave (same writer as
 * `ashlr fleet needs-resolve`), so every case asserts on the durable bus, the
 * NEEDS-MASON.md marker and the planner inbox, never on a mocked relay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callNativeTool, listNativeTools, nativeToolSafety } from '../src/core/mcp-native.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { NEEDS_MASON_REPLY_MAX } from '../src/core/fleet/needs-mason-resolve.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));

const NEEDS = 'phantom_fleet_needs';
const RESOLVE = 'phantom_fleet_needs_resolve';
let home = '';
let runs = '';
let busRoot = '';

const needsPath = () => join(runs, 'NEEDS-MASON.md');
const inboxPath = () => join(runs, 'leader', 'MASON-INBOX.md');
const busBodies = (): Record<string, unknown>[] => {
  const page = listBusInboxAfter(0, 100, { root: busRoot });
  return page.status === 'ok' ? page.messages.map(message => message.envelope.body as Record<string, unknown>) : [];
};
const call = async (name: string, args: unknown) => {
  const result = await callNativeTool(name, args);
  return { result, text: result.content[0]!.text };
};
const listedItems = async (): Promise<{ id: string; text: string }[]> =>
  (JSON.parse((await call(NEEDS, {})).text) as { items: { id: string; text: string }[] }).items;
const nothingWritten = () => {
  expect(busBodies()).toEqual([]);
  expect(existsSync(inboxPath())).toBe(false);
  expect(readFileSync(needsPath(), 'utf8')).not.toContain('resolved nm-');
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'needs-resolve-mcp-'));
  runs = join(home, 'runs-env');
  busRoot = join(home, 'ashlr-home', 'fleet');
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, 'ashlr-home'));
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  mkdirSync(runs, { recursive: true });
  writeFileSync(needsPath(), '# Needs Mason\n- [ ] Approve the fake deploy\n- Pick a fake vendor\n- [x] already done\n');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('registration', () => {
  it('advertises an append tool with a closed schema matching the ledger limits', () => {
    expect(nativeToolSafety(RESOLVE)).toBe('append');
    const tool = listNativeTools().find(entry => entry.name === RESOLVE);
    expect(tool).toMatchObject({
      inputSchema: {
        type: 'object', required: ['itemId'], additionalProperties: false,
        properties: { itemId: { type: 'string', pattern: '^nm-[0-9a-f]{12}$' }, reply: { type: 'string', maxLength: NEEDS_MASON_REPLY_MAX } },
      },
    });
    // It records an answer Mason gave; it never licenses the agent to invent one.
    expect(tool!.description).toMatch(/Mason already gave/);
    expect(tool!.description).toMatch(/Never permission to invent/);
  });
});

describe('phantom_fleet_needs_resolve', () => {
  it('resolves a listed item: bus event with source mcp, marker, and planner inbox entry', async () => {
    const [item] = await listedItems();
    const { result, text } = await call(RESOLVE, { itemId: item!.id, reply: 'Ship the fake deploy Friday' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toEqual({ v: 1, status: 'resolved', itemId: item!.id, duplicate: false, inbox: 'appended' });
    expect(busBodies()).toEqual([expect.objectContaining({
      kind: 'needs_mason.resolved', itemId: item!.id, source: 'mcp',
      item: 'Approve the fake deploy', reply: 'Ship the fake deploy Friday',
    })]);
    expect(readFileSync(needsPath(), 'utf8')).toContain(`- [x] resolved ${item!.id}`);
    expect((await listedItems()).map(entry => entry.text)).toEqual(['Pick a fake vendor']);
    const inbox = parseInbox(readFileSync(inboxPath(), 'utf8'));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ channel: 'mcp' });
    expect(inbox[0]!.text).toBe(`Re needs-you ${item!.id} ("Approve the fake deploy"): Ship the fake deploy Friday`);
  });

  it('skips the planner inbox when no reply is given', async () => {
    const [item] = await listedItems();
    const { result, text } = await call(RESOLVE, { itemId: item!.id });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({ status: 'resolved', inbox: 'skipped' });
    expect(existsSync(inboxPath())).toBe(false);
    expect(busBodies()).toHaveLength(1);
    expect(busBodies()[0]).not.toHaveProperty('reply');
  });

  it('refuses a second resolution with the CLI code and writes nothing more', async () => {
    const [item] = await listedItems();
    await call(RESOLVE, { itemId: item!.id, reply: 'first answer' });
    const { result, text } = await call(RESOLVE, { itemId: item!.id, reply: 'second answer' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ status: 'already-resolved', itemId: item!.id, inbox: 'skipped' });
    expect(busBodies()).toHaveLength(1);
    expect(parseInbox(readFileSync(inboxPath(), 'utf8'))).toHaveLength(1);
  });

  it('refuses an unknown id and writes nothing', async () => {
    const { result, text } = await call(RESOLVE, { itemId: 'nm-000000000000', reply: 'fake answer' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ status: 'unknown', itemId: 'nm-000000000000', inbox: 'skipped' });
    nothingWritten();
  });

  it.each([
    { itemId: 'nm-000000000000', reply: 'x', extra: 1 },
    { itemId: 'nm-000000000000', reply: 'x', runsDir: '/tmp/fake' },
    { reply: 'x' },
    { itemId: 'bogus' },
    { itemId: 'NM-000000000000' },
    { itemId: 'nm-000000000000', reply: 42 },
    { itemId: 'nm-000000000000', reply: 'x'.repeat(NEEDS_MASON_REPLY_MAX + 1) },
    null, [], 'nm-000000000000',
  ])('rejects %j before any write', async args => {
    const { result, text } = await call(RESOLVE, args);
    expect(result.isError).toBe(true);
    expect(text).toContain('invalid needs resolve arguments');
    nothingWritten();
  });

  it('never reads a client-supplied runs dir', async () => {
    const foreign = mkdtempSync(join(tmpdir(), 'needs-resolve-foreign-'));
    try {
      writeFileSync(join(foreign, 'NEEDS-MASON.md'), '- [ ] Foreign fake item\n');
      const [item] = await listedItems();
      const { result } = await call(RESOLVE, { itemId: item!.id, runsDir: foreign });
      expect(result.isError).toBe(true);
      expect(readFileSync(join(foreign, 'NEEDS-MASON.md'), 'utf8')).not.toContain('resolved');
      nothingWritten();
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('accepts a reply at the ledger limit', async () => {
    const [item] = await listedItems();
    const { result } = await call(RESOLVE, { itemId: item!.id, reply: 'x'.repeat(NEEDS_MASON_REPLY_MAX) });
    expect(result.isError).toBeFalsy();
    expect(busBodies()).toHaveLength(1);
  });

  it('reports a failed planner relay honestly while the resolution still lands', async () => {
    // `leader` is a file, so MASON-INBOX.md cannot be created under it.
    writeFileSync(join(runs, 'leader'), 'not a directory');
    const [item] = await listedItems();
    const { result, text } = await call(RESOLVE, { itemId: item!.id, reply: 'fake explicit answer' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text)).toMatchObject({ status: 'resolved', itemId: item!.id, inbox: 'failed' });
    expect(busBodies()).toHaveLength(1);
    expect(readFileSync(needsPath(), 'utf8')).toContain(`- [x] resolved ${item!.id}`);
  });

  it('is refused under the kill switch like every append tool', async () => {
    mkdirSync(join(home, '.ashlr'), { recursive: true });
    writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch active\n');
    const [item] = await listedItems();
    const { result, text } = await call(RESOLVE, { itemId: item!.id, reply: 'fake answer' });
    expect(result.isError).toBe(true);
    expect(text).toContain('kill switch');
    nothingWritten();
  });
});
