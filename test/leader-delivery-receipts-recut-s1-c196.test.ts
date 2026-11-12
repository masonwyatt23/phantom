/** Recut coverage for PR #5197 (RQ-PHX-RECUTDESKS0C186): per-channel delivery
 * receipts on outgoing Leader messages. Goes through the real route — the
 * guarded sendOwnerReply writes receipts, GET /api/verse/comms/owner-thread
 * answers them, and the desktop's own parseOwnerThreadRead/ownerThreadLines
 * renders the result. Synthetic ids, temp dirs, fake transports. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOwnerThreadSettings, type OwnerChannelTransport } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, readOwnerThread, readReceipts, recordDelivery, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH as PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { ownerThreadLines } from '../src/web-ui/routes/verse/leader-thread/owner-thread-lines.js';
import { parseOwnerThreadRead } from '../src/web-ui/routes/verse/leader-thread/owner-thread-queries.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'receipts-recut-c196-'));
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
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url: PATH, method: 'GET' }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const api = createOwnerThreadApi({ runsDir, configDir });
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, PATH, 'GET');
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('owner-thread delivery receipts (recut s1-c196)', () => {
  it('a retried reply heals the failed channel receipt through the real API', async () => {
    const { configDir, runsDir, options } = setup();
    await acceptOwnerInbound({ channel: 'imessage', senderId: '+15550000000', text: 'Synthetic hello', idempotencyKey: 'in-key-c19601', at: Date.now() }, options({}));

    const first = await sendOwnerReply({ text: 'Synthetic answer' }, options({ imessage: sender('refused'), desktop: sender('sent') }));
    expect(first.status).toBe('partial');
    const reply = readOwnerThread(options({})).messages.find(m => m.direction === 'outbound')!;

    let r = await getThread(configDir, runsDir);
    expect(r.status).toBe(200);
    expect(r.body.receipts[reply.id]).toMatchObject({ desktop: { state: 'delivered' }, imessage: { state: 'failed' } });

    // Same reply text to the same inbound derives the same reply key: the send
    // path retries only the channels that did not already land.
    const retry = await sendOwnerReply({ text: 'Synthetic answer' }, options({ imessage: sender('sent'), desktop: sender('sent') }));
    expect(retry.status).toBe('sent');

    r = await getThread(configDir, runsDir);
    expect(r.status).toBe(200);
    expect(r.body.receipts[reply.id]).toMatchObject({ desktop: { state: 'delivered' }, imessage: { state: 'delivered' } });

    const read = parseOwnerThreadRead(r.body);
    const receipt = ownerThreadLines(read.lines, [], read.receipts ?? {}).find(l => l.id === `owner-${reply.id}`)?.receipt;
    expect(receipt).toEqual(expect.arrayContaining([
      { channel: 'desktop', state: 'delivered' },
      { channel: 'imessage', state: 'delivered' },
    ]));
    expect(receipt).not.toEqual(expect.arrayContaining([expect.objectContaining({ state: 'failed' })]));
  });

  it('a blocked receipts file never blocks the send, and the API reports unknown', async () => {
    const { configDir, runsDir, options } = setup();
    const opts = options({ imessage: sender('sent'), desktop: sender('sent') });
    await acceptOwnerInbound({ channel: 'imessage', senderId: '+15550000000', text: 'Synthetic hello', idempotencyKey: 'in-key-c19602', at: Date.now() }, opts);
    // Break only the receipts path: the ledger path exists, but as a directory.
    mkdirSync(join(runsDir, 'leader'), { recursive: true });
    mkdirSync(join(runsDir, 'leader', 'delivery-receipts.jsonl'));

    const sent = await sendOwnerReply({ text: 'Synthetic answer' }, opts);
    expect(sent.status).toBe('sent');
    const reply = readOwnerThread(opts).messages.find(m => m.direction === 'outbound')!;

    const r = await getThread(configDir, runsDir);
    expect(r.status).toBe(200);
    expect(r.body.receipts[reply.id]).toBeUndefined();

    const read = parseOwnerThreadRead(r.body);
    const receipt = ownerThreadLines(read.lines, [], read.receipts ?? {}).find(l => l.id === `owner-${reply.id}`)?.receipt;
    expect(receipt).toEqual(expect.arrayContaining([
      { channel: 'desktop', state: 'unknown' },
      { channel: 'imessage', state: 'unknown' },
    ]));
  });

  it('scrubs and caps the failure reason before it is persisted', () => {
    const root = mkdtempSync(join(tmpdir(), 'receipts-recut-c196-'));
    roots.push(root);
    const runsDir = join(root, 'runs');
    const fake = 'ghp_AbCdEf0123456789GhIjKlMnOpQr'; // same scrub shape as test/scrub-310.test.ts
    recordDelivery(runsDir, 'm1', 'imessage', 'failed', `transport refused: token ${fake} ${'x'.repeat(300)}`);
    const receipts = readReceipts(runsDir, ['m1']);
    const reason = receipts.m1?.imessage?.reason ?? '';
    expect(reason).not.toContain(fake);
    expect(reason).toContain('[REDACTED]');
    expect(reason.length).toBeLessThanOrEqual(160);
  });
});
