"""Worker processes with a time and memory budget (engine/bounded_worker.py). The Typst and PDF tests run
real jobs through them; these cover the memory reading the budget rests on, and how a pool hands out its
workers."""
from __future__ import annotations

import sys
import threading
import time

import pytest

from prism_lca.engine import bounded_worker


def test_a_worker_trusts_only_a_memory_reading_that_works(monkeypatch):
    """Without a believable reading the memory bound is off and the time limit still applies — a
    reading that is wrong must never stop jobs that fit."""

    def broken() -> int:
        raise OSError("no reading")

    monkeypatch.setattr(bounded_worker, "_memory_reader", lambda: lambda: 10)
    assert bounded_worker.trusted_reader(100) is not None
    monkeypatch.setattr(bounded_worker, "_memory_reader", lambda: lambda: 60)
    assert bounded_worker.trusted_reader(100) is None  # past half the budget before any job
    monkeypatch.setattr(bounded_worker, "_memory_reader", lambda: broken)
    assert bounded_worker.trusted_reader(100) is None
    assert bounded_worker.over(broken, 1) is False


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="reads its memory from /proc")
def test_the_memory_reading_is_this_processes_resident_size():
    read = bounded_worker._memory_reader()
    assert read is not None and 1024**2 < read() < 64 * 1024**3


def _sleeper(conn, memory_limit: int) -> None:
    """A worker whose job is a number of seconds to sleep."""
    bounded_worker.serve(conn, lambda seconds: time.sleep(seconds) or seconds, memory_limit)


def test_waiting_for_a_free_worker_can_count_against_the_time_limit():
    pool = bounded_worker.Pool(lambda: bounded_worker.Worker(_sleeper, (2 * 1024**3,), name="prism-test"), 1)
    try:
        busy = threading.Thread(target=pool.run, args=(2.0, 30.0))
        busy.start()
        time.sleep(0.3)  # the busy job holds the one worker
        started = time.monotonic()
        # Alone, this job fits its limit; after the wait for the worker, what is left of it does not.
        with pytest.raises(bounded_worker.Stopped):
            pool.run(2.0, 3.0, waiting_counts=True)
        assert time.monotonic() - started < 3.0 + bounded_worker.GRACE_S
        # One that finds no worker within its limit is not started at all.
        busy = threading.Thread(target=pool.run, args=(3.0, 30.0))
        busy.start()
        time.sleep(0.3)
        with pytest.raises(bounded_worker.Stopped) as stopped:
            pool.run(0.0, 1.0, waiting_counts=True)
        assert stopped.value.code is None
        # Without it, a job waits for its turn and then gets its whole limit.
        assert pool.run(0.5, 1.0) == 0.5
        busy.join()
    finally:
        pool.shutdown()


def test_a_pool_that_keeps_no_idle_worker_ends_each_after_its_job():
    pool = bounded_worker.Pool(
        lambda: bounded_worker.Worker(_sleeper, (2 * 1024**3,), name="prism-test"), 1, keep_idle=False
    )
    assert pool.run(0.0, 30.0) == 0.0
    assert pool._idle == []
