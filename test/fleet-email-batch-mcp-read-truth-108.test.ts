import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMAIL_DROP_CONFIG_FILE } from '../src/core/comms/email-drop-config.js';
import { type BatchResult } from '../src/core/comms/email-outbox-batch-await.js';
import { readFleetEmailOutboxBatchAwait } from '../src/mcp/fleet-email-outbox-batch-await.js';

let root: string;
const names = ['sent.reply.eml', 'drafted.reply.eml', 'queued.reply.eml', 'stuck.reply.eml'];
const rows: BatchResult['rows'] = [
  { name: names[0]!, state: 'sent' },
  { name: names[1]!, state: 'drafted' },
  { name: names[2]!, state: 'queued' },
  { name: names[3]!, state: 'stuck', reason: 'malformed' },
];
const input = { names, timeoutMs: 500 };

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'batch-read-truth-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function config(outboxDir: string): void {
  mkdirSync(join(root, 'queue'), { recursive: true });
  writeFileSync(join(root, EMAIL_DROP_CONFIG_FILE), JSON.stringify({
    v: 1, inboxDir: join(root, 'inbox'), outboxDir, from: ['owner@example.test'],
  }));
}

describe('fleet email batch read truth', () => {
  it.each([
    { timedOut: false, cancelled: false, sourceFailure: true },
    { timedOut: false, cancelled: true, sourceFailure: true },
    { timedOut: false, cancelled: true, sourceFailure: false },
  ])('retains batch evidence and flags: %j', async (flags) => {
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);
    config(outbox);
    const awaitBatch = vi.fn(async () => ({ rows, ...flags }));
    const report = await readFleetEmailOutboxBatchAwait(input, undefined, { runsDir: root, awaitBatch });
    expect(awaitBatch).toHaveBeenCalledOnce();
    expect(report).toEqual({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: expect.any(String), sourceState: 'ok', rows, ...flags,
    });
  });

  it.each(['missing-config', 'invalid-config', 'missing-outbox'])('does not poll on %s', async (state) => {
    if (state === 'invalid-config') {
      mkdirSync(join(root, 'queue'), { recursive: true });
      writeFileSync(join(root, EMAIL_DROP_CONFIG_FILE), '{invalid');
    } else if (state === 'missing-outbox') config(join(root, 'absent'));
    const awaitBatch = vi.fn();
    const report = await readFleetEmailOutboxBatchAwait(input, undefined, { runsDir: root, awaitBatch });
    expect(awaitBatch).not.toHaveBeenCalled();
    expect(report).toMatchObject({ sourceState: state, rows: null, sourceFailure: true, timedOut: false, cancelled: false, authority: 'none' });
  });
});
