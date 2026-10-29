"""What a variant of the comparison is *called* in the document.

The identity fixes (V221, V223) settled which variant a pin means. They deliberately left the
printed name alone, and the name is what a reader has: two subjects on one process, neither with a
label of its own and neither adding a scenario, both fall back to the process name — so the results
table and the contribution matrix printed two columns nobody can tell apart.

The rule is "only when it collides", and the assertion that matters most here is the one that says
*nothing changed*: a report whose variants already read differently must print exactly what it
printed before this existed, or every finished chapter quoting a variant's name is wrong.
"""
from __future__ import annotations

import json

import pytest

from prism_lca.engine import report_pipeline, report_snapshot
from prism_lca.engine.bootstrap import get_bd

DB = "vn"


@pytest.fixture(autouse=True)
def _clean_cache():
    report_snapshot.invalidate()
    yield
    report_snapshot.invalidate()


# --- the rule itself, without a model ------------------------------------------------------------


def _names(*rows: dict) -> list[str]:
    return report_pipeline.report_variants.disambiguated_labels(list(rows))


def test_names_that_already_differ_come_back_byte_for_byte():
    """The whole safety of this: with no collision there is nothing to decide, and every stored
    chapter that spells a variant's name out depends on the answer being the input."""
    assert _names(
        {"label": "Baseline", "scenario_name": "", "location": "DE", "product": "window"},
        {"label": "Refill", "scenario_name": "refill", "location": "AT", "product": "frame"},
    ) == ["Baseline", "Refill"]


def test_the_parameter_state_separates_them_first():
    """And it is appended even though the label already contains the word — which is exactly the
    suppression that produced the collision. A repetition reads badly; two identical columns are
    wrong."""
    assert _names(
        {"label": "Fenster 100x120", "scenario_name": "", "location": "DE"},
        {"label": "Fenster 100x120", "scenario_name": "100x120", "location": "DE"},
    ) == ["Fenster 100x120", "Fenster 100x120 · 100x120"]


def test_then_the_location_and_then_the_reference_product():
    """What separates two genuinely different processes that happen to share a name."""
    assert _names(
        {"label": "window", "location": "DE", "product": "window"},
        {"label": "window", "location": "AT", "product": "window"},
    ) == ["window (DE)", "window (AT)"]
    assert _names(
        {"label": "window", "location": "DE", "product": "frame"},
        {"label": "window", "location": "DE", "product": "pane"},
    ) == ["window (frame)", "window (pane)"]


def test_a_qualifier_only_touches_the_group_that_collides():
    assert _names(
        {"label": "window", "location": "DE"},
        {"label": "window", "location": "AT"},
        {"label": "door", "location": "CH"},
    ) == ["window (DE)", "window (AT)", "door"]


def test_the_position_is_the_last_resort_and_it_numbers_every_member():
    """Same process, same state, same product: nothing a reader could see differs, so nothing a
    reader could read can be said. "widget" beside "widget (2)" reads as an annotation on the second
    one; "widget (1)" beside "widget (2)" reads as the enumeration it is."""
    assert _names({"label": "widget"}, {"label": "widget"}) == ["widget (1)", "widget (2)"]


def test_a_qualifier_that_walks_into_another_name_is_still_resolved():
    """Appending "(DE)" can collide with a label the author typed that way. The regrouping after each
    step is what catches it, and the last resort catches what is left."""
    out = _names(
        {"label": "window", "location": "DE"},
        {"label": "window", "location": "AT"},
        {"label": "window (DE)"},
    )
    assert len(set(out)) == 3


def test_three_variants_where_only_two_of_them_collide():
    """A qualifier that splits the group only partly is not the end of the walk: DE, DE, AT leaves
    two names still equal, and the next rules have to finish the job."""
    out = _names(
        {"label": "w", "location": "DE", "product": "frame"},
        {"label": "w", "location": "DE", "product": "pane"},
        {"label": "w", "location": "AT", "product": "frame"},
    )
    assert len(set(out)) == 3 and out[2] == "w (AT)"


# --- and through the real render ------------------------------------------------------------------


