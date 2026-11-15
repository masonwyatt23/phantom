"""Pacing math and real dispatcher ticks, with synthetic metrics and temporary homes."""
import ast
import datetime
import json
import math
from pathlib import Path
import time
import unittest

from test_dispatchd import build, events, held_lanes, launch_stubs, queue_job, tick
from test_loadgate import admission, launched, ready_left

SOURCE = Path(__file__).resolve().parents[1] / 'dispatchd.py'
nodes = [n for n in ast.parse(SOURCE.read_text()).body
         if isinstance(n, ast.FunctionDef) and n.name == 'launch_pace']
scope = {'math': math, 'datetime': datetime, 'MAX_LAUNCH_PER_TICK': 8}
exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), scope)
pace = scope['launch_pace']


def gate(load=14, **kw):
    return {"load1": load, "load_max": 36, "ncpu": 18, "tripped": False,
            "procs": 1000, "procs_max": 2500, "worktrees": 10, "worktrees_max": 40, **kw}


def row(event, job, ts, **kw):
    return {'event': event, 'job': job, 'ts': ts, 'lane': 'codex-personal', **kw}


class PacingMath(unittest.TestCase):
    def decide(self, load=14, rows=(), now=1000, cap=32, targets=None, running=None, **kw):
        return pace(gate(load), targets or {'codex-personal': 32},
                    running or {'codex-personal': 0}, cap, rows, now, **kw)

    def test_budget_tapers_to_band_ceiling(self):
        loads = [1, 14, 26, 30, 32, 33.9, 34, 36]
        budgets = [self.decide(load)['budget'] for load in loads]
        self.assertEqual(budgets, [8, 5, 2, 2, 1, 1, 0, 0])
        for load, budget in zip(loads, budgets):
            self.assertLessEqual(load + budget * 2, 36)

    def test_slot_demand_and_existing_hard_gates_win(self):
        self.assertEqual(self.decide(cap=1)['budget'], 1)
        self.assertEqual(self.decide(targets={'codex-personal': 2}, running={'codex-personal': 2})['budget'], 0)
        blocked = pace(gate(tripped=True), {'l': 10}, {'l': 0}, 10, [], 1000)
        self.assertEqual((blocked['budget'], blocked['reason_codes']), (0, ['hard_gate']))
        self.assertEqual(self.decide(paused=True)['reason_codes'], ['paused'])
        for value in (float('nan'), float('inf'), -1):
            self.assertEqual(self.decide(value)['reason_codes'], ['signal_unavailable'])

    def test_load_lag_reserves_capacity_across_rapid_ticks_then_expires(self):
        rows = []
        for tick_id in range(15):
            decision = self.decide(rows=rows, now=1000 + tick_id)
            self.assertLessEqual(decision['effective_load'] + 2 * decision['budget'], 36)
            rows.extend(row('launch', f'j-{tick_id}-{i}', 1000 + tick_id) for i in range(decision['budget']))
        self.assertEqual(len(rows), 12)  # includes two claims as old startup reservations decay
        self.assertIn('launch_lag', decision['reason_codes'])
        self.assertEqual(self.decide(rows=rows, now=1300)['budget'], 5)

    def test_useful_finish_feedback_excludes_empty_failure_stale_and_batch_members(self):
        good = [row('finish', f'good-{i}', 990, empty=False, exit_code=0) for i in range(10)]
        ignored = [row('finish', f'empty-{i}', 990, empty=True, exit_code=0) for i in range(10)]
        ignored += [row('finish', 'failed', 990, empty=False, exit_code=1),
                    row('finish', 'unknown', 990, exit_code=0),
                    row('finish', 'stale', 699, empty=False, exit_code=0),
                    row('finish', 'future', 1001, empty=False, exit_code=0),
                    row('finish', 'member', 990, empty=False, exit_code=0, bundle='RQ-BATCH-X'),
                    row('finish', 'signal', 990, empty=False, exit_code=0, failure_class='EMPTY_SIGNAL')]
        cold = self.decide(20)
        fast = self.decide(20, rows=good + good + ignored)
        self.assertEqual((cold['budget'], fast['budget']), (3, 5))
        self.assertEqual((fast['useful_finishes_5m'], fast['empty_finishes_5m']), (10, 11))
        self.assertEqual(self.decide(20, rows=ignored)['budget'], cold['budget'])

    def test_finished_session_releases_reservation_but_older_finish_does_not(self):
        rows = [row('launch', 'same', 999), row('finish', 'same', 998)]
        self.assertGreater(self.decide(rows=rows)['warming_sessions'], 0)
        rows.append(row('finish', 'same', 1000, empty=True))
        self.assertEqual(self.decide(rows=rows)['warming_sessions'], 0)

    def test_timezone_and_malformed_timestamps(self):
        rows = [row('launch', 'valid', '1970-01-01T01:16:39+01:00'),
                row('launch', 'bad', 'nonsense'), row('launch', 'nan', float('nan')),
                row('launch', 'old-missing-lane', 600, lane=None)]
        decision = self.decide(rows=rows)
        self.assertAlmostEqual(decision['warming_sessions'], 119 / 120, places=3)
        json.dumps(decision, sort_keys=True, allow_nan=False)

    def test_processes_and_worktrees_slow_claims_without_new_hard_gate(self):
        base = gate(14)
        calm = pace(base, {'l': 32}, {'l': 0}, 32, [], 1000)
        for key, value in [('procs', 5000), ('worktrees', 80)]:
            busy = pace({**base, key: value}, {'l': 32}, {'l': 0}, 32, [], 1000)
            self.assertGreater(busy['budget'], 0)
            self.assertLess(busy['budget'], calm['budget'])
            self.assertIn('host_inventory_pressure', busy['reason_codes'])

    def test_cpu_scaling_and_probe_never_exceeds_estimated_hard_headroom(self):
        for cpus in (1, 9, 18, 36):
            for multiplier in (1, 2, 4):
                for load in (0, cpus, 1.8 * cpus, 1.88 * cpus):
                    g = {**gate(load), 'ncpu': cpus, 'load_max': 2 * cpus, 'procs': 2500 * multiplier}
                    decision = pace(g, {'l': 32}, {'l': 0}, 32, [], 1000)
                    self.assertLessEqual(load + decision['budget'] * decision['startup_cost'], g['load_max'])
        tight = {**gate(16.9), 'load_max': 18}
        self.assertEqual(pace(tight, {'l': 32}, {'l': 0}, 32, [], 1000)['budget'], 0)


