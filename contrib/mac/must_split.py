"""Pool-independent pre-publication diff limit. Never changes the real index."""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
def check(worktree, base, line):
    """Return a constant actionable refusal, or None. Unknown size fails closed."""
    try:
        with tempfile.TemporaryDirectory(prefix="must-split-") as tmp:
            env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
            env.update(GIT_INDEX_FILE=str(Path(tmp) / "index"),
                       GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null")
            def git(*args):
                return subprocess.run(
                    ["git", "-C", worktree, "-c", "core.hooksPath=/dev/null",
                     "-c", "core.fsmonitor=false", *args], env=env,
                    capture_output=True, check=True, timeout=60).stdout
            git("read-tree", "HEAD")
            git("add", "-A")
            stats = git("diff", "--cached", "--numstat", "-z", "--no-renames",
                        "--no-ext-diff", "--no-textconv", base, "--")
            net = 0
            for row in stats.split(b"\0"):
                if not row:
                    continue
                added, deleted, _ = row.split(b"\t", 2)
                if added == deleted == b"-":
                    continue  # Binary files have no line count.
                net += int(added) - int(deleted)
    except (OSError, ValueError, subprocess.SubprocessError):
        return "must-split: diff unavailable; restore the job base and retry before opening a PR"
    # Only the queue metadata grants the exception, never prose mentioning the tag.
    bold = re.search(r"^[^\n(]+\([^()\n]*\bbet=bold\s*(?:,|\))", line)
    if net > 800 and not bold:
        return "must-split: over +800 net lines; split into jobs of at most +800 net each, or set bet=bold in the job metadata before opening a PR"
    return None
if __name__ == "__main__":
    try:
        message = check(sys.argv[1], sys.argv[2], Path(sys.argv[3]).read_text())
    except (OSError, IndexError):
        message = "must-split: job metadata unavailable; restore the job line and retry"
    if message:
        print(message, file=sys.stderr)
        sys.exit(1)
