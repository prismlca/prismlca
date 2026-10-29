"""The freshness check's progress bar: the study build counts its solves, and the page polls the count.

Seen while recording the product video (14.10.2026): a five-variant, sixteen-indicator check waited
almost five minutes behind a spinner and a seconds counter, and nothing could say whether it moved.
What has to hold for a bar built on this count to be believable: the plan is the number of solves the
build actually does — a bar that stops at 80 % or runs past 100 % teaches the reader to ignore it — and
the record is gone once the build is, so a later check never shows an old one.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import report_pipeline, report_snapshot
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

DB = "bp"


@pytest.fixture(autouse=True)
def _clean_cache():
    report_snapshot.invalidate()
    yield
    report_snapshot.invalidate()


@pytest.fixture
def published(monkeypatch) -> list[tuple[int, int]]:
    """Every (done, planned) the build publishes, before the record clamps `total` to `done`."""
    seen: list[tuple[int, int]] = []
    original = report_snapshot.BuildProgress._publish

    def recording(self):
        seen.append((self._done, self._total))
        original(self)

    monkeypatch.setattr(report_snapshot.BuildProgress, "_publish", recording)
    return seen


def _seed() -> None:
    bd = get_bd()
    bd.Database("biosphere").write(
        {
            ("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"},
            ("biosphere", "ch4"): {"name": "CH4", "type": "emission", "categories": ("air",), "unit": "kg"},
        }
    )
    bd.Database(DB).write(
        {
            (DB, code): {
                "name": f"bag {code}", "unit": "unit", "reference product": "bag", "location": "DE",
                "exchanges": [
                    {"input": (DB, code), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": amount, "type": "biosphere"},
                    {"input": ("biosphere", "ch4"), "amount": amount / 10, "type": "biosphere"},
                ],
            }
            for code, amount in (("a", 2.0), ("b", 3.0), ("c", 5.0))
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0), (("biosphere", "ch4"), 28.0)])
    bd.Method(("t", "ch4 only")).write([(("biosphere", "ch4"), 1.0)])


def _report(client, token, codes: list[str]) -> dict:
    r = client.post(
        "/api/v1/report/create",
        json={
            "database": DB, "lang": "en", "methods": [["t", "gwp"], ["t", "ch4 only"]],
            "aggregate_by": "geo", "subjects": [{"database": DB, "code": c} for c in codes],
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_the_count_ends_exactly_where_the_plan_said(client, token, project, published):
    _seed()
    rep = _report(client, token, ["a", "b", "c"])
    report_pipeline.analysis_snapshot(DB, rep["id"], report_pipeline.RenderRequest())

    assert published, "the build published no progress at all"
    done, planned = published[-1]
    # Three variants × (one LCIA + two breakdowns), plus the tree and inventory the report's chapters ask
    # for — the reference's lead breakdowns are its variant's, so they add nothing. Whatever the chapters
    # are, the count must close.
    assert done == planned and done >= 3 * 3
    assert [d for d, _ in published] == sorted(d for d, _ in published), "the count went backwards"
    # Gone with the build: a later check served from the cache must not show this one's bar.
    assert report_snapshot.build_progress(DB, rep["id"]) is None


def test_the_reference_is_traversed_once_not_again_for_its_lead_breakdowns(client, token, project, monkeypatch):
    """In a comparison the reference is one of the variants, computed in the same state: its lead
    breakdowns are the variant's, so every variant × indicator is traversed exactly once."""
    _seed()
    rep = _report(client, token, ["a", "b", "c"])
    traversed: list[tuple[str, str]] = []
    real = report_pipeline.lca.contribution

    def counting(database, code, method, *args, **kwargs):
        traversed.append((code, method[1]))
        return real(database, code, method, *args, **kwargs)

    monkeypatch.setattr(report_pipeline.lca, "contribution", counting)
    _report_def, data = report_pipeline.analysis_snapshot(DB, rep["id"], report_pipeline.RenderRequest())

    assert sorted(traversed) == sorted((c, m) for c in "abc" for m in ("gwp", "ch4 only"))
    assert len(data["subjects"]) == 3


def test_an_addition_the_variants_could_not_split_is_not_tried_again(client, token, project, monkeypatch, published):
    """A further indicator whose breakdown fails is left out, not the report — and for the reference
    the variant's attempt is the attempt: a retry fails the same way and ran the bar past its plan."""
    _seed()
    rep = _report(client, token, ["a", "b", "c"])
    attempts: list[str] = []
    real = report_pipeline.lca.contribution

    def failing(database, code, method, *args, **kwargs):
        if method[1] == "ch4 only":
            attempts.append(code)
            raise PrismError("This model cannot be split by location.", code="breakdown_failed")
        return real(database, code, method, *args, **kwargs)

    monkeypatch.setattr(report_pipeline.lca, "contribution", failing)
    report_pipeline.analysis_snapshot(DB, rep["id"], report_pipeline.RenderRequest())

    assert sorted(attempts) == ["a", "b", "c"]
    done, planned = published[-1]
    assert done == planned


def test_a_variant_that_is_gone_leaves_the_plan_with_it(client, token, project, published):
    """A deleted process drops out of the report rather than failing it — and out of the plan, or the
    bar would stop short of the end on every report that has lost a variant."""
    _seed()
    rep = _report(client, token, ["a", "b", "c"])
    get_bd().get_node(database=DB, code="b").delete()
    report_snapshot.invalidate()
    _report_def, data = report_pipeline.analysis_snapshot(DB, rep["id"], report_pipeline.RenderRequest())

    assert len(data["subjects"]) == 2, "the deleted variant did not drop out — the test proves nothing"
    done, planned = published[-1]
    assert done == planned


def test_the_poll_answers_for_its_own_report_only(client, token, project):
    progress = report_snapshot.BuildProgress(DB, "rep-x")
    try:
        progress.plan(40)
        progress.step(3)
        r = client.get(f"/api/v1/report/one/{DB}/rep-x/progress", headers=token)
        assert r.status_code == 200, r.text
        build = r.json()["build"]
        assert (build["done"], build["total"]) == (3, 40) and build["elapsed"] >= 0
        # Another report's build is not this report's progress — its page keeps the clock.
        other = client.get(f"/api/v1/report/one/{DB}/rep-y/progress", headers=token)
        assert other.json() == {"build": None}
    finally:
        progress.close()
    assert client.get(f"/api/v1/report/one/{DB}/rep-x/progress", headers=token).json() == {"build": None}
