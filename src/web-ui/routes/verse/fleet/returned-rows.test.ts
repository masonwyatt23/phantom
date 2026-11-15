import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { WorkersCard } from './WorkersCard.js';
import { toReturnedRows } from './returned-rows.js';
import type { FleetRunsReturn } from '../ops/ops-runs-model.js';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../../../../core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH } from '../../../../core/verse/fleet-runs-types.js';
import type { VerseApiContext } from '../../../../core/verse/verse-api.js';
import type { FleetBoard, FleetMessage } from '../../../../core/fleet/coordination.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const at = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const expiry = new Date(NOW + 3_600_000).toISOString();

const row = (over: Partial<FleetRunsReturn> = {}): FleetRunsReturn => ({
  claimId: 'claim-1', repo: 'example/repo', result: 'VERIFIED', evidenceKind: 'pr',
  pr: 123, head: 'abc1234def0', evidence: 'merged PR', from: 'agent-devin',
  at: at(120), expiresAt: expiry, ...over,
});

describe('toReturnedRows', () => {
  it('maps VERIFIED and BLOCKED returns newest first', () => {
    const rows = toReturnedRows([
      row(),
      row({ claimId: 'claim-2', result: 'BLOCKED', evidenceKind: 'dependency', pr: null, head: null,
        evidence: 'waiting on upstream merge', from: 'agent-codex', at: at(30) }),
    ], NOW);
    expect(rows.map(r => [r.state, r.target])).toEqual([
      ['BLOCKED', 'example/repo#?@unknown'],
      ['VERIFIED', 'example/repo#123@abc1234'],
    ]);
    expect(rows[1]).toMatchObject({ who: 'agent-devin', claimId: 'claim-1', age: '02:00', ageSeconds: 120 });
    expect(rows[0]).toMatchObject({ who: 'agent-codex', evidence: 'waiting on upstream merge', age: '00:30' });
  });

  it('renders ? and unknown when the receipt names no pr or head', () => {
    const [missing] = toReturnedRows([row({ pr: null, head: null })], NOW);
    expect(missing.target).toBe('example/repo#?@unknown');
    const [short] = toReturnedRows([row({ head: 'de' })], NOW);
    expect(short.target).toBe('example/repo#123@de');
  });

  it('truncates evidence at 160 characters', () => {
    const [r] = toReturnedRows([row({ evidence: 'x'.repeat(300) })], NOW);
    expect(r.evidence).toHaveLength(160);
  });

  it('re-scrubs secret-shaped evidence', () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const [r] = toReturnedRows([row({ evidence: `merge failed with token ${secret} in output` })], NOW);
    expect(r.evidence).not.toContain('ghp_');
    expect(r.evidence).not.toContain('a'.repeat(36));
  });

  it('returns an empty list for null, undefined or empty returns and caps at 20', () => {
    expect(toReturnedRows(null, NOW)).toEqual([]);
    expect(toReturnedRows(undefined, NOW)).toEqual([]);
    expect(toReturnedRows([], NOW)).toEqual([]);
    const many = Array.from({ length: 25 }, (_, i) => row({ claimId: `claim-${i}` }));
    expect(toReturnedRows(many, NOW)).toHaveLength(20);
  });
});

/* Flow: the real /api/verse/fleet/runs payload builder (createFleetRunsApi)
 * carries returns from the coordination board; the console's real narrowing
 * (narrowWorkers + isFleetRuns) then renders them in WorkersCard. */

function receipt(id: string, body: string, seconds: number): FleetMessage {
  return { id, from: 'agent-devin', to: 'leader', body, at: NOW - seconds * 1000, expiresAt: NOW + 3_600_000 };
}

function board(over: Partial<FleetBoard> = {}): FleetBoard {
  return {
    schema: 'fleet.coordination.v1', state: 'known', claims: [], proposals: [], expiredClaims: 0,
    messages: [
      receipt('return-claim-1', 'RESULT VERIFIED example/repo claim claim-1 task "ship the thing": pr #123 head abc1234def0', 120),
      receipt('return-claim-2', 'RESULT BLOCKED example/repo claim claim-2 task "blocked thing": dependency waiting on upstream merge', 30),
    ],
    ...over,
  };
}

