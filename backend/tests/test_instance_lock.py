"""One PrismLCA per data directory — the guard, not the symptom.

The symptom was: two backends on one Brightway directory, SQLite answering the loser with
"database is locked" at an arbitrary moment, and one of those moments being the write that puts a
scenario's overrides *back* after a report render. The study's baseline silently stayed the
scenario. `scenarios._restore` defends that one write; this stops the situation.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap

from prism_lca.engine import instance_lock


def test_the_first_caller_gets_the_directory_and_the_second_is_told_who_has_it(tmp_path):
    assert instance_lock.acquire(tmp_path) is None
    try:
        # Same process re-entering is not a second instance.
        assert instance_lock.acquire(tmp_path) is None
        # A *different* process is. Run one, and let it report what it found.
        script = textwrap.dedent(
            f"""
            import json
            from prism_lca.engine import instance_lock
            print(json.dumps(instance_lock.acquire({str(tmp_path)!r})))
            """
        )
        # The child imports prism_lca the same way this process did — no path guessing.
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)}
        out = subprocess.run(
            [sys.executable, "-c", script], capture_output=True, text=True, timeout=60, env=env
        )
        assert out.returncode == 0, out.stderr
        holder = json.loads(out.stdout.strip())
        assert holder is not None, "a second process must not get the same directory"
        # It names who has it, so the message can say so.
        assert holder["pid"] == os.getpid()
        assert holder["path"].endswith(instance_lock.LOCK_NAME)
    finally:
        instance_lock.release()


def test_releasing_hands_the_directory_on(tmp_path):
    assert instance_lock.acquire(tmp_path) is None
    instance_lock.release()
    # And it can be taken again — by this process or any other.
    assert instance_lock.acquire(tmp_path) is None
    instance_lock.release()


def test_a_directory_that_cannot_be_locked_does_not_stop_a_start(tmp_path, monkeypatch):
    """Refusing to run because we could not *check* would turn a guard into an outage."""
    monkeypatch.setattr(instance_lock, "_lock_exclusive", lambda handle: True)
    unwritable = tmp_path / "nope"
    monkeypatch.setattr(
        instance_lock.Path, "mkdir", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only"))
    )
    assert instance_lock.acquire(unwritable) is None
    instance_lock.release()


def test_two_different_directories_do_not_block_each_other(tmp_path):
    """The lock guards a data directory, not the machine — a developer runs several checkouts."""
    a, b = tmp_path / "a", tmp_path / "b"
    assert instance_lock.acquire(a) is None
    instance_lock.release()
    assert instance_lock.acquire(b) is None
    instance_lock.release()
