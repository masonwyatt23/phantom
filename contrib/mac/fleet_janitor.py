#!/usr/bin/env python3
"""Bounded deterministic fleet recovery. Dry-run unless --apply; no publishing."""
import argparse
import contextlib
import datetime
import fcntl
import importlib.util
import hashlib
from functools import lru_cache
import json
import math
import os
from pathlib import Path
import re
import subprocess
import signal
import stat
import sys
import time

# A report-only pass must not populate bytecode caches in the managed bin directory.
sys.dont_write_bytecode = True
import process_snapshot

JOB = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z')
# Same protected classes as disk-maint; janitor never opts into gated classes.
PROTECTED = re.compile(
    r'^(?:\.codex.*|\.ssh|\.gnupg.*|\.aws|\.kube|\.docker|\.env.*|\.?netrc|'
    r'keychains|secrets?|credentials.*|tokens?.*|auth\.json|config\.toml|'
    r'id_(?:rsa|dsa|ecdsa|ed25519).*|'
    r'.*\.(?:pem|key|p12|pfx|keystore|kdbx|asc|gpg|gguf|safetensors|ckpt|onnx|coreml)|'
    r'models.*|checkpoints.*|huggingface|hf[_-]?hub.*|ollama|lm[_-]?studio.*|omlx|'
    r'mlx[_-]?models.*|Documents|Library|dhs.*|rde.*|client.*work.*)$', re.I)


class AuditFailure(Exception):
    """An unrecordable action stops the entire pass."""


class Deadline(Exception):
    """Phase cancellation must escape per-item IO refusal handlers."""


def expired(*_):
    raise Deadline()


