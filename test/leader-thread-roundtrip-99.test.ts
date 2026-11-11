import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../src/core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { acknowledgeInboxEntries } from '../src/core/fleet/inbox-ack.js';
import { INTERJECT_ACK_READ_PATH, INTERJECT_POST_PATH, buildInterjectBody, pickInboxAck } from '../src/web-ui/routes/verse/fleet/interject-request.js';
import { fleetInbox, fleetOutbox, lineSourceLabel, mergeThread } from '../src/web-ui/routes/verse/leader-thread/thread-merge-model.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
let root: string;
let runsDir: string;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  root = mkdtempSync(join(tmpdir(), 'leader-roundtrip-99-'));
  runsDir = join(root, 'runs');
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function deps(): FleetRunsApiDeps {
  return {
    runsDir, now: () => NOW,
    readRunsDir: async () => ({ lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [], publishesLastHour: [], events: [] }),
    listWorkers: async () => ({ workers: [], leaders: [], orchestratorAgents: null }),
    readHostLoad: () => ({ load1: 0, load5: 0, load15: 0, cores: 1, ratio: 0 }),
    codexPersonal: async () => null,
    mergedLastHour: async () => ({ count: 0, perHour: null, medianOpenToMergeMs: null, items: [] }),
    ownerThread: { runsDir: join(root, 'owner-runs'), configDir: join(root, 'owner-config') },
  };
}

async function call(handler: ReturnType<typeof createFleetRunsApi>, url: string, method: 'GET' | 'POST', body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': 'fake-token' };
  req.method = method;
  req.url = url;
  let status = 0;
  let out = '';
  const res = { headersSent: false, writeHead(code: number) { status = code; this.headersSent = true; }, end(value: string) { out = value; } } as unknown as ServerResponse;
  expect(await handler({ token: 'fake-token', allowDispatch: true } as VerseApiContext, req, res, url.split('?')[0]!, method)).toBe(true);
  return { status, body: JSON.parse(out) as Record<string, unknown> };
}

it('projects the desktop message, acknowledgement, reply and Slack message into one thread', async () => {
  const handler = createFleetRunsApi(deps());
  const posted = await call(handler, INTERJECT_POST_PATH, 'POST', buildInterjectBody('Fake desktop question'));
  expect(posted).toMatchObject({ status: 201, body: { accepted: true, id: expect.any(String) } });
  const id = posted.body.id as string;
  const inboxPath = join(runsDir, 'leader', 'MASON-INBOX.md');
  const lines = readFileSync(inboxPath, 'utf8').split('\n').filter(line => line.includes('[src:'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain(`[src:desktop id:${id}] Fake desktop question`);
  expect(pickInboxAck((await call(handler, INTERJECT_ACK_READ_PATH, 'GET')).body, id)).toBe('pending');

  // The planner records the durable receipt. No external channel is contacted.
  await acknowledgeInboxEntries(lines, runsDir, new Date(NOW + 60_000).toISOString(), { desktop: async () => {} });
  // The leader-network writer's heading/body format; its reply method requires a
  // separately authenticated network route and is not a general file writer.
  appendFileSync(join(runsDir, 'leader', 'MASON-OUTBOX.md'), `\n## ${new Date(NOW + 120_000).toISOString()} [leader-network:reply-${id}]\nLeader: Fake answer for ${id}\n`);
  appendFileSync(inboxPath, `\n${new Date(NOW + 180_000).toISOString()} [src:slack id:slack-fake] Fake Slack question\n`);

  const read = await call(handler, VERSE_FLEET_RUNS_PATH, 'GET');
  expect(read.status).toBe(200);
  const merged = mergeThread([], fleetInbox(read.body), NOW + 300_000, read.body, fleetOutbox(read.body));
  expect(merged.undated).toEqual([]);
  expect(merged.lines.map(line => line.text)).toEqual(['Fake desktop question', `Leader: Fake answer for ${id}`, 'Fake Slack question']);
  expect(merged.lines[0]?.ack?.state).toBe('seen');
  expect(lineSourceLabel(merged.lines[2]!.source).toLowerCase()).toContain('slack');
  expect(pickInboxAck((await call(handler, INTERJECT_ACK_READ_PATH, 'GET')).body, id)).toBe('acked');
});