class PacingTicks(unittest.TestCase):
    def fixture(self, lanes=('codex-personal', 'claude')):
        slots = held_lanes()
        for lane in lanes:
            slots[lane] = {'target': 16, 'floor': 0, 'ceiling': 16, 'hard_cap': 16, 'last_change': 10**15}
        tmp = build(slots=slots)
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve()
        launch_stubs(home)
        return home

    def run_tick(self, home, load=33):
        result = tick(home, {'LOADGATE_LOADAVG': str(load)})
        self.assertEqual(result.returncode, 0, result.stderr)
        return admission(home)['pacing']

    def test_tight_budget_does_not_starve_an_equally_urgent_lane(self):
        home = self.fixture()
        for i in range(8):
            queue_job(home, f'RQ-A-{i}', 'codex-personal')
        queue_job(home, 'RQ-Z-CLAUDE', 'claude')
        first = self.run_tick(home)
        self.assertEqual(first['budget'], 1)
        self.assertEqual(len(launched(home)), 1)
        # Finish the first session. The next tick must serve the other lane,
        # even though its row sorts after the continuing codex backlog.
        metrics = home / '.ashlr-runs/metrics/jobs.jsonl'
        job = launched(home)[0]
        with metrics.open('a') as stream:
            stream.write(json.dumps(row('finish', job, time.time(), empty=True, exit_code=0)) + '\n')
        (home / f'.ashlr-runs/queue/run/{job}.dispatched').unlink()
        self.run_tick(home)
        self.assertEqual(launched(home), ['RQ-A-0', 'RQ-Z-CLAUDE'])
        self.assertEqual(len(ready_left(home)), 7)
        records = [json.loads(line.split('LAUNCH_PACE ', 1)[1])
                   for line in events(home).splitlines() if 'LAUNCH_PACE ' in line]
        self.assertEqual(len(records), 2)
        self.assertIn('codex-personal', records[1]['last_launch'])
        status = json.loads((home / '.ashlr-runs/queue/status.json').read_text())
        self.assertEqual(status['lanes']['codex-personal']['running'], 0)
        self.assertEqual(status['admission']['pacing'], records[1])

    def test_priority_surfaces_before_fairness_and_held_lane_cannot_consume_budget(self):
        home = self.fixture()
        queue_job(home, 'RQ-A-NORMAL', 'codex-personal')
        queue_job(home, 'RQ-Z-URGENT', 'claude')
        q = home / '.ashlr-runs/queue'
        router = q / 'router-queue.md'
        router.write_text(router.read_text().replace('pool=claude', 'pool=claude, P0'))
        self.run_tick(home)
        self.assertEqual(launched(home), ['RQ-Z-URGENT'])
        blocked = self.fixture(('codex-personal',))
        queue_job(blocked, 'RQ-A-LOCAL-HELD', 'codex-local', tier='fast')
        queue_job(blocked, 'RQ-Z-RUNNABLE', 'codex-personal')
        self.run_tick(blocked)
        self.assertEqual(launched(blocked), ['RQ-Z-RUNNABLE'])
        self.assertEqual(len(ready_left(blocked)), 1)

    def test_warming_workers_block_next_tick_until_load_catches_up(self):
        home = self.fixture(('codex-personal',))
        for i in range(10):
            queue_job(home, f'RQ-PACE-{i}', 'codex-personal')
        self.run_tick(home, 30)
        self.assertEqual(len(launched(home)), 2)
        second = self.run_tick(home, 32)
        self.assertEqual(second['budget'], 0)
        self.assertEqual(len(launched(home)), 2)
        self.assertEqual(len(ready_left(home)), 8)
        self.assertIn('launch_lag', second['reason_codes'])
        self.assertFalse(admission(home)['admit'])
        self.assertIn('launch_pace', admission(home)['reason'])


if __name__ == '__main__':
    unittest.main()