function deps(over: Partial<FleetRunsApiDeps> = {}): FleetRunsApiDeps {
  return {
    now: () => NOW,
    runsDir: mkdtempSync(join(tmpdir(), 'fleet-returns-')),
    readRunsDir: async () => ({ lastTick: at(60), paused: false, memFreePct: 50, diskFreeGb: 10,
      switches: [], claudeLane: null, lanes: [], publishesLastHour: [], events: [] }),
    listWorkers: async () => ({ workers: [], leaders: [], orchestratorAgents: null }),
    readInbox: async () => [], readOutbox: async () => [],
    codexPersonal: async () => null,
    mergedLastHour: async () => ({ count: 0, items: [] }),
    readHostLoad: () => null,
    ...over,
  };
}

async function wire(over: Partial<FleetRunsApiDeps> = {}) {
  const api = createFleetRunsApi(deps(over));
  let status = 0;
  let body: Record<string, unknown> | null = null;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(text: string) { body = JSON.parse(text) as Record<string, unknown>; },
  } as unknown as ServerResponse;
  const req = { url: VERSE_FLEET_RUNS_PATH, method: 'GET', headers: {} } as unknown as IncomingMessage;
  const handled = await api({ cfg: {}, token: 'fake-token', allowDispatch: true } as VerseApiContext,
    req, res, VERSE_FLEET_RUNS_PATH, 'GET');
  return { handled, status, body };
}

function show(data: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(createElement(SectionVisibilityProvider, { visible: true }, createElement(WorkersCard)));
}

describe('returns through /api/verse/fleet/runs into WorkersCard', () => {
  beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); evictAll(); });

  it('puts board returns on the wire and renders them newest first', async () => {
    const { handled, status, body } = await wire({ readBoard: () => board() });
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ returns: [
      { result: 'BLOCKED', claimId: 'claim-2', repo: 'example/repo', pr: null, head: null, evidence: 'dependency waiting on upstream merge' },
      { result: 'VERIFIED', claimId: 'claim-1', repo: 'example/repo', pr: 123, head: 'abc1234def0' },
    ], returnsReason: null });
    show(body);
    const list = await screen.findByRole('list', { name: 'Returned claims' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const [first, second] = items;
    expect(within(first).getByText('BLOCKED')).toHaveAttribute('data-stage', 'blocked');
    expect(within(first).getByText('agent-devin')).toBeInTheDocument();
    expect(within(first).getByText('example/repo#?@unknown')).toBeInTheDocument();
    expect(within(first).getByText('dependency waiting on upstream merge')).toBeInTheDocument();
    expect(within(first).getByText('00:30')).toBeInTheDocument();
    expect(within(second).getByText('VERIFIED')).toHaveAttribute('data-stage', 'verified');
    expect(within(second).getByText('example/repo#123@abc1234')).toBeInTheDocument();
    expect(within(second).getByText('02:00')).toBeInTheDocument();
    expect(screen.getByText('Returned')).toBeInTheDocument();
  });

  it('sends returns: null with a reason and renders the unknown line for an unknown board', async () => {
    const { body } = await wire({ readBoard: () => board({ state: 'unknown', expiredClaims: null }) });
    expect(body).toMatchObject({ returns: null, returnsReason: 'coordination ledger: reader failed' });
    show(body);
    expect(await screen.findByText('Returns unknown: coordination ledger: reader failed')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Returned claims' })).not.toBeInTheDocument();
  });

  it('degrades to the unknown line when the board reader throws', async () => {
    const { body } = await wire({ readBoard: () => { throw new Error('boom'); } });
    expect(body).toMatchObject({ returns: null, returnsReason: 'coordination ledger: reader failed' });
    show(body);
    expect(await screen.findByText('Returns unknown: coordination ledger: reader failed')).toBeInTheDocument();
  });
});
