/**
 * RQ-PHX-BRIEFSENDSELFTICK06 — the self-tick's 'brief-send' step rides the
 * unattended tick: `ashlr fleet brief-send` planned and applied in-process,
 * once per local day per channel and never before 07:00 America/New_York.
 * All six other steps are stubs; senders and plan seams are fakes — no real
 * network, config or stamp file is ever touched outside the temp runs dir.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { DAILY_BRIEF_STAMP, readDailyBriefStamp } from '../src/core/comms/daily-brief-send.js';
import { SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickSteps } from '../src/core/fleet/self-tick.js';

// 2026-11-04 is EST (UTC-5): 13:00Z is 08:00 local, 11:30Z is 06:30 local.
const AT_0800 = Date.parse('2026-11-04T13:00:00Z');
const AT_0630 = Date.parse('2026-11-04T11:30:00Z');
const DAY = '2026-11-04';

let home: string;
let runsDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'self-tick-brief-'));
  runsDir = join(home, 'runs');
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const ok: SelfTickStep = async () => ({ exitCode: 0, output: '{}' });
const otherSteps: Partial<SelfTickSteps> = {
  'reset-release': ok, 'lane-autohold': ok, 'planner-tick': ok,
  'inbox-acks': ok, 'order-notices': ok, 'landed-sweep': ok,
};
const planDeps = {
  isConfigured: () => true,
  composeStatus: async (channel: string) => `plainly fake status for ${channel}`,
  needsYou: () => 2,
};

interface BriefStepReport {
  apply: boolean; day: string;
  entries: { channel: string; send: boolean; reason?: string; text?: string }[];
  results?: { channel: string; outcome: string; reason?: string }[];
}
type Deps = NonNullable<Parameters<typeof cmdFleetSelfTick>[1]>;
const tick = async (at: number, apply: boolean, extra: Deps = {}) => {
  const out: string[] = [];
  const code = await cmdFleetSelfTick(
    ['--json', '--runs-dir', runsDir, ...(apply ? ['--apply'] : [])],
    { home, now: () => at, steps: otherSteps, output: text => out.push(text), error: () => {}, ...extra });
  const report = JSON.parse(out[0]!) as {
    state: string;
    steps: { step: string; state: string; exitCode: number; report: BriefStepReport | null }[];
  };
  return { code, report, step: report.steps.find(s => s.step === 'brief-send')! };
};

describe('self-tick brief-send step', () => {
  it('runs last in the fixed step order', () => {
    expect(SELF_TICK_STEP_ORDER.at(-1)).toBe('brief-send');
    expect(SELF_TICK_STEP_ORDER).toEqual([
      'reset-release', 'lane-autohold', 'planner-tick', 'inbox-acks', 'order-notices', 'landed-sweep', 'brief-send',
    ]);
  });

  it('dry run reports the brief-send plan and sends nothing', async () => {
    const email = vi.fn(async () => {});
    const telegram = vi.fn(async () => {});
    const { code, report, step } = await tick(AT_0800, false, { briefSenders: { email, telegram }, briefPlanDeps: planDeps });
    expect(code).toBe(0);
    expect(report.steps.map(s => s.step)).toEqual([...SELF_TICK_STEP_ORDER]);
    expect(step).toMatchObject({ step: 'brief-send', state: 'ok', exitCode: 0 });
    expect(step.report).toMatchObject({ apply: false, day: DAY });
    expect(step.report!.entries).toEqual([
      { channel: 'email', send: true, text: expect.stringContaining('Needs you: 2') },
      { channel: 'telegram', send: true, text: expect.any(String) },
    ]);
    expect(step.report!.results).toBeUndefined();
    expect(email).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
    expect(existsSync(join(runsDir, DAILY_BRIEF_STAMP))).toBe(false);
  });

  it('apply at 08:00 ET sends each configured channel once and stamps the day; a second tick dedupes', async () => {
    const email = vi.fn(async () => {});
    const telegram = vi.fn(async () => {});
    const deps = { briefSenders: { email, telegram }, briefPlanDeps: planDeps };

    const first = await tick(AT_0800, true, deps);
    expect(first.code).toBe(0);
    expect(first.step.report).toMatchObject({ apply: true, day: DAY });
    expect(first.step.report!.results).toEqual([
      { channel: 'email', outcome: 'sent' },
      { channel: 'telegram', outcome: 'sent' },
    ]);
    expect(email).toHaveBeenCalledOnce();
    expect(email.mock.calls[0]![0]).toContain('Needs you: 2');
    expect(telegram).toHaveBeenCalledOnce();
    expect(readDailyBriefStamp(runsDir)).toEqual({ email: DAY, telegram: DAY });

    const second = await tick(Date.parse('2026-11-04T20:00:00Z'), true, deps);
    expect(second.code).toBe(0);
    expect(second.step.report!.entries).toEqual([
      { channel: 'email', send: false, reason: 'already-sent-today' },
      { channel: 'telegram', send: false, reason: 'already-sent-today' },
    ]);
    expect(second.step.report!.results).toEqual([
      { channel: 'email', outcome: 'skipped', reason: 'already-sent-today' },
      { channel: 'telegram', outcome: 'skipped', reason: 'already-sent-today' },
    ]);
    expect(email).toHaveBeenCalledOnce();
    expect(telegram).toHaveBeenCalledOnce();
  });

  it('apply at 06:30 ET sends nothing, reports before-send-hour and writes no stamp', async () => {
    const email = vi.fn(async () => {});
    const telegram = vi.fn(async () => {});
    const { code, step } = await tick(AT_0630, true, { briefSenders: { email, telegram }, briefPlanDeps: planDeps });
    expect(code).toBe(0);
    expect(step.report!.entries).toEqual([
      { channel: 'email', send: false, reason: 'before-send-hour' },
      { channel: 'telegram', send: false, reason: 'before-send-hour' },
    ]);
    expect(step.report!.results).toEqual([
      { channel: 'email', outcome: 'skipped', reason: 'before-send-hour' },
      { channel: 'telegram', outcome: 'skipped', reason: 'before-send-hour' },
    ]);
    expect(email).not.toHaveBeenCalled();
    expect(telegram).not.toHaveBeenCalled();
    expect(existsSync(join(runsDir, DAILY_BRIEF_STAMP))).toBe(false);
  });

  it('a throwing sender fails its channel inside the report and nothing else stops', async () => {
    const email = vi.fn(async () => { throw new Error('fake transport down'); });
    const telegram = vi.fn(async () => {});
    const { code, report, step } = await tick(AT_0800, true, {
      briefSenders: { email, telegram }, briefPlanDeps: planDeps,
    });
    // The whole pass still completed: every stubbed step and brief-send is ok,
    // and the send that came after the throwing one still ran and stamped.
    expect(code).toBe(0);
    expect(report.steps.every(s => s.state === 'ok')).toBe(true);
    expect(step.report!.results).toEqual([
      { channel: 'email', outcome: 'failed' },
      { channel: 'telegram', outcome: 'sent' },
    ]);
    expect(readDailyBriefStamp(runsDir)).toEqual({ telegram: DAY });
  });

  it('the human summary reads "brief: <channel> <outcome>" per channel', async () => {
    const out: string[] = [];
    const code = await cmdFleetSelfTick(['--runs-dir', runsDir], {
      home, now: () => AT_0800, steps: otherSteps, output: text => out.push(text), error: () => {},
      briefPlanDeps: { ...planDeps, isConfigured: channel => channel === 'email' },
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('brief-send  ok  exit=0');
    expect(out.join('\n')).toContain('brief: email would-send, telegram skipped (not-configured)');
  });
});
