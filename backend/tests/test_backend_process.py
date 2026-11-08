"""The helper that starts the backend as a child process keeps its deadlines (tests/backend_process.py)."""
from __future__ import annotations

import time

import pytest
from backend_process import spawn, stop, wait_for_start


def test_a_silent_child_fails_the_wait_at_its_deadline_instead_of_holding_the_run():
    proc = spawn({}, frozen=False, prelude="import time; time.sleep(600)")
    try:
        started = time.monotonic()
        with pytest.raises(AssertionError, match="no output within"):
            wait_for_start(proc, timeout=2)
        assert time.monotonic() - started < 30
    finally:
        stop(proc)
    assert proc.poll() is not None


def test_stderr_is_collected_while_the_child_runs_and_returned_when_it_ends():
    proc = spawn({}, frozen=False, prelude="import sys; sys.stderr.write('x' * 200_000); sys.exit(3)")
    with pytest.raises(AssertionError, match="no start-up event"):
        wait_for_start(proc, timeout=60)
    err = stop(proc, terminate=False)
    assert proc.returncode == 3
    assert err == "x" * 200_000


def test_a_child_that_talks_without_announcing_itself_fails_at_the_deadline_too():
    proc = spawn({}, frozen=False, prelude="while True: print('chatter', flush=True)")
    try:
        started = time.monotonic()
        with pytest.raises(AssertionError, match="no start-up event within 2s"):
            wait_for_start(proc, timeout=2)
        assert time.monotonic() - started < 30
    finally:
        stop(proc)
