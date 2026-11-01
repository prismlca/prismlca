"""The Sensitivity analysis tab's runs: rules hold each step, a scenario is the starting point, every
indicator is scored per step, curves come per variant, and a run is a job with progress and Cancel.

Model (on test_sensitivity's seed): the bottle's electricity exchange is
``kwh * share * 2 * choice * const * 1000`` kWh, so the bottle scores 0.1 + 0.5 × that per unit:

* ``kwh`` = 2, a plain input
* ``share`` = 0.95, rule 0…1 — +10 % would be 1.045, so that side stops at 1
* ``choice`` = 0.5, rule "one of 0.25, 0.5, 1" — the steps are the neighbours, not ±10 %
* ``const`` = ``1/1000``, a formula of numbers alone — an input written as its arithmetic
* ``derived`` = ``2 * kwh`` — calculated from another parameter, not varied
* ``fixedc`` = 4.186, rule "one of 4.186" — a constant, nothing to vary

Baseline: 0.1 + 0.5 × 2 × 0.95 × 2 × 0.5 × 0.001 × 1000 = 1.05.
"""
from __future__ import annotations

import time

import pytest
from test_sensitivity import METHOD, _seed

from prism_lca.engine import lca, param_window, params, sensitivity, sensitivity_jobs
from prism_lca.engine.bootstrap import get_bd

DOUBLE = ["t", "double"]


@pytest.fixture(autouse=True)
def _clean():
    yield
    param_window.reset_for_tests()
    sensitivity_jobs._reset_for_tests()


def _model(client, token) -> None:
    bd = get_bd()
    _seed(bd)
    bd.Method(tuple(DOUBLE)).write([(("bio", "co2"), 2.0)])

    def p(**kw):
        r = client.post("/api/v1/params", json={"database": "fg", **kw}, headers=token)
        assert r.status_code == 200, r.text

    p(name="kwh", amount=2.0)
    p(name="share", amount=0.95, rule={"kind": "range", "min": 0, "max": 1})
    p(name="choice", amount=0.5, rule={"kind": "list", "values": [0.25, 0.5, 1.0]})
    p(name="const", formula="1/1000")
    p(name="derived", formula="2 * kwh")
    p(name="fixedc", amount=4.186, rule={"kind": "list", "values": [4.186]})
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": "fg", "activity_code": "bottle", "uid": "e",
              "formula": "kwh * share * 2 * choice * const * 1000"},
        headers=token,
    )
    assert r.status_code == 200, r.text


def _score(kwh=2.0, share=0.95, choice=0.5, const=0.001) -> float:
    return 0.1 + 0.5 * kwh * share * 2 * choice * const * 1000


def _scenario(client, token, overrides: dict) -> str:
    r = client.post("/api/v1/scenarios", json={"database": "fg", "name": "Far", "overrides": overrides},
                    headers=token)
    assert r.status_code == 200, r.text
    return r.json()["scenario"]["id"]


def _assert_untouched() -> None:
    vals, forms = params.snapshot_all("fg"), params.snapshot_formulas("fg")
    assert vals["kwh"] == 2.0 and vals["share"] == 0.95 and vals["choice"] == 0.5
    assert forms["const"] == "1/1000" and forms["derived"] == "2 * kwh"
    assert not param_window.path().exists()


# --------------------------------------------------------------------------- rules, inputs, indicators
def test_each_step_is_held_to_the_parameters_rule(client, token, project):
    _model(client, token)
    out = sensitivity.tornado("fg", "bottle", [METHOD, DOUBLE], 0.1)
    assert out["baseline"] == [pytest.approx(_score()), pytest.approx(2 * _score())]
    by = {e["param"]: e for e in out["entries"]}

    share = by["share"]
    assert share["low_value"] == pytest.approx(0.855) and share["high_value"] == 1.0
    assert share["limited"] == {"high": "between 0 and 1"}
    assert share["high"] == [pytest.approx(_score(share=1.0)), pytest.approx(2 * _score(share=1.0))]

    choice = by["choice"]
    assert (choice["low_value"], choice["high_value"]) == (0.25, 1.0)
    assert choice["limited"] == {"low": "one of 0.25, 0.5, 1", "high": "one of 0.25, 0.5, 1"}
    assert choice["high"][0] == pytest.approx(_score(choice=1.0))

    # A formula of numbers alone is an input; one over another parameter is not.
    assert by["const"]["low"][0] == pytest.approx(_score(const=0.0009))
    assert "limited" not in by["kwh"] and "replaces_formula" not in by["const"]
    skipped = {s["param"]: s["reason"] for s in out["skipped"]}
    assert skipped == {"derived": "has_formula", "fixedc": "fixed"}
    _assert_untouched()


