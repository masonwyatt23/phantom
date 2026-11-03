import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
spec = importlib.util.spec_from_file_location('must_split', Path(__file__).parents[1] / 'must_split.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class MustSplit(unittest.TestCase):
    def test_boundaries_all_pools_and_index_preserved(self):
        with tempfile.TemporaryDirectory() as root:
            def git(*args):
                return subprocess.check_output(['git', '-C', root, *args], stderr=subprocess.DEVNULL)
            git('init')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                'commit', '--allow-empty', '-m', 'base')
            base = git('rev-parse', 'HEAD').decode().strip()
            index = (Path(root) / '.git/index').read_bytes() if (Path(root) / '.git/index').exists() else None
            for pool in ('codex-bridge', 'claude', 'devin', 'claude-api', 'codex-local', 'future-pool'):
                for count, tag, blocked in ((801, '', True), (801, ', bet=bold', False), (800, '', False)):
                    with self.subTest(pool=pool, count=count, tag=tag):
                        (Path(root) / 'new.txt').write_text('line\n' * count)
                        line = f'RQ-X (pool={pool}{tag}): task mentions bet=bold in prose'
                        error = module.check(root, base, line)
                        self.assertEqual(bool(error), blocked)
                        if blocked:
                            self.assertIn('split', error)
                            self.assertIn('bet=bold', error)
            self.assertEqual((Path(root) / '.git/index').read_bytes() if (Path(root) / '.git/index').exists() else None, index)
            (Path(root) / 'new.txt').write_text('line\n' * 900)
            git('add', '.')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'worker')
            self.assertIsNotNone(module.check(root, base, 'RQ-X (pool=codex-bridge): task'))
            (Path(root) / 'new.txt').write_text('line\n' * 800)
            self.assertIsNone(module.check(root, base, 'RQ-X (pool=codex-bridge): task'))
            self.assertIsNotNone(module.check(root, 'missing-base', 'RQ-X (bet=bold): task'))
    def test_every_dispatch_pool_checked_before_reaper(self):
        source = (Path(__file__).parents[1] / 'dispatchd.py').read_text()
        self.assertLess(source.index('split_error = must_split_check'), source.index('subprocess.Popen(["/bin/bash", R + "/bin/reap-one.sh"'))
if __name__ == '__main__':
    unittest.main()
