/**
 * Real request/event path for the `leader-thread` SSE topic. The thread lives
 * under a fixture HOME (never the real ~/.ashlr); the message text written
 * here must never appear on the wire.
 */
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi, drainSseConnections } from '../src/core/web/api.js';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

const watchSpy = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, watch: ((...a: Parameters<typeof actual.watch>) => { watchSpy(...a); return actual.watch(...a); }) as typeof actual.watch };
});

const SECRET_BODY = 'FAKE-THREAD-BODY-194S';
let fixture: H1Fixture | null = null;

afterEach(() => {
  drainSseConnections();
  fixture?.cleanup();
  fixture = null;
  watchSpy.mockClear();
});

async function connect(url: string, session = { id: 's194', expiresAt: Date.now() + 60_000 }) {
  const req = Object.assign(new EventEmitter(), { url, method: 'GET', headers: {} }) as IncomingMessage;
  const writes: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead: vi.fn(),
    write(chunk: string) { writes.push(String(chunk)); return true; },
    end: vi.fn(),
  }) as unknown as ServerResponse;
  const handled = await handleApi(req, res, makeCfg(), { token: 't', allowDispatch: false, readSession: session });
  return { req, res, writes, handled };
}

const waitFor = async (pred: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

describe('leader-thread SSE topic', () => {
  it('pushes metadata only when the thread changes, and stops after disconnect', async () => {
    fixture = makeFixture();
    const dir = join(fixture.home, '.ashlr', 'vision', 'leader');
    mkdirSync(dir, { recursive: true });
    const thread = join(dir, 'thread.jsonl');
    writeFileSync(thread, '');

    const c = await connect('/api/events?topics=leader-thread');
    expect(c.handled).toBe(true);
    expect(watchSpy).toHaveBeenCalledTimes(1);
    const frames = () => c.writes.join('');
    // FSEvents can lag right after the watch is armed: keep appending until seen.
    const line = `${JSON.stringify({ text: SECRET_BODY })}\n`;
    for (let i = 0; i < 8 && !frames().includes('event: leader-thread'); i += 1) {
      appendFileSync(thread, line);
      await waitFor(() => frames().includes('event: leader-thread'), 500);
    }
    expect(frames()).toContain('event: leader-thread');
    expect(frames()).not.toContain(SECRET_BODY);

    c.req.emit('close');
    const before = c.writes.length;
    appendFileSync(thread, 'x\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(c.writes.length).toBe(before);
  });

  it('does not create a watcher for unrelated topics', async () => {
    fixture = makeFixture();
    watchSpy.mockClear();
    const c = await connect('/api/events?topics=inbox');
    expect(c.handled).toBe(true);
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('still refuses an unauthenticated or expired session', async () => {
    fixture = makeFixture();
    const c = await connect('/api/events?topics=leader-thread', { id: 'old', expiresAt: Date.now() - 1 });
    expect(c.handled).toBe(true);
    expect(c.writes.join('')).not.toContain('event: leader-thread');
  });
});