def test_inputs_name_what_a_run_may_vary(client, token, project):
    _model(client, token)
    r = client.get("/api/v1/calc/sensitivity/inputs", params={"database": "fg"}, headers=token)
    assert r.status_code == 200, r.text
    out = r.json()
    names = {i["name"]: i for i in out["inputs"]}
    assert set(names) == {"kwh", "share", "choice", "const", "fixedc"}
    assert names["share"]["allowed"] == "between 0 and 1" and names["const"]["formula"] == "1/1000"
    assert [d["name"] for d in out["derived"]] == ["derived"]


def test_a_scenario_is_the_starting_point(client, token, project):
    _model(client, token)
    sid = _scenario(client, token, {"kwh": 4})
    out = sensitivity.tornado("fg", "bottle", [METHOD], 0.1, scenario_id=sid)
    assert out["scenario"] == {"id": sid, "name": "Far"}
    assert out["baseline"] == [pytest.approx(_score(kwh=4))]
    by = {e["param"]: e for e in out["entries"]}
    assert by["kwh"]["base"] == 4.0 and by["kwh"]["low_value"] == pytest.approx(3.6)
    # The scenario's overrides stay in for every other step.
    assert by["share"]["low"] == [pytest.approx(_score(kwh=4, share=0.855))]
    r = client.get("/api/v1/calc/sensitivity/inputs", params={"database": "fg", "scenario": sid}, headers=token)
    assert {i["name"]: i["value"] for i in r.json()["inputs"]}["kwh"] == 4.0
    _assert_untouched()


