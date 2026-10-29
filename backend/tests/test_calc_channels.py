"""Cooperative cancellation is per request, not per channel.

With one generation per channel, the four parallel lanes of "Write all" cancelled each other's
contribution lookups: the second chapter's `explain_result` turned the first chapter's into a 409
(V285). The double click the mechanism exists for repeats the SAME request, so that is the key.
"""
from __future__ import annotations

from pydantic import BaseModel

from prism_lca.api.v1 import calc


class _Body(BaseModel):
    database: str
    code: str
    method: list[str] | None = None


def test_two_different_requests_on_one_channel_do_not_cancel_each_other():
    a, b = _Body(database="m", code="x"), _Body(database="m", code="y")
    ka, kb = calc._request_key(a), calc._request_key(b)
    mine_a = calc._next_gen("contribution", ka)
    calc._next_gen("contribution", kb)  # the other lane starts
    assert calc._canceller("contribution", mine_a, ka)() is False


def test_the_same_request_twice_supersedes_the_first():
    a = _Body(database="m", code="x", method=["t", "gwp"])
    ka = calc._request_key(a)
    first = calc._next_gen("contribution", ka)
    calc._next_gen("contribution", calc._request_key(_Body(database="m", code="x", method=["t", "gwp"])))
    assert calc._canceller("contribution", first, ka)() is True


def test_cancel_sweeps_the_whole_channel_as_the_ui_button_means_it():
    a, b = _Body(database="m", code="p"), _Body(database="m", code="q")
    ka, kb = calc._request_key(a), calc._request_key(b)
    ga, gb = calc._next_gen("stacked", ka), calc._next_gen("stacked", kb)
    other = calc._next_gen("compare", ka)
    calc._cancel_channel("stacked")
    assert calc._canceller("stacked", ga, ka)() and calc._canceller("stacked", gb, kb)()
    assert calc._canceller("compare", other, ka)() is False