def _seed() -> None:
    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database(DB).write(
        {
            # Two *different* processes under one name — the case a location can separate.
            ("vn", "a"): {
                "name": "window", "unit": "unit", "reference product": "window", "location": "DE",
                "exchanges": [
                    {"input": ("vn", "a"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                ],
            },
            ("vn", "b"): {
                "name": "window", "unit": "unit", "reference product": "window", "location": "AT",
                "exchanges": [
                    {"input": ("vn", "b"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 3.0, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("t", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _report(client, token, subjects: list[dict]) -> dict:
    return client.post(
        "/api/v1/report/create",
        json={
            "database": DB, "lang": "en", "methods": [["t", "gwp"]],
            "aggregate_by": "geo", "subjects": subjects,
        },
        headers=token,
    ).json()


def _data(client, rep: dict) -> dict:
    """The snapshot the checks, the briefs and the frontend's charts all read."""
    _report_def, data = report_pipeline.analysis_snapshot(DB, rep["id"], report_pipeline.RenderRequest())
    return data


def _typeset(client, token, rep: dict) -> str:
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/sources", json={}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["files"]["main.typ"]


def test_two_subjects_on_one_process_are_told_apart(client, token, project):
    """The measured case: same process, no scenario, no label of their own. Everything a reader
    could go by is identical, so the position is all that is left — and it is on both of them."""
    _seed()
    rep = _report(client, token, [{"database": DB, "code": "a"}, {"database": DB, "code": "a"}])
    data = _data(client, rep)
    assert [s["label"] for s in data["subjects"]] == ["window (1)", "window (2)"]


def test_two_same_named_processes_are_told_apart_by_their_location(client, token, project):
    _seed()
    rep = _report(client, token, [{"database": DB, "code": "a"}, {"database": DB, "code": "b"}])
    data = _data(client, rep)
    assert [s["label"] for s in data["subjects"]] == ["window (DE)", "window (AT)"]


def test_labels_of_their_own_print_exactly_what_they_printed_before(client, token, project):
    """The assertion that protects the reports already written: no collision, no qualifier."""
    _seed()
    rep = _report(
        client, token,
        [{"database": DB, "code": "a", "label": "Baseline"},
         {"database": DB, "code": "a", "label": "Refill"}],
    )
    data = _data(client, rep)
    # "Baseline" is our own default label and follows the report language; the author's word does not.
    assert [s["label"] for s in data["subjects"]] == ["Baseline", "Refill"]


def test_a_scenario_still_names_itself_the_way_it_always_did(client, token, project):
    """The other half of that protection: the composed "label · scenario" name is untouched, because
    a report that composes one has no collision to resolve."""
    _seed()
    assert client.post(
        "/api/v1/params", json={"database": DB, "name": "kwh", "amount": 2.0}, headers=token
    ).status_code == 200
    sc = client.post(
        "/api/v1/scenarios",
        json={"database": DB, "name": "refill", "overrides": {"kwh": 1.0}},
        headers=token,
    ).json()["scenario"]["id"]
    rep = _report(
        client, token,
        [{"database": DB, "code": "a"},
         {"database": DB, "code": "a", "scenario": sc, "scenario_name": "refill"}],
    )
    data = _data(client, rep)
    assert [s["label"] for s in data["subjects"]] == ["window", "window · refill"]


def test_the_name_is_the_same_in_the_table_and_in_what_the_charts_are_drawn_from(
    client, token, project
):
    """One derivation. The results matrix and the contribution matrix are typeset from it, the
    grouped and stacked chart legends are drawn by the frontend from `contribution_subjects` — so a
    name made tellable apart has to be tellable apart in all four, not in the table only."""
    _seed()
    rep = _report(client, token, [{"database": DB, "code": "a"}, {"database": DB, "code": "b"}])
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections", json={"kind": "lcia"}, headers=token
    )
    client.post(
        f"/api/v1/report/one/{DB}/{rep['id']}/sections", json={"kind": "contribution"}, headers=token
    )
    data = _data(client, rep)
    expected = ["window (DE)", "window (AT)"]
    assert [s["label"] for s in data["subjects"]] == expected
    assert [s["label"] for s in data["contribution_subjects"]] == expected
    assert [s["label"] for s in data["contributions"][0]["subjects"]] == expected
    # And the same two strings in the typeset document: a row of the results table each, and the two
    # columns of the breakdown matrix. Both read the name from the list above; before it was derived
    # in one place the results table was also the one that printed it untranslated.
    # The cells live in `tables.json`; `main.typ` only places them.
    r = client.post(f"/api/v1/report/one/{DB}/{rep['id']}/sources", json={}, headers=token)
    assert r.status_code == 200, r.text
    tables = list(json.loads(r.json()["files"]["tables.json"]).values())
    rows = [row for table in tables for row in table["rows"]]
    assert ["window (DE)", "2.00"] in [row[:2] for row in rows]
    assert ["window (AT)", "3.00"] in [row[:2] for row in rows]
    assert ["Group", "window (DE)", "window (AT)"] in [table["headers"] for table in tables]