def test_a_range_of_100_percent_or_more_is_refused(client, token, project):
    _model(client, token)
    r = client.post("/api/v1/calc/sensitivity/tornado",
                    json={"database": "fg", "code": "bottle", "methods": [METHOD], "delta": 1.0}, headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "sensitivity_delta"


# --------------------------------------------------------------------------- curves
def test_a_curve_per_variant_with_its_own_starting_point(client, token, project):
    _model(client, token)
    sid = _scenario(client, token, {"kwh": 4})
    out = sensitivity.curve("fg", "bottle", METHOD, "share", [0.5, 1.0], [None, sid])
    base, far = out["curves"]
    assert (base["name"], far["name"]) == ("Baseline", "Far")
    assert base["origin"] == {"value": 0.95, "score": pytest.approx(_score())}
    assert far["origin"]["score"] == pytest.approx(_score(kwh=4))
    assert base["scores"] == [pytest.approx(_score(share=0.5)), pytest.approx(_score(share=1.0))]
    assert far["scores"] == [pytest.approx(_score(kwh=4, share=0.5)), pytest.approx(_score(kwh=4, share=1.0))]
    _assert_untouched()


def test_a_curve_through_values_the_rule_forbids_is_refused(client, token, project):
    _model(client, token)
    r = client.post("/api/v1/calc/sensitivity/curve",
                    json={"database": "fg", "code": "bottle", "method": METHOD, "param": "share",
                          "values": [0.5, 1.2]}, headers=token)
    assert r.status_code == 400
    body = r.json()["error"]
    assert body["code"] == "param_value_refused" and "1.2" in body["message"]
    _assert_untouched()


# --------------------------------------------------------------------------- jobs
def _tornado_job(on_progress=None):
    def run(progress, checkpoint):
        def both(done, total, label):
            progress(done, total, label)
            if on_progress:
                on_progress(done)
        return sensitivity.tornado("fg", "bottle", [METHOD], 0.1, progress=both, checkpoint=checkpoint)

    return run


def test_a_job_reports_progress_and_its_answer(client, token, project):
    _model(client, token)
    job = sensitivity_jobs.start("tornado", "fg", "bottle", _tornado_job(), run_in_thread=False)
    snap = sensitivity_jobs.snapshot(job, with_result=True)
    assert snap["state"] == "done", snap
    assert snap["progress"]["done"] == snap["progress"]["total"] > 1
    assert snap["result"]["entries"] and snap["stale"] is False
    _assert_untouched()


def test_cancel_stops_between_steps_and_puts_the_model_back(client, token, project):
    _model(client, token)
    holder: dict = {}

    def stop(done):
        if done == 2:
            holder["job"].cancel.set()

    job = sensitivity_jobs.SensitivityJob(id="x", kind="tornado", database="fg", code="bottle",
                                          model_generation=lca.model_generation(), project=get_bd().projects.current,
                                          started_at="")
    holder["job"] = job
    sensitivity_jobs._run(job, _tornado_job(stop))
    assert job.state == "cancelled" and job.result is None
    _assert_untouched()


def test_a_model_edit_stops_the_run(client, token, project):
    _model(client, token)
    job = sensitivity_jobs.start(
        "tornado", "fg", "bottle", _tornado_job(lambda done: lca.invalidate_lca_cache()), run_in_thread=False
    )
    assert job.state == "invalidated" and "model changed" in (job.error or "")
    _assert_untouched()


def test_the_job_endpoints_start_poll_and_read(client, token, project):
    _model(client, token)
    r = client.post("/api/v1/calc/sensitivity/jobs", headers=token, json={
        "kind": "curve",
        "curve": {"database": "fg", "code": "bottle", "method": METHOD, "param": "kwh", "values": [1, 3]},
    })
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    for _ in range(300):
        snap = client.get(f"/api/v1/calc/sensitivity/jobs/{job_id}", params={"result": True}, headers=token).json()
        if snap["state"] != "running":
            break
        time.sleep(0.1)
    assert snap["state"] == "done", snap
    assert snap["result"]["curves"][0]["scores"] == [pytest.approx(_score(kwh=1)), pytest.approx(_score(kwh=3))]
    assert client.post(f"/api/v1/calc/sensitivity/jobs/{job_id}/cancel", headers=token).json()["state"] == "done"


def test_a_step_that_pushes_a_derived_parameter_outside_its_rule_says_so(client, token, project):
    _model(client, token)
    # spare = 1.2 - share = 0.25, allowed 0 … 0.3: share −10 % (0.855) takes it to 0.345.
    r = client.post("/api/v1/params", headers=token, json={
        "database": "fg", "name": "spare", "formula": "1.2 - share", "rule": {"kind": "range", "min": 0, "max": 0.3},
    })
    assert r.status_code == 200, r.text
    out = sensitivity.tornado("fg", "bottle", [METHOD], 0.1, names=["share"])
    share = out["entries"][0]
    assert share["breaks"] == {"low": [{"param": "spare", "value": pytest.approx(0.345), "allowed": "between 0 and 0.3"}]}
    curve = sensitivity.curve("fg", "bottle", METHOD, "share", [0.5, 0.95])
    assert [b["at"] for b in curve["curves"][0]["breaks"]] == [0.5]
    _assert_untouched()


def test_a_stored_run_is_outdated_by_this_model_or_its_methods_not_by_another_model(client, token, project):
    from prism_lca.engine._store import now_iso

    _model(client, token)
    since = now_iso()
    time.sleep(0.02)

    def changed() -> dict:
        r = client.post("/api/v1/calc/sensitivity/changed", headers=token,
                        json={"database": "fg", "methods": [METHOD, DOUBLE], "since": since})
        assert r.status_code == 200, r.text
        return r.json()

    assert changed() == {"changed": False}
    client.post("/api/v1/databases/foreground", json={"name": "other"}, headers=token)
    client.post("/api/v1/params", json={"database": "other", "name": "x", "amount": 1.0}, headers=token)
    assert changed()["changed"] is False  # another model cannot move this one's result
    get_bd().Method(tuple(DOUBLE)).write([(("bio", "co2"), 3.0)])  # a factor edit leaves no audit line
    assert changed()["reason"] == "method"


def test_a_model_edit_after_the_run_outdates_it(client, token, project):
    from prism_lca.engine._store import now_iso

    _model(client, token)
    since = now_iso()
    time.sleep(0.02)
    client.post("/api/v1/params", json={"database": "fg", "name": "kwh", "amount": 3.0}, headers=token)
    r = client.post("/api/v1/calc/sensitivity/changed", headers=token,
                    json={"database": "fg", "methods": [METHOD], "since": since})
    assert r.json()["reason"] == "model"


def test_a_tiny_value_is_varied_not_taken_for_a_constant():
    from prism_lca.engine.param_rules import bounded_steps

    (low, _), (high, _) = bounded_steps({"kind": "range", "min": 0, "max": 1}, 1e-9, 0.1)
    assert (low, high) == (pytest.approx(0.9e-9), pytest.approx(1.1e-9))


def test_list_neighbours_are_found_whatever_else_the_list_holds():
    from prism_lca.engine.param_rules import bounded_steps

    (_low, _), (high, _) = bounded_steps({"kind": "list", "values": [1e-9, 2e-9, 1e9]}, 1e-9, 0.1)
    assert high == 2e-9


def test_a_scenario_override_of_a_parameter_the_model_no_longer_has_is_not_offered(client, token, project):
    from prism_lca.engine.scenarios import ScenarioStore

    _model(client, token)
    sid = ScenarioStore().create("fg", "Ghost", "", {"kwh": 4.0, "ghost": 1.0})["id"]
    names = {i["name"] for i in sensitivity.inputs("fg", sid)["inputs"]}
    assert "ghost" not in names and "kwh" in names
