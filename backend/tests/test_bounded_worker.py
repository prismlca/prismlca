"""Worker processes with a time and memory budget (engine/bounded_worker.py). The Typst and PDF tests run
real jobs through them; these cover the memory reading the budget rests on."""
from __future__ import annotations

import sys

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
