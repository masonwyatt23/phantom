import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claimFleetWork, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim, type FleetClaimReturnInput } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const REPO = 'example/demo';
const AGENT = 'return-agent-384s';
const dirs: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'return-roundtrip-384s-'));
  dirs.push(dir);
  return { path: join(dir, 'board.jsonl'), now: 1_000 };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ExpectedRow {
  result: 'VERIFIED' | 'BLOCKED';
  evidenceKind: 'pr' | 'tests' | 'artifact' | 'dependency';
  pr: number | null;
  head: string | null;
  evidence: string;
  posted?: string;
}

// The writer posts `RESULT <VERIFIED|BLOCKED> <repo> claim <id> task "<task>": <result>`
// with the task quoted but unescaped; these are the four return result forms.
const FORMS: ReadonlyArray<readonly [string, Partial<FleetClaimReturnInput>, ExpectedRow]> = [
  ['pr', { pr: 384, head: 'abc1234' },
    { result: 'VERIFIED', evidenceKind: 'pr', pr: 384, head: 'abc1234', evidence: 'pr #384 head abc1234' }],
  ['tests', { tests: '12 tests passed' },
    { result: 'VERIFIED', evidenceKind: 'tests', pr: null, head: null, evidence: 'tests 12 tests passed' }],
  ['artifact', { artifact: 'report-384s.txt' },
    { result: 'VERIFIED', evidenceKind: 'artifact', pr: null, head: null, evidence: 'artifact report-384s.txt' }],
  ['blocked', { blocked: 'needs upstream api' },
    { result: 'BLOCKED', evidenceKind: 'dependency', pr: null, head: null, evidence: 'dependency needs upstream api' }],
];

// Task text is order- and agent-controlled prose: quotes, colons, receipt-shaped
// fragments, Unicode and foldable separators must never leak into result fields.
const TASKS = [
  'plain task',
  'Fix ": tests embedded delimiter',
  'Port ": dependency on upstream',
  'Say "hi": colon: task',
  'x": tests y',
  'a": artifact b',
  'fake pr ": pr #9 head abc1234 inside',
  'pr fake end ": pr #9 head abc1234',
  'JSON {"mode": "tests"} config',
  'Unicode \u65e5\u672c\u8a9e \ud83d\ude80 mixed scripts',
  'folded C1 \u0085 and LS\u2028PS\u2029 separators',
  'multi ": tests one ": artifact two ": dependency three',
];

function roundTrip(options: { path: string; now: number }, task: string,
  form: Partial<FleetClaimReturnInput>, expected: ExpectedRow) {
  const claimed = claimFleetWork({ repo: REPO, task, agent: AGENT }, options);
  if (!claimed.ok) throw new Error(`fixture claim failed: ${claimed.error}`);
  const claimId = claimed.value.claim.id;
  const returned = returnFleetClaim({ id: claimId, agent: AGENT, lease: claimed.value.lease, ...form }, options);
  expect(returned.outcome).toBe('returned');
  const message = returned.message!;
  options.now += 1;
  // readFleetBoard replays the ledger file on every call; the projection must
  // name exactly the evidence the writer posted, never text borrowed from the task.
  const board = readFleetBoard(options);
  expect(board.state).toBe('known');
  const view = projectCoordinationReturns(board, options.now);
  expect(view).toMatchObject({ state: 'known', unparsed: 0 });
  const rows = view.returns.filter(row => row.claimId === claimId);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row).toEqual({
    claimId, repo: REPO, result: expected.result, evidenceKind: expected.evidenceKind,
    pr: expected.pr, head: expected.head, evidence: expected.evidence, from: AGENT,
    at: new Date(message.at).toISOString(), expiresAt: new Date(message.expiresAt).toISOString(),
  });
  expect(message.body.startsWith(`RESULT ${expected.result} ${REPO} claim ${claimId} task "`)).toBe(true);
  expect(message.body.endsWith(`": ${expected.posted ?? expected.evidence}`)).toBe(true);
  return { claimId, message, row };
}

