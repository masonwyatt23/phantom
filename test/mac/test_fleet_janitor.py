"""Hermetic recovery tests; no live fleet, launchd or process signals."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

MAC = Path(__file__).resolve().parents[2] / 'contrib/mac'
sys.path.insert(0, str(MAC))
SPEC = importlib.util.spec_from_file_location('fleet_janitor', MAC / 'fleet_janitor.py')
janitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(janitor)


ORIGINAL_LOOPS = janitor.Janitor.loops


class JanitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.root = self.home / '.ashlr-runs'
        self.run = self.root / 'queue/run'
        for path in (self.run, self.root / 'metrics', self.root / 'queue/batches', self.home / '.ashlr'):
            path.mkdir(parents=True, exist_ok=True)
        (self.root / 'queue/dispatchd.tick.lock').touch()
        (self.root / 'metrics/jobs.jsonl').touch()
        self.pruner = janitor.load_pruner()
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {'ASHLR_JOB_MAX_RUNTIME_S': '7200'}).start()
        patch.object(janitor, 'load_pruner', return_value=self.pruner).start()
        patch.object(self.pruner, 'process_cwds', return_value=[]).start()
        self.snapshot = patch.object(janitor.process_snapshot, 'capture', return_value=subprocess.CompletedProcess([], 0, '1 init\n', '')).start()
        patch.object(janitor.Janitor, 'loops').start()

    def job(self, job='J1'):
        wt = self.home / 'Projects/ashlrai/wt' / job
        wt.mkdir(parents=True)
        for file, text in ((self.run / (job + '.line'), job + '\tphantom\tcodex-personal'),
                           (self.run / (job + '.dispatched'), str(time.time() - 10000)),
                           (self.root / (job + '.base'), 'repo branch ' + str(wt) + ' sha')):
            file.write_text(text)
            os.utime(file, (time.time() - 10000,) * 2)
        return wt

    def execute(self, apply=False, allow=('jobs', 'sessions', 'worktrees')):
        return janitor.Janitor(self.home, apply, allow).run()

    def audit(self):
        return [json.loads(s) for s in (self.root / 'metrics/jobs.jsonl').read_text().splitlines()]

    def test_dry_run_is_read_only(self):
        self.job()
        before = sorted(str(p.relative_to(self.home)) for p in self.home.rglob('*'))
        report = self.execute()
        self.assertEqual(report['actions'][0]['status'], 'planned')
        self.assertEqual(self.audit(), [])
        self.assertEqual(before, sorted(str(p.relative_to(self.home)) for p in self.home.rglob('*')))

    def test_dead_job_is_expired_with_audit_and_idempotency(self):
        self.job()
        report = self.execute(True)
        self.assertEqual((self.run / 'J1.rc').read_text(), '124\n')
        self.assertEqual(report['actions'][0]['status'], 'done')
        self.assertEqual([r['status'] for r in self.audit()], ['intent', 'done'])
        self.assertEqual(self.audit()[1]['job'], 'J1')
        self.assertEqual(self.execute(True)['actions'], [])

    def test_unknown_or_live_owner_cannot_expire(self):
        wt = self.job()
        self.snapshot.return_value.returncode = 1
        self.assertEqual(self.execute(True)['phases'][0]['status'], 'unavailable')
        self.snapshot.return_value.returncode = 0
        self.pruner.process_cwds.return_value = [wt]
        self.assertEqual(self.execute(True)['actions'], [])
        self.assertFalse((self.run / 'J1.rc').exists())

    def test_kill_switch_and_class_gate(self):
        self.job()
        self.assertEqual(self.execute(True, ())['actions'][0]['status'], 'gated')
        (self.home / '.ashlr/KILL').touch()
        with self.assertRaises(ValueError):
            self.execute(True)
        self.assertFalse((self.run / 'J1.rc').exists())

    def test_ledger_failure_prevents_reap(self):
        self.job()
        with patch.object(janitor.os, 'fsync', side_effect=OSError()):
            self.execute(True)
        self.assertFalse((self.run / 'J1.rc').exists())

    def test_ledger_symlink_is_refused(self):
        ledger = self.root / 'metrics/jobs.jsonl'
        ledger.unlink()
        ledger.symlink_to(self.home / 'outside')
        with self.assertRaises(OSError):
            self.execute(True)
        self.assertFalse((self.home / 'outside').exists())

    def test_runtime_revalidates_pid_and_uses_private_group(self):
        self.job()
        self.snapshot.return_value.stdout = f'444 {self.root}/bin/launch.sh J1 phantom\n'
        with patch.object(janitor.Janitor, 'command', return_value=f'start {self.root}/bin/launch.sh J1 phantom'), patch.object(janitor.os, 'getpgid', return_value=444), patch.object(janitor.os, 'killpg') as kill:
            report = self.execute(True)
        kill.assert_called_once_with(444, signal.SIGTERM)
        self.assertEqual(report['actions'][0]['action'], 'terminate-runtime')
        self.assertEqual((self.run / 'J1.rc').read_text(), '124\n')

    def test_pid_reuse_never_signals(self):
        self.job()
        self.snapshot.return_value.stdout = f'444 {self.root}/bin/launch.sh J1 phantom\n'
        with patch.object(janitor.Janitor, 'command', side_effect=[f'start {self.root}/bin/launch.sh J1 phantom', 'start B']), patch.object(janitor.os, 'killpg') as kill:
            self.execute(True)
        kill.assert_not_called()
        self.assertFalse((self.run / 'J1.rc').exists())

    def test_runtime_configuration_matches_watchdog(self):
        self.assertEqual(janitor.runtime_limit({'x': {'max_runtime_s': 0}}, 'x'), 0)
        self.assertEqual(janitor.runtime_limit({'max_runtime_s': 1}, 'x'), 300)
        self.assertEqual(janitor.runtime_limit({}, 'x'), 7200)

    def test_expired_batch_session_release(self):
        (self.run / 'J1.batched').write_text('RQ-BATCH-1')
        (self.root / 'queue/batches/RQ-BATCH-1.json').write_text(json.dumps({'schema': 'dispatchd.batch.v1', 'members': [{'job': 'J1'}], 'reaped': time.time() - 3600}))
        report = self.execute(True)
        self.assertFalse((self.run / 'J1.batched').exists())
        self.assertEqual(report['actions'][0]['class'], 'sessions')
        self.assertEqual(self.audit()[-1]['status'], 'done')

    def test_deadline_is_reported(self):
        report = janitor.Janitor(self.home, budget=0).run()
        self.assertTrue(any(p['status'] == 'deadline' for p in report['phases']))

    def test_phase_deadline_escapes_per_job_handlers(self):
        self.job()
        with patch.object(janitor.Janitor, 'command', side_effect=janitor.Deadline()):
            self.snapshot.return_value.stdout = f'444 {self.root}/bin/launch.sh J1 phantom\n'
            report = self.execute(True)
        self.assertEqual(report['phases'][0]['status'], 'deadline')
        self.assertFalse((self.run / 'J1.rc').exists())

    def test_recent_progress_and_publisher_are_kept(self):
        self.job()
        (self.run / 'J1.heartbeat').touch()
        self.assertEqual(self.execute(True)['actions'], [])
        (self.run / 'J1.heartbeat').unlink()
        (self.run / 'J1.reaping').mkdir()
        self.assertEqual(self.execute(True)['actions'], [])

    def test_runtime_escalation_waits_for_grace(self):
        self.job()
        self.snapshot.return_value.stdout = f'444 {self.root}/bin/launch.sh J1 phantom\n'
        (self.run / 'J1.maxruntime').touch()
        identity = f'start {self.root}/bin/launch.sh J1 phantom'
        with patch.object(janitor.Janitor, 'command', return_value=identity), patch.object(janitor.os, 'getpgid', return_value=444), patch.object(janitor.os, 'killpg') as kill:
            self.execute(True)
            kill.assert_not_called()
            os.utime(self.run / 'J1.maxruntime', (time.time() - 40,) * 2)
            self.execute(True)
            kill.assert_called_once_with(444, signal.SIGKILL)

    def test_busy_dispatcher_lock_is_never_stolen(self):
        import fcntl
        with (self.root / 'queue/dispatchd.tick.lock').open() as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.execute(True)
        self.assertEqual(self.audit(), [])

    def test_failed_loop_uses_fixed_non_killing_kickstart(self):
        worker = janitor.Janitor(self.home)
        # Use the original method because the suite replaces live launchd access.
        with patch.object(worker, 'command', return_value=f'program = {self.root}/bin/dispatchd.sh\nlast exit code = 78'):
            ORIGINAL_LOOPS(worker, None, None, None)
        self.assertEqual(worker.report['actions'][0]['action'], 'kickstart-dispatcher')
        worker.report['actions'].clear()
        with patch.object(worker, 'command', return_value='program = /unrelated/script\nlast exit code = 78'):
            with self.assertRaises(ValueError):
                ORIGINAL_LOOPS(worker, None, None, None)
        self.assertEqual(worker.report['actions'], [])

    def test_real_phase_alarm_bounds_a_hung_stage(self):
        worker = janitor.Janitor(self.home, budget=.05)
        with patch.object(worker, 'jobs', side_effect=lambda *_: time.sleep(10)):
            started = time.monotonic()
            report = worker.run()
        self.assertLess(time.monotonic() - started, .5)
        self.assertEqual(report['phases'][0]['status'], 'deadline')

    def test_changed_lease_cannot_be_released_after_audit(self):
        marker = self.run / 'J1.batched'
        marker.write_text('RQ-BATCH-1')
        (self.root / 'queue/batches/RQ-BATCH-1.json').write_text(json.dumps({'schema': 'dispatchd.batch.v1', 'members': [{'job': 'J1'}], 'reaped': time.time() - 3600}))
        original = janitor.Janitor.audit
        def race(worker, row, status):
            original(worker, row, status)
            if status == 'intent':
                marker.write_text('RQ-BATCH-2')
        with patch.object(janitor.Janitor, 'audit', new=race):
            report = self.execute(True)
        self.assertEqual(marker.read_text(), 'RQ-BATCH-2')
        self.assertEqual(report['actions'][0]['status'], 'uncertain')

    def test_merged_clean_worktree_is_removed(self):
        repo = self.home / 'repo'
        repo.mkdir()
        def git(*args):
            return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
        git('init')
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init')
        wt = self.home / 'Projects/ashlrai/wt/J1'
        wt.parent.mkdir(parents=True)
        git('worktree', 'add', '-b', 'test', str(wt))
        ts = janitor.datetime.datetime.fromtimestamp(time.time() - 90000, janitor.datetime.timezone.utc).isoformat()
        ledger = self.root / 'metrics/jobs.jsonl'
        ledger.write_text(json.dumps({'job': 'J1', 'event': 'finish', 'ts': ts}) + '\n' + json.dumps({'job': 'J1', 'event': 'outcome', 'state': 'MERGED'}) + '\n')
        (wt / 'local.txt').write_text('untracked work')
        self.assertEqual(self.execute(True)['actions'], [])
        self.assertTrue(wt.exists())
        (wt / 'local.txt').unlink()
        pins = self.home / '.ashlr/kept-worktrees.json'
        pins.write_text(json.dumps([str(wt)]))
        self.assertEqual(self.execute(True)['actions'], [])
        pins.write_text('malformed')
        self.assertEqual(self.execute(True)['phases'][2]['status'], 'unavailable')
        pins.unlink()
        # The host denies creating .env even in fixtures; simulate tracked protected content.
        with patch.object(janitor.os, 'walk', return_value=[(str(wt), ['models'], [])]):
            self.assertEqual(self.execute(True)['actions'], [])
        for protected in ('.env', '.codex-2', 'id_ed25519', 'weights.gguf', 'auth.json', 'Documents'):
            self.assertIsNotNone(janitor.PROTECTED.fullmatch(protected))
        report = self.execute(True)
        self.assertFalse(wt.exists(), report)
        self.assertEqual(report['actions'][0]['action'], 'worktree-remove')


if __name__ == '__main__':
    unittest.main()
