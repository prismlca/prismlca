"""Which method a caller means, when several are asked for and some are wrong (engine/method_lookup.py).

Seen in a test run: `calculate` with five methods, four of them guessed. The first wrong one failed the
call, nothing was computed, and the one suggestion offered was Cumulative Energy Demand for an EF v3.1
acidification indicator that missed by one word — the closest-match compared only the first word. What has
to hold: the valid methods are computed, each wrong one is named with a ranked suggestion, a request in
which none resolves stays an error, and a report whose indicator list names a method that is gone says so
instead of dropping every variant as a deleted process.
"""
from __future__ import annotations

import time

import pytest

from prism_lca.engine import calc_jobs, method_lookup, report_pipeline, report_snapshot
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

DB = "ml"
EF_ACID = ("EF v3.1", "acidification", "accumulated exceedance (AE)")
EF0_ACID = ("EF v3.0 no LT", "acidification no LT", "accumulated exceedance (AE) no LT")
CED = ("Cumulative Energy Demand (CED)", "energy resources: non-renewable, fossil", "energy content (HHV)")
RECIPE = ("ReCiPe 2016 v1.03, midpoint (H)", "acidification: terrestrial", "terrestrial acidification potential (TAP)")
GWP = ("IPCC 2021", "climate change: total (excl. biogenic CO2)", "global warming potential (GWP100)")
#: What the model sent in that run, word for word.
GUESSED_ACID = ["EF v3.1", "acidification: accumulated exceedance (AE)", "terrestrial acidification potential (AP)"]
GUESSED_WATER = ["EF v3.1", "water use", "water depletion potential (WDP)"]


