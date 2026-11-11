import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetEmailOutboxAwait } from '../src/mcp/fleet-email-outbox-await.js';
import { readEmailDropConfig, EMAIL_DROP_CONFIG_FILE } from '../src/core/comms/email-drop-config.js';

const input = { name: 'fake.reply.eml', timeoutMs: 1000 };
const unknown = { sourceState: 'unobserved', state: null, reason: null };
const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-config-boundary-'));
  roots.push(dir);
  return dir;
}
function deferred() {
  return Promise.withResolvers<Awaited<ReturnType<typeof readEmailDropConfig>>>();
}
afterEach(() => {
  vi.useRealTimers();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('single email MCP configuration deadline', () => {
  it('skips discovery and polling on pre-abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const readConfig = vi.fn<typeof readEmailDropConfig>();
    const poll = vi.fn();
    const result = await readFleetEmailOutboxAwait(input, controller.signal, { readConfig, await: poll });
    expect(result).toMatchObject({ ...unknown, cancelled: true, timedOut: false });
    expect(readConfig).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('cancels pending discovery and ignores a late %s', async (settlement) => {
    vi.useFakeTimers();
    const pending = deferred();
    const controller = new AbortController();
    const poll = vi.fn();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = readFleetEmailOutboxAwait(input, controller.signal, { readConfig: () => pending.promise, await: poll });
    await Promise.resolve();
    controller.abort();
    expect(await result).toMatchObject({ ...unknown, cancelled: true, timedOut: false });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    if (settlement === 'reject') pending.reject(new Error('late fake failure'));
    else pending.resolve({ state: 'missing', config: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(poll).not.toHaveBeenCalled();
  });

  it('times out pending discovery and ignores late rejection', async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const poll = vi.fn();
    const result = readFleetEmailOutboxAwait(input, undefined, { readConfig: () => pending.promise, await: poll });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ ...unknown, cancelled: false, timedOut: true });
    pending.reject(new Error('late fake failure'));
    await Promise.resolve();
    expect(poll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deducts discovery time from the polling budget', async () => {
    vi.useFakeTimers();
    const dir = root();
    const pending = deferred();
    const poll = vi.fn(async () => ({ name: input.name, state: 'sent' as const, timedOut: false, cancelled: false }));
    const result = readFleetEmailOutboxAwait(input, undefined, { readConfig: () => pending.promise, await: poll });
    await vi.advanceTimersByTimeAsync(400);
    pending.resolve({ state: 'ok', config: { v: 1, inboxDir: dir, outboxDir: dir, from: ['fake@example.test'] } });
    expect(await result).toMatchObject({ sourceState: 'ok', state: 'sent' });
    expect(poll).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 600 }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads a real temporary terminal artifact without exposing its body', async () => {
    const dir = root();
    const outbox = join(dir, 'outbox');
    mkdirSync(join(dir, 'queue'));
    mkdirSync(join(outbox, 'sent'), { recursive: true });
    writeFileSync(join(dir, EMAIL_DROP_CONFIG_FILE), JSON.stringify({ v: 1, inboxDir: join(dir, 'inbox'), outboxDir: outbox, from: ['fake@example.test'] }));
    writeFileSync(join(outbox, 'sent', input.name), 'Subject: fake\r\n\r\nPRIVATE-FAKE-BODY');
    const result = await readFleetEmailOutboxAwait(input, undefined, { runsDir: dir });
    expect(result).toMatchObject({ sourceState: 'ok', state: 'sent', reason: null, timedOut: false, cancelled: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-FAKE-BODY');
  });

  it('preserves config rejection and missing/invalid reports', async () => {
    for (const [readConfig, sourceState] of [
      [async () => { throw new Error('fake failure'); }, 'invalid-config'],
      [async () => ({ state: 'missing' as const, config: null }), 'missing-config'],
      [async () => ({ state: 'invalid' as const, config: null }), 'invalid-config'],
    ] as const) {
      const poll = vi.fn();
      const result = await readFleetEmailOutboxAwait(input, undefined, { readConfig, await: poll });
      expect(result).toMatchObject({ sourceState, state: null, reason: 'source-failure', timedOut: false, cancelled: false });
      expect(poll).not.toHaveBeenCalled();
    }
  });
});
