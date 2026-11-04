import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../../src/mcp/fleet-server.js';
import {
  FLEET_JOB_PRECHECK_REF,
  parseFleetJobPrecheckArgs,
  readFleetJobPrecheck,
  type FleetJobPrecheckDeps,
} from '../../src/mcp/fleet-job-precheck.js';
import type { JobPrecheckGit } from '../../src/core/fleet/job-precheck.js';

/**
 * RQ-PHX-MCPPRECHECKSNAP04SPH1: the reader must pin one resolved
 * origin/master commit before any path probe so a fetch landing mid-answer
 * cannot mix trees inside a single response. Every fake below is injected —
 * no real git runs in this lane.
 */
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

async function connect(deps: FleetJobPrecheckDeps) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'precheck-snapshot-test', version: '1' });
  clients.push(client);
  await createFleetServer({
    status: async () => ({}), loop: async () => ({}),
    jobPrecheck: input => readFleetJobPrecheck(input, deps),
  }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const body = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;
const parse = (result: { content?: unknown }) => JSON.parse(body(result));

const landed = (subjects: Record<string, string>): JobPrecheckGit => ({
  exists: async path => Object.prototype.hasOwnProperty.call(subjects, path),
  lastCommit: async path => {
    const subject = subjects[path];
    return subject ? { sha: 'abc1234', subject } : null;
  },
});

describe('fleet_job_precheck resolved snapshot', () => {
  it('reports the exact resolved commit every fact came from', async () => {
    const resolveRef = vi.fn(async () => COMMIT_A);
    const probe = vi.fn((_resolvedRef: string) => landed({ 'src/a.ts': 'bridge(RQ-FAKE-1): landed (#1)' }));
    const client = await connect({ resolveRef, gitJobProbe: probe });
    const out = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts' } }));
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      ref: FLEET_JOB_PRECHECK_REF, resolvedRef: COMMIT_A, verdict: 'likely-done',
      facts: [{ path: 'src/a.ts', onMaster: true, lastCommit: { sha: 'abc1234' } }],
    });
    expect(resolveRef).toHaveBeenCalledTimes(1);
    expect(resolveRef).toHaveBeenCalledWith(FLEET_JOB_PRECHECK_REF);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(COMMIT_A);
    // Resolution happens strictly before the probe is constructed.
    expect(resolveRef.mock.invocationCallOrder[0]).toBeLessThan(probe.mock.invocationCallOrder[0]!);
  });

  it('pins every fact to commit A when the symbolic ref moves to B mid-answer', async () => {
    let symbolic = COMMIT_A;
    const builtWith: string[] = [];
    const probedOn: string[] = [];
    const client = await connect({
      resolveRef: async () => symbolic,
      gitJobProbe: resolved => {
        builtWith.push(resolved);
        // A concurrent fetch lands new merges while the answer is probed.
        symbolic = COMMIT_B;
        return {
          exists: async () => { probedOn.push(resolved); return true; },
          lastCommit: async () => { probedOn.push(resolved); return { sha: 'abc1234', subject: 'bridge(RQ-FAKE-2): landed' }; },
        };
      },
    });
    const out = parse(await client.callTool({
      name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts src/b.ts docs/d.md' },
    }));
    expect(symbolic).toBe(COMMIT_B);
    expect(out.resolvedRef).toBe(COMMIT_A);
    expect(builtWith).toEqual([COMMIT_A]);
    expect(probedOn).toEqual([COMMIT_A, COMMIT_A, COMMIT_A, COMMIT_A, COMMIT_A, COMMIT_A]);
    expect(out.verdict).toBe('likely-done');
  });

  it('propagates a resolution failure as a sanitized tool error before any probe', async () => {
    const probe = vi.fn();
    const client = await connect({
      resolveRef: async () => { throw new Error(`resolve FAILED-UNIQUE leaked ghp_${'Ab1'.repeat(10)}`); },
      gitJobProbe: probe,
    });
    const result = await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts' } });
    expect(result.isError).toBe(true);
    expect(body(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/FAILED-UNIQUE|ghp_|fresh/);
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-commit', 'deadbeef', 'A'.repeat(40), 'g'.repeat(40),
    'a'.repeat(39), 'a'.repeat(41), ` ${'a'.repeat(40)}`, `${'a'.repeat(40)}\n`, '',
  ])('rejects invalid resolver output before any probe: %j', async bad => {
    const probe = vi.fn();
    const client = await connect({ resolveRef: async () => bad, gitJobProbe: probe });
    const result = await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts' } });
    expect(result.isError).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('accepts a sha256-length resolved object id; the shared scrub still masks the bare hex-64 in the envelope', async () => {
    // Validation admits 40- and 64-hex ids; the probe is pinned to the raw
    // oid either way. sanitizePublicJson treats a bare hex-64 as key-shaped,
    // so the envelope shows [REDACTED] rather than weakening the scrub.
    const oid = 'f'.repeat(64);
    const probe = vi.fn((_resolvedRef: string) => landed({}));
    const client = await connect({ resolveRef: async () => oid, gitJobProbe: probe });
    const out = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/new.ts' } }));
    expect(probe).toHaveBeenCalledWith(oid);
    expect(out.resolvedRef).toBe('[REDACTED]');
  });

  it('keeps exact job-id evidence on the pinned commit', async () => {
    const client = await connect({
      resolveRef: async () => COMMIT_A,
      gitJobProbe: () => landed({ 'src/a.ts': 'bridge(RQ-FAKE-7): landed (#3)' }),
    });
    const match = parse(await client.callTool({
      name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts', jobId: 'RQ-FAKE-7' },
    }));
    expect(match).toMatchObject({
      resolvedRef: COMMIT_A, jobId: 'RQ-FAKE-7', verdict: 'likely-done', facts: [{ jobIdMatch: true }],
    });
    const other = parse(await client.callTool({
      name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts', jobId: 'RQ-OTHER-1' },
    }));
    expect(other).toMatchObject({ resolvedRef: COMMIT_A, verdict: 'partly-on-master', facts: [{ jobIdMatch: false }] });
  });

  it('keeps an injected git reader hermetic: no resolution, explicit null snapshot id', async () => {
    const git: JobPrecheckGit = { exists: async () => false, lastCommit: async () => null };
    // No resolver: the tool must not touch the repository to name a snapshot.
    const out = await readFleetJobPrecheck({ markdown: 'src/new.ts' }, { git });
    expect(out.ref).toBe(FLEET_JOB_PRECHECK_REF);
    expect(out).toHaveProperty('resolvedRef', null);
    expect(out.verdict).toBe('fresh');
  });

  it('still reports an injected resolver answer beside an injected reader', async () => {
    const resolveRef = vi.fn(async () => COMMIT_A);
    const out = await readFleetJobPrecheck({ markdown: 'src/a.ts' }, {
      git: landed({ 'src/a.ts': 'bridge(RQ-FAKE-3): landed' }), resolveRef,
    });
    expect(out.resolvedRef).toBe(COMMIT_A);
    expect(resolveRef).toHaveBeenCalledWith(FLEET_JOB_PRECHECK_REF);
  });

  it.each([
    { markdown: 'x', ref: 'origin/master' }, { markdown: 'x', ref: 'HEAD' },
    { markdown: 'x', resolvedRef: COMMIT_A }, { markdown: 'x', cwd: '/tmp' },
    { markdown: 'x', root: '/' }, { markdown: 'x', path: 'src/a.ts' }, { markdown: 'x', dir: '.' },
  ])('the parser still rejects caller-supplied repo selectors: %j', args => {
    expect(parseFleetJobPrecheckArgs(args)).toBeNull();
  });

  it('rejects a caller ref over MCP before resolving or probing', async () => {
    const resolveRef = vi.fn(async () => COMMIT_A);
    const probe = vi.fn();
    const client = await connect({ resolveRef, gitJobProbe: probe });
    await expect(client.callTool({
      name: 'fleet_job_precheck', arguments: { markdown: 'x', ref: 'origin/master' },
    })).rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({
      name: 'fleet_job_precheck', arguments: { markdown: 'x', cwd: '/tmp' },
    })).rejects.toMatchObject({ code: -32602 });
    expect(resolveRef).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
});
