/** GET /api/verse/comms/owner-thread `receipts`: the API surface the Leader pane
 * reads. Sends go through the real guarded sendOwnerReply; the answer goes
 * through the real parseOwnerThreadRead the desktop uses. Synthetic ids, temp
 * dirs, fake transports.
 *
 * Preservation of ashlrai/phantom PR #5254 (RQ-PHX-RECEIPTAPIPRESERVE204S),
 * observed head c7a01bc14d5701fa847c1bcb0c04ae6f14de6e14 — the named test file
 * is byte-identical at the planner-observed 961e442c24be4a99196e49a4e42b44911d2c8154;
 * the head moved only by master-merge commits. The PR's single file
 * test/leader-delivery-receipts-api-preserve-204s.test.ts was itself preserved
 * from PR #5197 head 080bc4a699a23f9cc04889cef454893bd60f836e
 * (test/leader-delivery-receipts-c186.test.ts); its receipt writer is
 * superseded — receipts live in src/core/leader/delivery-receipts.ts and are
 * attached by the API for outbound ids only.
 *
 * Current-contract qualification (RQ-PHX-RECEIPTAPIOWNERQUALIFY299S): the same
 * two cases re-expressed against current master exports, keeping the source's
 * full assertion set — including the refusal reason surviving
 * parseOwnerThreadRead into ownerThreadLines, which master's
 * leader-delivery-receipts-recut-c206.test.ts does not assert. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOwnerThreadSettings, type OwnerChannelTransport } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH as PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { ownerThreadLines } from '../src/web-ui/routes/verse/leader-thread/owner-thread-lines.js';
import { parseOwnerThreadRead, type OwnerReceipts, type OwnerThreadRead } from '../src/web-ui/routes/verse/leader-thread/owner-thread-queries.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'receipts-api-owner-'));
  roots.push(root);
  const configDir = join(root, 'config');
  mkdirSync(join(configDir, 'comms'), { recursive: true, mode: 0o700 });
  const ids = '[{ channel = "bus", id = "local-owner" }, { channel = "imessage", id = "+15550000000" }]';
  writeFileSync(join(configDir, 'agent-network.toml'), `[mason]\nidentities = ${ids}\n[team]\nidentities = [{ channel = "bus", id = "leader" }, ${ids.slice(1)}\n`);
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n');
  writeFileSync(join(configDir, 'comms', 'owner-adapters.toml'), '[imessage]\nbridge = "loopback"\n');
  const runsDir = join(root, 'runs');
  const options = (transports: OwnerThreadOptions['transports']): OwnerThreadOptions => ({
    runsDir, busRoot: join(root, 'bus'), settings: loadOwnerThreadSettings(configDir), halted: false, paused: false, transports,
  });
  return { configDir, runsDir, options };
}

const sender = (status: 'sent' | 'refused'): OwnerChannelTransport => ({ async pull() { return []; }, async deliver() { return { status, reason: 'fake' }; } });

async function getThread(configDir: string, runsDir: string) {
  const url = PATH;
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url, method: 'GET' }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const api = createOwnerThreadApi({ runsDir, configDir });
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, PATH, 'GET');
  return { handled, status, body: text ? JSON.parse(text) as { schema?: string; receipts?: OwnerReceipts } : null };
}

describe('owner-thread read receipts (owner qualification 299s)', { timeout: 30_000 }, () => {
  it('answers per-channel receipts written by the real send path, parsed by the desktop reader', async () => {
    const { configDir, runsDir, options } = setup();
    const opts = options({ imessage: sender('refused'), desktop: sender('sent') });
    await acceptOwnerInbound({ channel: 'imessage', senderId: '+15550000000', text: 'Synthetic hello', idempotencyKey: 'in-key-own299s01', at: Date.now() }, opts);
    const result = await sendOwnerReply({ text: 'Synthetic answer' }, opts);
    expect(result.status).toBe('partial');
    const reply = readOwnerThread(opts).messages.find(m => m.direction === 'outbound')!;

    const r = await getThread(configDir, runsDir);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body?.schema).toBe('comms.owner-thread.v1');
    const attached = r.body?.receipts?.[reply.id];
    expect(attached).toMatchObject({ desktop: { state: 'delivered' }, imessage: { state: 'failed' } });
    expect(attached?.imessage?.reason).toMatch(/refused/i);
    // Only the outbound id may carry a record: the inbound id gets none.
    expect(Object.keys(r.body?.receipts ?? {})).toEqual([reply.id]);

    const read: OwnerThreadRead = parseOwnerThreadRead(r.body);
    expect(read.receipts?.[reply.id]?.imessage).toMatchObject({ state: 'failed', reason: expect.stringMatching(/refused/i) });
    const receipt = ownerThreadLines(read.lines, [], read.receipts ?? {}).find(l => l.id === `owner-${reply.id}`)?.receipt;
    expect(receipt).toEqual(expect.arrayContaining([
      { channel: 'desktop', state: 'delivered' },
      expect.objectContaining({ channel: 'imessage', state: 'failed', reason: expect.stringMatching(/refused/i) }),
    ]));
  });

  it('omits inbound ids and never invents a record', async () => {
    const { configDir, runsDir, options } = setup();
    const opts = options({ desktop: sender('sent') });
    await acceptOwnerInbound({ channel: 'imessage', senderId: '+15550000000', text: 'Synthetic hello', idempotencyKey: 'in-key-own299s02', at: Date.now() }, opts);
    const inbound = readOwnerThread(opts).messages.find(m => m.direction === 'inbound')!;

    const r = await getThread(configDir, runsDir);
    expect(r.status).toBe(200);
    expect(r.body?.receipts).toEqual({});
    const read: OwnerThreadRead = parseOwnerThreadRead(r.body);
    const line = ownerThreadLines(read.lines, [], read.receipts ?? {}).find(l => l.id === `owner-${inbound.id}`);
    expect(line?.receipt).toBeUndefined();
  });
});