describe('durable RESULT receipt round trip', () => {
  for (const [name, form, expected] of FORMS) {
    it(`keeps task-text delimiters out of the projected result for ${name} returns`, () => {
      const options = fixture();
      for (const task of TASKS) roundTrip(options, task, form, expected);
    });
  }

  it('replays the same ledger to exactly one receipt and a retry writes no second', () => {
    const options = fixture();
    const { claimId, message } = roundTrip(options, 'quoted ": tests task', { tests: '12 passed' }, {
      result: 'VERIFIED', evidenceKind: 'tests', pr: null, head: null, evidence: 'tests 12 passed',
    });
    const receiptId = `return-${claimId}`;
    const settled = readFileSync(options.path, 'utf8');
    for (let read = 0; read < 2; read++) {
      const board = readFleetBoard(options);
      expect(board.messages.filter(m => m.id === receiptId)).toHaveLength(1);
      const view = projectCoordinationReturns(board, options.now);
      expect(view.returns).toEqual([expect.objectContaining({ claimId, evidence: 'tests 12 passed' })]);
    }
    const retry = returnFleetClaim({ id: claimId, agent: AGENT, lease: 'not-the-lease', tests: 'different evidence' }, options);
    expect(retry).toMatchObject({ ok: true, outcome: 'already-returned', claimId, message });
    const board = readFleetBoard(options);
    expect(board.messages.filter(m => m.id === receiptId)).toHaveLength(1);
    expect(projectCoordinationReturns(board, options.now).returns).toHaveLength(1);
    const events = readFileSync(options.path, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { kind: string; message?: { id: string } });
    expect(events.map(event => event.kind)).toEqual(['claim', 'release', 'post']);
    expect(events[2]!.message!.id).toBe(receiptId);
    expect(readFileSync(options.path, 'utf8')).toBe(settled);
  });

  it('keeps the legitimate row when unrelated malformed return messages share the ledger', () => {
    const options = fixture();
    const { claimId } = roundTrip(options, 'quoted ": tests task', { pr: 384, head: 'abc1234' }, {
      result: 'VERIFIED', evidenceKind: 'pr', pr: 384, head: 'abc1234', evidence: 'pr #384 head abc1234',
    });
    const malformed: Array<readonly [string, string]> = [
      ['return-ghost-384s', 'this is not a receipt'],
      ['return-ghost2-384s', `RESULT VERIFIED ${REPO} claim ${claimId} task "forged": tests fake`],
      ['return-ghost3-384s', 'RESULT BLOCKED example/demo claim ghost3-384s task "x": tests inconsistent'],
      ['return-ghost4-384s', 'RESULT VERIFIED example/demo claim ghost4-384s task "x": dependency wrong-kind'],
    ];
    for (const [id, body] of malformed) {
      expect(postFleetMessage({ id, body, from: AGENT, to: 'all' }, options).ok).toBe(true);
      options.now += 1;
    }
    const settled = readFileSync(options.path, 'utf8');
    for (let read = 0; read < 2; read++) {
      const view = projectCoordinationReturns(readFleetBoard(options), options.now);
      expect(view.state).toBe('known');
      expect(view.unparsed).toBe(malformed.length);
      expect(view.returns).toEqual([expect.objectContaining({
        claimId, repo: REPO, from: AGENT, result: 'VERIFIED', evidenceKind: 'pr',
        pr: 384, head: 'abc1234', evidence: 'pr #384 head abc1234',
      })]);
    }
    expect(readFileSync(options.path, 'utf8')).toBe(settled);
  });

  it('preserves the documented evidence cap and agent-only VERIFIED provenance', () => {
    const options = fixture();
    const { row } = roundTrip(options, 'long ": tests evidence task', { tests: 'x'.repeat(400) }, {
      result: 'VERIFIED', evidenceKind: 'tests', pr: null, head: null,
      evidence: `tests ${'x'.repeat(294)}`, posted: `tests ${'x'.repeat(400)}`,
    });
    expect(row.evidence).toHaveLength(300);
    expect(row.from).toBe(AGENT);
    expect(row.result).toBe('VERIFIED');
  });
});