def _seed() -> None:
    bd = get_bd()
    bd.Database("biosphere").write(
        {
            ("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"},
            ("biosphere", "so2"): {"name": "SO2", "type": "emission", "categories": ("air",), "unit": "kg"},
        }
    )
    bd.Database(DB).write(
        {
            (DB, code): {
                "name": f"part {code}", "unit": "kilogram", "reference product": "part", "location": "DE",
                "exchanges": [
                    {"input": (DB, code), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                    {"input": ("biosphere", "so2"), "amount": 0.01, "type": "biosphere"},
                ],
            }
            for code in ("a", "b")
        }
    )
    for method in (CED, EF0_ACID, EF_ACID, RECIPE):
        bd.Method(method).write([(("biosphere", "so2"), 1.0)])
    bd.Method(GWP).write([(("biosphere", "co2"), 1.0)])


def test_the_closest_methods_are_ranked_by_the_words_they_share(project):
    _seed()
    with pytest.raises(PrismError) as err:
        method_lookup.resolve_method(GUESSED_ACID)
    assert err.value.code == "method_not_found"
    closest = err.value.hint.removeprefix("Closest: ").split(" | ")
    assert closest[0] == " · ".join(EF_ACID), closest
    assert closest.index(" · ".join(CED)) > closest.index(" · ".join(EF0_ACID))


def test_the_same_name_spelt_otherwise_is_not_ambiguous_beside_a_longer_twin(project):
    _seed()
    twin = ("EF v3.1 no LT", "acidification no LT", "accumulated exceedance (AE) no LT")
    get_bd().Method(twin).write([(("biosphere", "so2"), 1.0)])
    assert method_lookup.resolve_method("ef 3.1 · Acidification · accumulated exceedance (AE)") == EF_ACID
    # A query that is the name of neither stays ambiguous: guessing between them is not the resolver's call.
    with pytest.raises(PrismError) as err:
        method_lookup.resolve_method("EF 3.1 acidification")
    assert err.value.code == "method_ambiguous"


def test_resolve_methods_keeps_the_valid_and_names_the_rest(project):
    _seed()
    found, missing = method_lookup.resolve_methods([list(GWP), GUESSED_ACID, "EF v3.1 acidification"])
    assert found == [GWP, EF_ACID]
    assert [m["method"] for m in missing] == [GUESSED_ACID]
    assert missing[0]["code"] == "method_not_found" and missing[0]["hint"].startswith("Closest: EF v3.1")


def test_partial_lcia_computes_the_valid_methods(client, token, project):
    _seed()
    body = {"database": DB, "code": "a", "methods": [list(GWP), GUESSED_ACID, list(EF_ACID), GUESSED_WATER]}
    r = client.post("/api/v1/calc/lcia", json={**body, "partial": True}, headers=token)
    assert r.status_code == 200, r.text
    out = r.json()
    assert [x["method"] for x in out["results"]] == [list(GWP), list(EF_ACID)]
    assert [x["method"] for x in out["not_computed"]] == [GUESSED_ACID, GUESSED_WATER]
    assert all(x["error"] and "hint" in x for x in out["not_computed"])
    # Without the flag a wrong method still fails the call: callers that read a 404 as "the process is
    # gone" (the report pipeline) must not get half an answer.
    assert client.post("/api/v1/calc/lcia", json=body, headers=token).status_code == 404


def test_partial_lcia_with_no_valid_method_is_an_error_naming_each(client, token, project):
    _seed()
    body = {"database": DB, "code": "a", "methods": [GUESSED_ACID, GUESSED_WATER], "partial": True}
    r = client.post("/api/v1/calc/lcia", json=body, headers=token)
    assert r.status_code == 404
    detail = r.json()
    text = str(detail)
    assert "None of the 2 LCIA methods resolved" in text
    assert "acidification: accumulated exceedance" in text and "water depletion potential" in text


def test_a_job_resolves_its_methods_before_it_starts(client, token, project):
    _seed()
    calc_jobs._reset_for_tests()
    body = {"database": DB, "code": "a", "methods": [list(GWP), GUESSED_ACID]}
    r = client.post("/api/v1/calc/jobs", json=body, headers=token)
    assert r.status_code == 200, r.text
    started = r.json()
    assert started["progress"]["total"] == 1
    assert [m["method"] for m in started["not_computed"]] == [GUESSED_ACID]
    job = calc_jobs.get(started["job_id"])
    for _ in range(200):
        if job.state != "running":
            break
        time.sleep(0.02)
    final = client.get(f"/api/v1/calc/jobs/{started['job_id']}?result=true", headers=token).json()
    assert final["state"] == "done"
    assert [x["method"] for x in final["result"]["results"]] == [list(GWP)]
    assert final["not_computed"][0]["method"] == GUESSED_ACID

    r = client.post("/api/v1/calc/jobs", json={**body, "methods": [GUESSED_ACID]}, headers=token)
    assert r.status_code == 404


def test_a_report_naming_a_gone_method_says_so(client, token, project):
    _seed()
    r = client.post(
        "/api/v1/report/create",
        json={"database": DB, "lang": "en", "methods": [list(GWP), list(EF_ACID)],
              "subjects": [{"database": DB, "code": c} for c in ("a", "b")]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    rep = r.json()
    get_bd().Method(EF_ACID).deregister()
    report_snapshot.invalidate()
    with pytest.raises(PrismError) as err:
        report_pipeline.analysis_snapshot(DB, rep["id"], report_pipeline.RenderRequest())
    assert err.value.code == "method_not_installed"
    assert "'accumulated exceedance (AE)'] not found" in err.value.message


def test_a_report_does_not_take_a_near_twin_for_a_gone_indicator(client, token, project):
    """A saved indicator that is gone must not become the one installed method still carrying all its words."""
    _seed()
    twin = ("EF v3.1 no LT", "acidification no LT", "accumulated exceedance (AE) no LT")
    get_bd().Method(twin).write([(("biosphere", "so2"), 1.0)])
    respelt = "ef 3.1 · Acidification · accumulated exceedance (AE)"  # the same name, spelt otherwise
    r = client.post(
        "/api/v1/report/create",
        json={"database": DB, "lang": "en", "methods": [list(GWP), list(EF_ACID), respelt],
              "subjects": [{"database": DB, "code": "a"}]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    rep = r.json()
    report_snapshot.invalidate()
    # While the indicator is installed, its respelt name is accepted: nothing is refused.
    report_pipeline.analysis_snapshot(DB, rep["id"], report_pipeline.RenderRequest())
    get_bd().Method(EF_ACID).deregister()
    report_snapshot.invalidate()
    with pytest.raises(PrismError) as err:
        report_pipeline.analysis_snapshot(DB, rep["id"], report_pipeline.RenderRequest())
    assert err.value.code == "method_not_installed"
    assert "no LT" in err.value.message and "may be another indicator" in err.value.message
