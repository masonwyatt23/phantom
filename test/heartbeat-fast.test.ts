import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateFastFindings, heartbeatStatus, readHeartbeatState, runFastHeartbeat } from '../src/core/heartbeat/fast.js';
import { readVitals, selectInterval } from '../src/core/heartbeat/evidence.js';
import { readHeartbeatFile } from '../src/core/heartbeat/io.js';
import { FINDING_TTL_MS, MAX_DIGEST_BYTES, modelOutputSchema, tickSchema, type Finding } from '../src/core/heartbeat/schema.js';
import { cmdHeartbeat } from '../src/cli/heartbeat.js';

let root: string;
let now: number;
const finding: Finding = { kind: 'merge_stall', severity: 'high', job: 'RQ-TEST', lane: 'codex-personal', evidence: 'metrics/jobs.jsonl: RQ-TEST finished 40 minutes ago without a merged event' };
const response = (findings: Finding[] = [], suggested_actions: string[] = []) => JSON.stringify({ findings, suggested_actions });
function seed(path: string, value: unknown, at = now) {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); utimesSync(file, at / 1000, at / 1000);
}
function vitals(queue = 0, running = 0, admit = true, launches: string[] = []) {
  seed('queue/status.json', { last_tick: new Date(now).toISOString(), queue_depth: queue, lanes: { local: { running } }, launched_this_tick: launches });
  seed('queue/admission.json', { ts: new Date(now).toISOString(), admit });
}
const run = (findings: Finding[] = [], actions: string[] = []) => runFastHeartbeat({ runsDir: root, now: () => now, generate: async () => response(findings, actions) });
const rows = () => readFileSync(join(root, 'metrics/heartbeat-fast.jsonl'), 'utf8').trim().split('\n').map(s => tickSchema.parse(JSON.parse(s)));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'heartbeat-fast-')); now = Date.now(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('fast heartbeat persistence and advisory boundaries', () => {
  it('persists quiet timing and skips model calls until due across invocations', async () => {
    vitals();
    expect(await run()).toMatchObject({ status: 'healthy', tick: { interval_s: 900, interval_reason: 'quiet' } });
    const generate = vi.fn(async () => response());
    now += 899_000;
    expect(await runFastHeartbeat({ runsDir: root, now: () => now, generate })).toEqual({ status: 'not_due' });
    expect(generate).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
    expect(statSync(join(root, 'heartbeat/state.json')).mode & 0o777).toBe(0o600);
    expect(heartbeatStatus(root, now)).toMatchObject({ interval_s: 900, model_health: 'healthy', open_findings: 0, stale: false });
  });
  it('uses base for unknown data and tightens for launches and starvation', async () => {
    expect((await run()).tick?.interval_s).toBe(300);
    now += 300_000; vitals(3, 0);
    expect((await run()).tick).toMatchObject({ interval_s: 60, interval_reason: 'queue_starvation' });
    now += 60_000; vitals(0, 1, true, ['A', 'B', 'C']);
    expect((await run()).tick).toMatchObject({ interval_s: 60, interval_reason: 'launch_churn' });
  });
  it('adapts to admission flapping using durable samples at base cadence', async () => {
    for (const admit of [true, false, true, false]) {
      vitals(2, 1, admit); await run(); now += 300_000;
    }
    expect(rows().at(-1)).toMatchObject({ interval_s: 60, interval_reason: 'admission_flapping' });
  });
  it('deduplicates unchanged findings and advice, records confirmations, and re-emits at TTL', async () => {
    vitals(2, 1);
    await run([finding], ['Review through sanctioned queue paths']);
    now += 60_000; vitals(2, 1); await run([finding], ['Review through sanctioned queue paths']);
    expect(rows()[1]).toMatchObject({ findings: [], suggested_actions: [], observed_ids: rows()[0]!.observed_ids });
    now += FINDING_TTL_MS; vitals(2, 1); await run([finding]);
    expect(rows()[2]!.findings).toHaveLength(1);
    expect(rows()[2]!.findings[0]!.id).toBe(rows()[0]!.findings[0]!.id);
  });
  it('emits changed evidence and severity immediately, and expires unconfirmed findings', async () => {
    await run([finding]); now += 60_000;
    await run([{ ...finding, severity: 'medium', evidence: 'metrics/jobs.jsonl: new CI progress' }]);
    expect(rows()[1]!.findings[0]!.severity).toBe('medium');
    now += 31 * 60_000;
    expect(heartbeatStatus(root, now)).toMatchObject({ open_findings: 0, stale: true });
  });
  it('degrades on timeout, persists health, decays evidence, and recovers without paid fallback', async () => {
    await run([finding]); now += 60_000;
    const result = await runFastHeartbeat({ runsDir: root, now: () => now, timeoutMs: 10, generate: async () => new Promise(() => {}) });
    expect(result).toMatchObject({ status: 'degraded', tick: { findings: [] } });
    expect(heartbeatStatus(root, now)).toMatchObject({ model_health: 'degraded', consecutive_failures: 1 });
    now += 300_000; await run();
    expect(heartbeatStatus(root, now)).toMatchObject({ model_health: 'healthy', consecutive_failures: 0 });
  });
  it.each([
    ['non-JSON', 'not JSON'], ['unknown field', '{"findings":[],"suggested_actions":[],"launch":true}'],
    ['long evidence', response([{ ...finding, evidence: 'x'.repeat(601) }])], ['oversized body', 'x'.repeat(20_000)],
    ['empty after scrubbing', response([{ ...finding, evidence: '\u200b' }])],
  ])('fails closed on invalid output: %s', async (_label, raw) => {
    expect(await runFastHeartbeat({ runsDir: root, now: () => now, generate: async () => raw })).toMatchObject({ status: 'degraded', tick: { findings: [], suggested_actions: [] } });
  });
  it('does not store secret-shaped model output or exception text', async () => {
    const secret = 'ghp_' + 'x'.repeat(40);
    await runFastHeartbeat({ runsDir: root, now: () => now, generate: async () => response([{ ...finding, evidence: secret }]) });
    expect(readFileSync(join(root, 'metrics/heartbeat-fast.jsonl'), 'utf8')).not.toContain(secret);
    now += 300_000;
    const result = await runFastHeartbeat({ runsDir: root, now: () => now, generate: async () => { throw new Error(secret); } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('serializes overlapping invocations and only writes heartbeat artifacts', async () => {
    vitals(2, 1);
    const original = readFileSync(join(root, 'queue/status.json'), 'utf8');
    let release!: (value: string) => void;
    const first = runFastHeartbeat({ runsDir: root, now: () => now, generate: () => new Promise(resolve => { release = resolve; }) });
    await Promise.resolve();
    expect(await run()).toEqual({ status: 'busy' });
    release(response([finding], ['kill everything'])); await first;
    expect(readFileSync(join(root, 'queue/status.json'), 'utf8')).toBe(original);
    expect(readdirSync(root).sort()).toEqual(['heartbeat', 'metrics', 'queue']);
    expect(readdirSync(join(root, 'metrics'))).toEqual(['heartbeat-fast.jsonl']);
    expect(rows()).toHaveLength(1);
  });
  it('refuses corrupt state and symlinked journal without changing its target', async () => {
    seed('heartbeat/state.json', '{}'); expect((await run()).status).toBe('degraded');
    rmSync(join(root, 'heartbeat/state.json'));
    seed('target', 'untouched'); mkdirSync(join(root, 'metrics'), { recursive: true });
    symlinkSync(join(root, 'target'), join(root, 'metrics/heartbeat-fast.jsonl'));
    expect((await run()).status).toBe('degraded'); expect(readFileSync(join(root, 'target'), 'utf8')).toBe('untouched');
  });
});

describe('bounded fleet evidence', () => {
  it('labels source freshness, scrubs inputs, and stays under a UTF-8 byte cap', () => {
    vitals();
    const secret = 'ghp_' + 'a'.repeat(40);
    seed('dispatch-events.log', `${secret} ${'界'.repeat(50_000)}\n`);
    seed('metrics/jobs.jsonl', JSON.stringify({ event: 'finish', job: 'RQ-X', token: secret }) + '\n', now - 600_000);
    seed('queue/budget-overrides.json', { local: { remaining_pct: 50 } }, now - 31 * 60_000);
    const observed = readVitals(root, now);
    expect(Buffer.byteLength(observed.digest)).toBeLessThanOrEqual(MAX_DIGEST_BYTES);
    expect(observed.digest).not.toContain(secret);
    expect(observed.sources.map(s => s.freshness)).toEqual(['fresh', 'fresh', 'fresh', 'stale', 'stale', 'unavailable']);
  });
  it('does not infer quiet from stale or incomplete status, even after a file touch', () => {
    vitals(); seed('queue/status.json', { last_tick: new Date(now - 3600_000).toISOString(), queue_depth: 0, lanes: { local: { running: 0 } } });
    expect(selectInterval(readVitals(root, now), [], []).interval_s).toBe(300);
    seed('queue/status.json', { last_tick: new Date(now + 3600_000).toISOString(), queue_depth: 0, lanes: { local: { running: 0 } } });
    expect(selectInterval(readVitals(root, now), [], []).interval_s).toBe(300);
    seed('queue/status.json', { queue_depth: 0, lanes: { local: {} } });
    expect(selectInterval(readVitals(root, now), [], []).interval_s).toBe(300);
  });
  it('rejects links and oversized snapshots, and drops partial tail records', () => {
    seed('big', 'x'.repeat(100_000)); symlinkSync(join(root, 'big'), join(root, 'linked'));
    expect(readHeartbeatFile(root, 'linked')).toBeNull(); expect(readHeartbeatFile(root, 'big')).toBeNull();
    seed('log', 'complete\npartial'); expect(readHeartbeatFile(root, 'log', 100, true)?.text).toBe('complete\n');
  });
});

describe('loopback transport and CLI', () => {
  function stream(model = 'fast', finish = 'stop') {
    return new Response([
      `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: response() }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`, 'data: [DONE]\n\n',
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  it('uses numeric loopback, no credentials/tools, strict model binding and redirect refusal', async () => {
    const fetcher = vi.fn(async () => stream()); vi.stubGlobal('fetch', fetcher);
    expect(modelOutputSchema.parse(JSON.parse(await generateFastFindings('{}', new AbortController().signal)))).toEqual({ findings: [], suggested_actions: [] });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8123/v1/chat/completions', expect.objectContaining({ redirect: 'error' }));
    const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(request.headers).has('Authorization')).toBe(false);
    const body = JSON.parse(String(request.body)); expect(body.tools).toBeUndefined(); expect(body.model).toBe('fast'); expect(body.max_tokens).toBe(2048);
  });
  it.each([['wrong', 'stop'], ['fast', 'length']])('refuses misbound or incomplete stream %s/%s', async (model, finish) => {
    const fetcher = vi.fn(async () => stream(model, finish)); vi.stubGlobal('fetch', fetcher);
    await expect(generateFastFindings('{}', new AbortController().signal)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([302, 503])('degrades on HTTP %s without following a redirect or retrying remotely', async status => {
    const fetcher = vi.fn(async () => new Response('', { status, headers: { Location: 'https://example.invalid/model' } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await runFastHeartbeat({ runsDir: root, now: () => now })).toMatchObject({ status: 'degraded', tick: { model: 'local:fast', findings: [] } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects oversized or aborted requests before model contact', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(generateFastFindings('x'.repeat(MAX_DIGEST_BYTES + 1), new AbortController().signal)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(generateFastFindings('{}', controller.signal)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('exposes status/digest without model calls, rejects flags, and supports a cancelled watch', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
    const generate = vi.fn(async () => response()); const options = { runsDir: root, now: () => now, generate };
    expect(await cmdHeartbeat(['status', '--json'], options)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ last_tick: null, model_health: 'unknown', open_findings: null });
    expect(await cmdHeartbeat(['digest', '--json'], options)).toBe(0);
    expect(await cmdHeartbeat(['tick', '--force'], options)).toBe(2);
    const controller = new AbortController(); controller.abort();
    expect(await cmdHeartbeat(['watch'], { ...options, signal: controller.signal })).toBe(0);
    expect(generate).not.toHaveBeenCalled(); expect(readHeartbeatState(root)).toBeNull();
  });
});
