import { formatReset } from '../fleet-usage/usage-pane-model.js';
import { projectResourceDisplay } from '../resources/resource-display-model.js';
import { personalSessionCurrent } from '../resources/personal-session-freshness.js';
import type { CapacityRow } from '../usage/capacity-strip-model.js';
import type { PersonalReading } from '../usage/codex-burn-model.js';

const providers: Record<string, string> = {
  'codex-personal': 'codex-personal', 'codex-cmp': 'codex-cmp', claude: 'claude-a',
  devin: 'devin', 'devin-flash': 'devin', 'codex-local': 'local',
};

export function laneProvider(lane: string): string | null { return providers[lane] ?? null; }

export function laneUsageLine(lane: string, readings: { rows: readonly CapacityRow[]; personal: PersonalReading | null }, now: number): { text: string; title: string } | null {
  const provider = laneProvider(lane);
  if (!provider) return null;
  const unknown = { text: 'usage unknown', title: 'No current usage reading' };
  if (provider === 'codex-personal' && personalSessionCurrent(readings.personal, now)) {
    const personal = readings.personal!;
    if (personal.usedPct !== null) return { text: `${personal.usedPct}% used · ${personal.resetsAt ? formatReset(personal.resetsAt, now) : 'reset unknown'}`, title: 'Personal Codex session usage' };
  }
  const row = readings.rows.find(item => item.seatId === provider);
  if (!row || !projectResourceDisplay(row, { nowMs: now, healthRead: false }).usage.current) return unknown;
  const window = row.windows.find(item => item.binding) ?? row.windows[0];
  if (!window || window.usedPercent === null || window.limitReached) return unknown;
  return { text: `${window.usedPercent}% used · ${window.resetsAt ? formatReset(window.resetsAt, now) : 'reset unknown'}`, title: `${row.label} · ${window.label}` };
}