@lru_cache(maxsize=1)
def load_pruner():
    spec = importlib.util.spec_from_file_location('janitor_pruner', Path(__file__).with_name('wt-prune.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read(fd, name, limit=1024 * 1024, tail=False):
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(child)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022 or (info.st_size > limit and not tail):
            raise ValueError('unsafe-file')
        start = max(0, info.st_size - limit) if tail else 0
        os.lseek(child, start, os.SEEK_SET)
        data = os.read(child, limit + 1)
        if start:
            data = data.partition(b'\n')[2]
        if len(data) > limit:
            raise ValueError('oversized-file')
        return data.decode(), info
    finally:
        os.close(child)


def exists(fd, name):
    try:
        os.stat(name, dir_fd=fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def runtime_limit(slots, lane):
    local = slots.get(lane, {})
    for value in (local.get('max_runtime_s') if isinstance(local, dict) else None,
                  slots.get('max_runtime_s'), os.environ.get('ASHLR_JOB_MAX_RUNTIME_S'), 7200):
        try:
            number = float(value)
            if math.isfinite(number) and number >= 0:
                return 0 if number == 0 else max(300, number)
        except (ValueError, TypeError):
            pass


class Janitor:
    def __init__(self, home, apply=False, allow=(), budget=30):
        self.home, self.apply, self.allow = Path(home), apply, set(allow)
        if not self.home.is_absolute() or self.home.resolve() != self.home:
            raise ValueError('noncanonical-home')
        self.root = self.home / '.ashlr-runs'
        self.now, self.end = time.time(), time.monotonic() + budget
        self.report = {'schema': 'fleet.janitor.v1', 'apply': apply, 'actions': [], 'phases': []}
        self.ledger = None
        self.metrics = None

    def command(self, args):
        remaining = self.end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, start_new_session=True)
        try:
            stdout, _ = child.communicate(timeout=min(5, remaining))
            if child.returncode:
                raise ValueError('command-unavailable')
            return stdout
        except BaseException as error:
            # Phase interruption must not leave Git or launchctl running after the deadline.
            try:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=.1)
            except (OSError, subprocess.TimeoutExpired):
                pass
            if isinstance(error, subprocess.TimeoutExpired):
                raise ValueError('command-deadline') from None
            raise
        finally:
            child.stdout.close()
            child.stderr.close()

    def audit(self, row, status):
        record = dict(row, schema='fleet.janitor-action.v1', event='janitor', status=status,
                      ts=datetime.datetime.now(datetime.timezone.utc).isoformat())
        if self.apply:
            data = (json.dumps(record, allow_nan=False) + '\n').encode()
            try:
                if os.write(self.ledger, data) != len(data):
                    raise OSError('short-audit-write')
                os.fsync(self.ledger)
                current = os.stat('jobs.jsonl', dir_fd=self.metrics, follow_symlinks=False)
                opened = os.fstat(self.ledger)
                if opened.st_nlink != 1 or (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                    raise OSError('ledger-replaced')
            except OSError:
                raise AuditFailure() from None

    def act(self, job, cls, action, evidence, operation):
        row = dict(job=job, **{'class': cls}, action=action, evidence=evidence)
        row['action_id'] = hashlib.sha256(json.dumps([self.now, row], sort_keys=True).encode()).hexdigest()[:24]
        row['status'] = 'planned' if not self.apply else 'gated' if cls not in self.allow else 'pending'
        self.report['actions'].append(row)
        if row['status'] != 'pending':
            return
        if time.monotonic() >= self.end or os.path.lexists(self.home / '.ashlr/KILL'):
            row['status'] = 'held'
            return
        self.audit(row, 'intent')  # Failure to persist evidence prevents the action.
        try:
            operation()
            row['status'] = 'done'
        except Deadline:
            row['status'] = 'uncertain'
            self.audit(row, row['status'])
            raise
        except (OSError, ValueError, load_pruner().Hold):
            row['status'] = 'uncertain'
        self.audit(row, row['status'])

    def create(self, directory, name, data):
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)

    def jobs(self, rootfd, queuefd, runfd):
        snapshot = process_snapshot.capture(timeout=min(3, max(.1, self.end - time.monotonic())))
        if snapshot.returncode:
            raise ValueError('ownership-unknown')
        commands = snapshot.stdout.splitlines()
        pruner = load_pruner()
        cwds = pruner.process_cwds()
        try:
            slots = json.loads(read(queuefd, 'slots.json')[0])
            if not isinstance(slots, dict):
                raise ValueError('invalid-slots')
        except FileNotFoundError:
            slots = {}
        for name in sorted(os.listdir(runfd))[:4000]:
            if time.monotonic() >= self.end:
                raise TimeoutError()
            if not name.endswith('.line') or not JOB.fullmatch(name[:-5]):
                continue
            try:
                self.job(name[:-5], commands, pruner, cwds, slots, rootfd, runfd)
            except (OSError, ValueError, pruner.Hold):
                self.report['skipped_jobs'] = self.report.get('skipped_jobs', 0) + 1

    def job(self, job, commands, pruner, cwds, slots, rootfd, runfd):
        if any(exists(runfd, job + suffix) for suffix in ('.fin', '.reaping')):
            return
        if exists(runfd, job + '.rc') and not exists(runfd, job + '.maxruntime'):
            return
        _, receipt = read(runfd, job + '.dispatched')
        line, lineinfo = read(runfd, job + '.line')
        if receipt.st_mtime < lineinfo.st_mtime - 2:
            raise ValueError('stale-dispatch-receipt')
        lane = (line.split('\t') + ['', '', ''])[2].strip()
        elapsed = self.now - receipt.st_mtime
        limit = runtime_limit(slots, lane)
        # A wrapper must be an exact argv token from this fleet's bin.
        wrapper = re.compile(r'(?:^|\s)' + re.escape(str(self.root / 'bin')) + r'/(?:launch\.sh|local_job\.py)\s+' + re.escape(job) + r'(?:\s|$)')
        leaders = [int(c.split(None, 1)[0]) for c in commands if wrapper.search(c)]
        if leaders and limit and elapsed >= limit:
            for pid in leaders:
                identity = self.command(['ps', '-p', str(pid), '-o', 'lstart=,command='])
                if not wrapper.search(identity):
                    raise ValueError('wrapper-changed')
                escalation = False
                if exists(runfd, job + '.maxruntime'):
                    mark, info = read(runfd, job + '.maxruntime', 32)
                    if mark or self.now - info.st_mtime < 30:
                        continue
                    escalation = True
                def terminate(pid=pid, identity=identity, escalation=escalation):
                    if self.command(['ps', '-p', str(pid), '-o', 'lstart=,command=']) != identity:
                        raise ValueError('pid-reused')
                    if pid <= 1 or pid == os.getpid() or os.getpgid(pid) != pid or pid == os.getpgrp():
                        raise ValueError('not-private-group')
                    if not exists(runfd, job + '.rc'):
                        self.create(runfd, job + '.rc', b'124\n')
                    if not exists(runfd, job + '.maxruntime'):
                        self.create(runfd, job + '.maxruntime', b'')
                    os.killpg(pid, signal.SIGKILL if escalation else signal.SIGTERM)
                self.act(job, 'jobs', 'kill-runtime' if escalation else 'terminate-runtime', {'pid': pid, 'elapsed_s': elapsed, 'limit_s': limit}, terminate)
            return  # Same rc/timeout receipts as the dispatchd watchdog.
        if exists(runfd, job + '.rc'):
            return
        # Quietness is corroboration; zero CPU alone never authorizes a reap.
        times = [receipt.st_mtime]
        for directory, suffix in ((rootfd, '.log'), (rootfd, '.launch'), (rootfd, '.base'), (rootfd, '.heartbeat'), (runfd, '.heartbeat')):
            try:
                info = os.stat(job + suffix, dir_fd=directory, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError('unsafe-progress-marker')
                times.append(info.st_mtime)
            except FileNotFoundError:
                pass
        quiet = self.now - max(times)
        possible_owner = any(re.search(r'(?<![\w.-])' + re.escape(job) + r'(?![\w.-])', c) for c in commands)
        base, _ = read(rootfd, job + '.base')
        fields = base.split()
        if len(fields) < 4 or not Path(fields[2]).is_absolute():
            raise ValueError('worktree-unknown')
        worktree = Path(fields[2]).resolve(strict=True)
        if quiet < 1800 or possible_owner or any(pruner.inside(c, worktree) for c in cwds):
            return
        def expire():
            # Dispatcher tick lock is held; exclusive creation cannot overwrite a finish.
            _, current = read(runfd, job + '.dispatched')
            if (current.st_ino, current.st_mtime_ns) != (receipt.st_ino, receipt.st_mtime_ns):
                raise ValueError('attempt-changed')
            if any(exists(runfd, job + suffix) for suffix in ('.fin', '.reaping', '.batched')):
                raise ValueError('owner-changed')
            latest = process_snapshot.capture(timeout=1)
            if latest.returncode or re.search(r'(?<![\w.-])' + re.escape(job) + r'(?![\w.-])', latest.stdout):
                raise ValueError('owner-unknown-or-live')
            if any(pruner.inside(c, worktree) for c in pruner.process_cwds()):
                raise ValueError('live-cwd')
            self.create(runfd, job + '.rc', b'124\n')
        self.act(job, 'jobs', 'expire-dead-job', {'quiet_s': quiet, 'live': False, 'cwd_live': False}, expire)

    def sessions(self, rootfd, queuefd, runfd):
        with load_pruner().opened(self.root / 'queue/batches') as batches:
            for name in sorted(os.listdir(runfd))[:4000]:
                if not name.endswith('.batched') or not JOB.fullmatch(name[:-8]):
                    continue
                raw, lease = read(runfd, name, 256)
                bundle = raw.strip()
                if not JOB.fullmatch(bundle) or not bundle.startswith('RQ-BATCH-'):
                    continue
                manifest = json.loads(read(batches, bundle + '.json')[0])
                if not isinstance(manifest, dict) or manifest.get('schema') != 'dispatchd.batch.v1' or not isinstance(manifest.get('members'), list):
                    continue
                if not any(isinstance(m, dict) and m.get('job') == name[:-8] for m in manifest['members']):
                    continue
                reaped = manifest.get('reaped')
                if type(reaped) not in (int, float) or not math.isfinite(reaped) or not 0 < reaped < self.now - 1800:
                    continue
                def release():
                    current, info = read(runfd, name, 256)
                    if current != raw or (info.st_ino, info.st_mtime_ns) != (lease.st_ino, lease.st_mtime_ns):
                        raise ValueError('lease-changed')
                    os.unlink(name, dir_fd=runfd)
                self.act(name[:-8], 'sessions', 'release-expired-batch', {'bundle': bundle, 'reaped_at': reaped}, release)

    def worktrees(self, rootfd, queuefd, runfd):
        pruner = load_pruner()
        cwds = pruner.process_cwds()
        with pruner.opened(self.home / '.ashlr') as policyfd:
            try:
                pins = json.loads(read(policyfd, 'kept-worktrees.json')[0])
            except FileNotFoundError:
                pins = []
        if not isinstance(pins, list) or any(not isinstance(p, str) or not Path(p).is_absolute() for p in pins):
            raise ValueError('invalid-pins')
        with pruner.opened(self.root / 'metrics') as metrics:
            ledger = read(metrics, 'jobs.jsonl', 8 * 1024 * 1024, tail=True)[0]
        jobs = {}
        for line in ledger.splitlines():
            try:
                row = json.loads(line)
                job = row.get('job', row.get('job_id', row.get('id')))
                if not isinstance(job, str) or not JOB.fullmatch(job):
                    continue
                event = row.get('event')
                if event == 'launch':
                    jobs.pop(job, None)
                elif event in ('finish', 'outcome'):
                    jobs.setdefault(job, {})[event] = row
            except (ValueError, AttributeError):
                continue
        for parent in (self.root / 'wt', self.home / 'Projects/ashlrai/wt'):
            if not parent.exists():
                continue
            with pruner.opened(parent) as parentfd:
                for job in sorted(os.listdir(parentfd))[:2000]:
                    if time.monotonic() >= self.end:
                        raise TimeoutError()
                    wt = parent / job
                    if not JOB.fullmatch(job) or job.startswith('guardian-') or any(PROTECTED.fullmatch(p) for p in wt.parts):
                        continue
                    record = jobs.get(job, {})
                    outcome, finish = record.get('outcome', {}), record.get('finish', {})
                    state = outcome.get('state', outcome.get('outcome'))
                    if str(state).lower() != 'merged' and not (parent == self.root / 'wt' and state is None and finish.get('empty') is True):
                        continue
                    try:
                        if not isinstance(finish.get('ts'), str):
                            continue
                        finished = datetime.datetime.fromisoformat(finish['ts'].replace('Z', '+00:00')).timestamp()
                        if not math.isfinite(finished) or self.now - finished < 86400 or finished < 0:
                            continue
                        if any(pruner.inside(wt, Path(p)) or pruner.inside(Path(p), wt) for p in pins):
                            continue
                        def validate(current_cwds):
                            if wt.resolve() != wt or not stat.S_ISDIR(os.stat(job, dir_fd=parentfd, follow_symlinks=False).st_mode):
                                raise ValueError('linked-worktree')
                            with pruner.opened(self.home / '.ashlr') as policyfd:
                                try:
                                    current = json.loads(read(policyfd, 'kept-worktrees.json')[0])
                                except FileNotFoundError:
                                    current = []
                                if current != pins:
                                    raise ValueError('pins-changed')
                            pruner.no_claim(self.root, wt)
                            pruner.no_live_cwd(wt, current_cwds)
                            if any(exists(runfd, job + s) for s in ('.reaping', '.batched')) or (exists(runfd, job + '.dispatched') and not any(exists(runfd, job + s) for s in ('.rc', '.fin'))):
                                raise ValueError('active-job')
                            if self.command(['git', '-C', str(wt), 'status', '--porcelain=v1', '--ignored']):
                                raise ValueError('dirty-or-ignored-files')
                            # A quiet terminal Git tree still cannot contain protected data.
                            def unreadable(error):
                                raise error
                            for directory, names, files in os.walk(wt, followlinks=False, onerror=unreadable):
                                if any(PROTECTED.fullmatch(n) for n in names + files):
                                    raise ValueError('protected-descendant')
                        validate(cwds)
                        def remove():
                            try:
                                with pruner.lease(self.root, wt):
                                    validate(pruner.process_cwds())
                                    self.command(['git', '-C', str(wt), 'worktree', 'remove', '--', str(wt)])
                            except pruner.Hold:
                                raise ValueError('ownership-held') from None
                        self.act(job, 'worktrees', 'worktree-remove', {'finished_at': finished, 'ttl_s': 86400, 'terminal': str(state), 'root': 'runs' if parent == self.root / 'wt' else 'jobs'}, remove)
                    except (OSError, ValueError, KeyError, TypeError, pruner.Hold):
                        continue

    def loops(self, rootfd, queuefd, runfd):
        # Recognize only a service actually enrolled for this fleet's dispatcher.
        enrolled = False
        script = re.escape(str(self.root / 'bin/dispatchd')) + r'\.(?:sh|py)'
        for label in ('ai.ashlr.dispatchd', 'com.ashlr.dispatchd'):
            service = 'gui/%d/%s' % (os.getuid(), label)
            try:
                text = self.command(['launchctl', 'print', service])
            except ValueError:
                continue
            if not re.search(r'^\s*(?:program = )?' + script + r'\s*$', text, re.M):
                continue
            enrolled = True
            if re.search(r'^\s*pid = [1-9][0-9]*$', text, re.M):
                continue
            if re.search(r'^\s*last (?:exit code|terminating signal) = [1-9][0-9]*$', text, re.M):
                self.act(None, 'loops', 'kickstart-dispatcher', {'service': label, 'live': False},
                         lambda service=service: self.command(['launchctl', 'kickstart', service]))
        if not enrolled:
            raise ValueError('loop-enrollment-unknown')

    def run(self):
        pruner = load_pruner()
        with contextlib.ExitStack() as stack:
            rootfd = stack.enter_context(pruner.opened(self.root))
            queuefd = stack.enter_context(pruner.opened(self.root / 'queue'))
            runfd = stack.enter_context(pruner.opened(self.root / 'queue/run'))
            for directory in (rootfd, queuefd, runfd):
                info = os.fstat(directory)
                if info.st_uid != os.getuid() or info.st_mode & 0o022:
                    raise ValueError('unsafe-directory')
            if self.apply:
                if os.path.lexists(self.home / '.ashlr/KILL'):
                    raise ValueError('kill-switch')
                lock = os.open('dispatchd.tick.lock', os.O_RDWR | os.O_NOFOLLOW, dir_fd=queuefd)
                stack.callback(os.close, lock)
                info = os.fstat(lock)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022:
                    raise ValueError('unsafe-lock')
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                metrics = stack.enter_context(pruner.opened(self.root / 'metrics'))
                self.metrics = metrics
                info = os.fstat(metrics)
                if info.st_uid != os.getuid() or info.st_mode & 0o022:
                    raise ValueError('unsafe-metrics-directory')
                self.ledger = os.open('jobs.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=metrics)
                stack.callback(os.close, self.ledger)
                info = os.fstat(self.ledger)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o022:
                    raise ValueError('unsafe-ledger')
            for phase in ('jobs', 'sessions', 'worktrees', 'loops'):
                if phase == 'loops' and self.apply:
                    fcntl.flock(lock, fcntl.LOCK_UN)
                started = time.monotonic()
                entry = {'phase': phase, 'status': 'complete'}
                self.report['phases'].append(entry)
                if started >= self.end:
                    entry.update(status='deadline', elapsed_s=0)
                    continue
                previous = signal.signal(signal.SIGALRM, expired)
                signal.setitimer(signal.ITIMER_REAL, max(.001, min(10, self.end - started)))
                try:
                    getattr(self, phase)(rootfd, queuefd, runfd)
                except AuditFailure:
                    entry['status'] = 'audit-unavailable'
                    break
                except Deadline:
                    entry['status'] = 'deadline'
                except (OSError, ValueError, pruner.Hold):
                    entry['status'] = 'unavailable' if time.monotonic() < min(started + 10, self.end) else 'deadline'
                finally:
                    signal.setitimer(signal.ITIMER_REAL, 0)
                    signal.signal(signal.SIGALRM, previous)
                    entry['elapsed_s'] = round(time.monotonic() - started, 3)
        return self.report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--allow', action='append', choices=('jobs', 'sessions', 'worktrees', 'loops'), default=[])
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    try:
        report = Janitor(args.home, args.apply, args.allow).run()
    except (OSError, ValueError):
        report = {'schema': 'fleet.janitor.v1', 'error': 'custody-unavailable'}
    print(json.dumps(report))
    return 1 if 'error' in report or any(p['status'] != 'complete' for p in report.get('phases', [])) or any(a['status'] == 'uncertain' for a in report.get('actions', [])) else 0


if __name__ == '__main__':
    raise SystemExit(main())
