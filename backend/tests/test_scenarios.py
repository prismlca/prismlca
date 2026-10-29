from __future__ import annotations

import pytest

from prism_lca.engine.bootstrap import get_bd

METHOD = ["test", "gwp"]
DB = "fg"


def _seed(bd) -> None:
    """bottle uses `kwh` kWh electricity (0.5 kg CO2/kWh) + 0.1 kg direct.
    Score = 0.1 + kwh*0.5  ->  kwh=2: 1.1, kwh=1: 0.6."""
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    fg = bd.Database("fg")
    fg.write(
        {
            ("fg", "elec"): {
                "name": "electricity", "unit": "kWh", "reference product": "electricity",
                "exchanges": [
                    {"input": ("fg", "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            ("fg", "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle",
                "exchanges": [
                    {"input": ("fg", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("fg", "elec"), "amount": 0.0, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    for e in fg.get("bottle").technosphere():
        e["prism_uid"] = "e"
        e.save()
    bd.databases["fg"]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _lcia(client, token, code="bottle") -> float:
    r = client.post("/api/v1/calc/lcia", json={"database": "fg", "code": code, "method": METHOD}, headers=token)
    return r.json()["score"]


def _param(client, token, name, **body) -> None:
    assert client.post("/api/v1/params", json={"database": DB, "name": name, **body}, headers=token).status_code == 200


def _formula(client, token, code, uid, formula) -> None:
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": DB, "activity_code": code, "uid": uid, "formula": formula},
        headers=token,
    ).status_code == 200


def _mk(client, token, name, **body):
    r = client.post("/api/v1/scenarios", json={"database": DB, "name": name, **body}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["scenario"]["id"]


def _scenarios(client, token) -> list[dict]:
    return client.get("/api/v1/scenarios", params={"database": DB}, headers=token).json()


def test_scenario_compute_and_compare(client, token, project):
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    assert abs(_lcia(client, token) - 1.1) < 1e-6  # baseline

    # create with overrides in one call (the dialog flow)
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})

    r = client.post(
        "/api/v1/scenarios/compute",
        json={"database": "fg", "code": "bottle", "method": METHOD, "scenario_id": sid},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(r.json()["score"] - 0.6) < 1e-6

    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": "fg", "code": "bottle", "method": METHOD, "scenario_ids": [sid]},
        headers=token,
    )
    body = r.json()
    scores = {x["scenario"]: x["score"] for x in body["results"]}
    assert abs(scores["(baseline)"] - 1.1) < 1e-6
    assert abs(scores["efficient"] - 0.6) < 1e-6
    # The difference IS the comparison, so it comes from the engine: leaving the division to the
    # caller meant the "-45 %" in a written answer was hand arithmetic nothing could check.
    assert abs(body["baseline_score"] - 1.1) < 1e-6
    eff = [x for x in body["results"] if x["scenario"] == "efficient"][0]
    assert abs(eff["delta"] - (0.6 - 1.1)) < 1e-6
    assert abs(eff["delta_pct"] - (100.0 * (0.6 - 1.1) / 1.1)) < 1e-5
    assert "delta" not in body["results"][0]  # the baseline has nothing to differ from

    # baseline was restored after compute/compare
    assert abs(_lcia(client, token) - 1.1) < 1e-6


def test_scenario_aware_results_matrix(client, token, project):
    """A scenario is a first-class subject in the Results matrix: /calc/compare applies its
    overrides per subject and returns baseline + scenario columns."""
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})
    r = client.post(
        "/api/v1/calc/compare",
        json={"methods": [METHOD], "subjects": [
            {"database": "fg", "code": "bottle", "label": "Baseline"},
            {"database": "fg", "code": "bottle", "label": "efficient", "scenario": sid},
        ]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    key = " · ".join(METHOD)
    by = {s["label"]: s["scores"][key] for s in r.json()["subjects"]}
    assert abs(by["Baseline"] - 1.1) < 1e-6
    assert abs(by["efficient"] - 0.6) < 1e-6
    assert abs(_lcia(client, token) - 1.1) < 1e-6  # baseline restored


def test_scenario_aware_stacked(client, token, project):
    """compare-stacked applies a subject's scenario overrides, so the breakdown total shifts."""
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})
    r = client.post(
        "/api/v1/calc/compare-stacked",
        json={"methods": [METHOD], "dimensions": ["isic"], "subjects": [
            {"database": "fg", "code": "bottle", "label": "Baseline"},
            {"database": "fg", "code": "bottle", "label": "efficient", "scenario": sid},
        ]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    key = " · ".join(METHOD)
    tot = {s["label"]: s["methods"][key]["total"] for s in r.json()["subjects"]}
    assert abs(tot["Baseline"] - 1.1) < 1e-6
    assert abs(tot["efficient"] - 0.6) < 1e-6
    assert abs(_lcia(client, token) - 1.1) < 1e-6  # baseline restored


def test_scenario_crud_update_duplicate_undo(client, token, project):
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    sid = _mk(client, token, "s1", description="test", overrides={"kwh": 3.0})
    names = [s["name"] for s in _scenarios(client, token)]
    assert "s1" in names
    # duplicate name -> 409
    assert client.post("/api/v1/scenarios", json={"database": DB, "name": "s1"}, headers=token).status_code == 409

    # update: rename + change overrides (id stays)
    assert client.post("/api/v1/scenarios/update",
                       json={"database": DB, "id": sid, "name": "s1-renamed", "description": "d2", "overrides": {"kwh": 1.5}},
                       headers=token).status_code == 200
    s = next(x for x in _scenarios(client, token) if x["id"] == sid)
    assert s["name"] == "s1-renamed" and s["overrides"]["kwh"] == 1.5 and s["description"] == "d2"

    # duplicate → new id, "(copy)" name, same overrides
    dup = client.post("/api/v1/scenarios/duplicate", json={"database": DB, "id": sid}, headers=token).json()["scenario"]
    assert dup["id"] != sid and dup["name"] == "s1-renamed (copy)" and dup["overrides"]["kwh"] == 1.5

    # delete + undo restores it (same id)
    client.post("/api/v1/scenarios/delete", json={"database": DB, "id": sid}, headers=token)
    assert sid not in [x["id"] for x in _scenarios(client, token)]
    client.post("/api/v1/model/undo", headers=token)
    assert sid in [x["id"] for x in _scenarios(client, token)]


def test_scenarios_are_model_scoped(client, token, project):
    """A scenario created in model A must not appear in model B (per-model isolation)."""
    import uuid
    _seed(get_bd())
    other = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": other}, headers=token).status_code == 200
    _param(client, token, "kwh", amount=2.0)
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})
    assert sid in [s["id"] for s in _scenarios(client, token)]
    assert client.get("/api/v1/scenarios", params={"database": other}, headers=token).json() == []


def test_contribution_and_elementary_flows_under_scenario(client, token, project):
    """Detailed Results can pick a scenario: the contribution tree and elementary-flows box apply
    its parameter overrides (total shifts) and restore the baseline afterwards."""
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})

    base = client.post("/api/v1/calc/contribution",
                       json={"database": "fg", "code": "bottle", "method": METHOD}, headers=token)
    assert abs(base.json()["meta"]["total"] - 1.1) < 1e-6

    scen = client.post("/api/v1/calc/contribution",
                       json={"database": "fg", "code": "bottle", "method": METHOD, "scenario": sid}, headers=token)
    assert scen.status_code == 200, scen.text
    assert abs(scen.json()["meta"]["total"] - 0.6) < 1e-6

    ef = client.post("/api/v1/calc/elementary-flows",
                     json={"database": "fg", "code": "bottle", "method": METHOD, "scenario": sid}, headers=token)
    assert ef.status_code == 200, ef.text

    assert abs(_lcia(client, token) - 1.1) < 1e-6  # baseline restored after both calls


def test_scenario_compute_after_deleting_a_duplicated_model(client, token, project):
    """Regression: duplicating a parameterised model then deleting the copy used to leave a
    Group row named after the vanished database. bw2data's recalculate() then called
    ActivityParameter.recalculate() on that empty group and raised DoesNotExist, breaking every
    subsequent scenario calculation. Deleting the model must take its parameter group with it."""
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})

    # Duplicate the model (copies its DatabaseParameters → a Group named after the copy), then
    # delete the copy — the exact sequence that produced the orphan group.
    assert client.post("/api/v1/databases/foreground/duplicate",
                       json={"source": DB, "name": "fg copy"}, headers=token).status_code == 200
    assert client.post("/api/v1/databases/foreground/delete",
                       json={"database": "fg copy"}, headers=token).status_code == 200

    # The original model's scenario must still compute (previously a 500).
    r = client.post(
        "/api/v1/scenarios/compute",
        json={"database": "fg", "code": "bottle", "method": METHOD, "scenario_id": sid},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert abs(r.json()["score"] - 0.6) < 1e-6


def test_purge_orphan_groups_is_self_healing(client, token, project):
    """A pre-existing orphan group (e.g. from data created before the delete-path fix) must be
    cleaned up by the next recalc rather than crashing it."""
    from bw2data.parameters import Group

    from prism_lca.engine import params

    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")

    # Inject the exact orphan: a non-fresh Group that is neither a live database nor "project"
    # and has no ActivityParameter rows.
    Group.create(name="ghost model", fresh=False)
    params.recalc_all()  # would raise ActivityParameterDoesNotExist without the purge
    assert "ghost model" not in {g.name for g in Group.select()}
    assert abs(_lcia(client, token) - 1.1) < 1e-6


# ---- a failed render must not leave the model in a scenario ----------------
def test_a_restore_that_cannot_write_retries_before_giving_up(monkeypatch, project):
    """SQLite locks are transient — a second app instance holding the project file clears in
    milliseconds. Failing on the first attempt would turn a blip into a corrupted model."""
    from prism_lca.engine import params, scenarios

    calls = {"n": 0}
    real = params.apply_values

    def flaky(database, values, formulas=None):
        calls["n"] += 1
        if calls["n"] < 3:
            raise Exception("database is locked")
        return real(database, values, formulas)

    monkeypatch.setattr(params, "apply_values", flaky)
    scenarios._restore("db", {"mass": 1.0}, "High recycling")
    assert calls["n"] == 3


def test_a_restore_that_never_succeeds_says_the_model_was_left_changed(monkeypatch, project):
    """The failure this exists for. Rendering a report is a *read*, and a scenario is applied by
    writing the overrides into the model's parameters. When the write-back failed — a second copy of
    the app holding the project — the study's baseline silently became its heat-pump variant, and the
    error named the render rather than the model. Found by hitting it."""
    from prism_lca.engine import params, scenarios
    from prism_lca.errors import PrismError

    monkeypatch.setattr(params, "apply_values", lambda *a, **k: (_ for _ in ()).throw(Exception("database is locked")))
    try:
        scenarios._restore("db", {"water_heater_type": 1.0, "mass": 2.0}, "Electric Heat Pump Shower")
    except PrismError as exc:
        assert exc.code == "scenario_restore_failed"
        # It names the scenario, says the parameters are still overridden, and lists them.
        assert "Electric Heat Pump Shower" in exc.message
        assert "still overridden" in exc.message
        assert "water_heater_type" in exc.message and "mass" in exc.message
        assert "database is locked" in (exc.hint or "")
    else:
        raise AssertionError("a restore that never succeeds must not return quietly")


# --- Improvement 1: a variant that varies nothing ----------------------------------


def test_a_scenario_may_not_be_created_as_a_copy_of_the_baseline(client, token, project):
    """An override set to the value the model already has is the baseline under another name.

    The apple-juice model carried one: "Longer DC distance" put `dist_dc_store` at 500 km, and the
    parameter said 500 km. Every comparison returned Δ 0 and the report drew three bars of the same
    height with nothing saying why.
    """
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")

    r = client.post(
        "/api/v1/scenarios", json={"database": DB, "name": "same", "overrides": {"kwh": 2.0}}, headers=token
    )
    assert r.status_code >= 400
    assert "already has" in r.text and "kwh" in r.text
    assert _scenarios(client, token) == []

    # A real variation is untouched, and so is an override for a parameter this model does not have
    # (the import path reports those, and better).
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})
    assert sid


def test_a_variant_that_grew_into_a_copy_is_reported_rather_than_refused(client, token, project):
    """The other half: the scenario was meaningful when it was typed and the baseline moved to meet it.

    Nothing can be refused after the fact, so the scenario says so — and the report's sensitivity
    check says it in words, because a table of identical rows looks exactly like a robust result.
    """
    from prism_lca.engine import report_checks

    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    _mk(client, token, "efficient", overrides={"kwh": 1.0})
    assert [s["ineffective"] for s in _scenarios(client, token)] == [[]]

    _param(client, token, "kwh", amount=1.0)  # the baseline moves onto the scenario
    assert [s["ineffective"] for s in _scenarios(client, token)] == [["kwh"]]

    data = {
        "subjects": [
            {"label": "Baseline", "results": [{"method_label": "gwp", "score": 0.6}]},
            {"label": "efficient", "scenario": "s1", "results": [{"method_label": "gwp", "score": 0.6}]},
            {"label": "heavier", "scenario": "s2", "results": [{"method_label": "gwp", "score": 1.1}]},
        ]
    }
    assert report_checks.unmoved_variants(data) == ["efficient"]
    assert report_checks.checks_summary(data)["unmoved_variants"] == ["efficient"]


# --- V331 / V332: several indicators in one request, and a note on a variant that barely moves ----


def test_compare_scores_several_indicators_per_applied_scenario(client, token, project):
    """One request, one apply per scenario, every indicator scored inside that window (V331)."""
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})
    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": "fg", "code": "bottle", "methods": [METHOD, METHOD], "scenario_ids": [sid]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    blocks = r.json()["results"]
    assert len(blocks) == 2 and blocks[0]["method"] == METHOD
    for block in blocks:
        scores = {x["scenario"]: x["score"] for x in block["results"]}
        assert abs(scores["(baseline)"] - 1.1) < 1e-6
        assert abs(scores["efficient"] - 0.6) < 1e-6
        assert abs(block["baseline_score"] - 1.1) < 1e-6
        eff = next(x for x in block["results"] if x["scenario"] == "efficient")
        assert abs(eff["delta_pct"] - (100.0 * (0.6 - 1.1) / 1.1)) < 1e-5
        assert "note" not in eff  # a 45 % move needs no explaining
    assert abs(_lcia(client, token) - 1.1) < 1e-6  # baseline restored


def test_a_variant_that_barely_moves_names_the_exchanges_its_overrides_reach(client, token, project):
    """V332: a run compared scenarios whose parameter reached only a side formula and read
    −0.1 % with nothing said. The row now says what the override reaches, so a typed constant that
    should have been a formula is visible in the answer that hid it."""
    _seed(get_bd())
    # `kwh` drives the exchange; `mass` is a parameter nothing references — a variant on it cannot move.
    _param(client, token, "kwh", amount=2.0)
    _param(client, token, "mass", amount=0.23)
    _formula(client, token, "bottle", "e", "kwh")
    dead = _mk(client, token, "heavier", overrides={"mass": 0.31})
    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": "fg", "code": "bottle", "method": METHOD, "scenario_ids": [dead]},
        headers=token,
    )
    row = next(x for x in r.json()["results"] if x["scenario"] == "heavier")
    assert abs(row["delta"]) < 1e-9
    assert "no exchange formula references 'mass'" in row["note"]
    assert "set_formula" in row["note"]


def test_a_variant_reaching_the_exchange_through_another_parameter_is_not_called_dead(client, token, project):
    """The note only saw parameters named ON an exchange; one feeding another
    parameter's formula was declared unable to move a result it had just moved."""
    _seed(get_bd())
    _param(client, token, "a", amount=100.0)
    _param(client, token, "b", formula="2*a")
    _formula(client, token, "bottle", "e", "b")
    nudge = _mk(client, token, "nudge", overrides={"a": 100.5})
    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": "fg", "code": "bottle", "method": METHOD, "scenario_ids": [nudge]},
        headers=token,
    )
    row = next(x for x in r.json()["results"] if x["scenario"] == "nudge")
    assert row["delta"] > 0
    assert "through other parameters" in row["note"]
    assert "cannot move" not in row["note"]


def test_a_slipped_scenario_id_is_refused_before_anything_is_calculated_with_the_closest_and_the_list(
    client, token, project, monkeypatch
):
    """A scenario id copied with a slip used to be found out inside the loop, after the baseline and the
    scenarios before it had been calculated, with a hint at an HTTP route. Refused up front now, naming the
    closest id with its scenario's name and the model's scenarios — a suggestion, never a substitution."""
    from prism_lca.engine import lca

    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    good = _mk(client, token, "efficient", overrides={"kwh": 1.0})
    other = _mk(client, token, "wasteful", overrides={"kwh": 3.0})
    slipped = good[:-3] + ("000" if not good.endswith("000") else "111")

    def no_calculation(*_a, **_k):
        raise AssertionError("calculated before the ids were checked")

    monkeypatch.setattr(lca, "compute_lcia", no_calculation)
    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_ids": [other, slipped]},
        headers=token,
    )
    assert r.status_code == 404, r.text
    body = r.json()
    text = f"{body.get('detail') or body.get('message') or body.get('error')} {body.get('hint')}"
    assert "nothing was calculated" in text
    assert f"Closest id to '{slipped}': '{good}' ('efficient')" in text
    assert "use it only if that is the scenario you meant" in text
    assert f"'efficient' = {good}" in text and f"'wasteful' = {other}" in text
    assert "/api/v1" not in text and "list_scenarios" in text


def test_a_scenario_name_passed_as_its_id_is_answered_with_the_id(client, token, project):
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    sid = _mk(client, token, "Efficient line", overrides={"kwh": 1.0})
    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_ids": ["efficient line"]},
        headers=token,
    )
    assert r.status_code == 404
    assert f"is the name of a scenario, not its id: its id is '{sid}'" in r.text


def test_a_scenario_edited_while_the_comparison_runs_is_scored_as_it_is_then(client, token, project, monkeypatch):
    """The ids are checked up front, but each scenario is read when it is applied: an override changed during
    the baseline calculation is the one scored, not a copy taken before."""
    from prism_lca.engine import lca
    from prism_lca.engine.scenarios import ScenarioStore

    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})
    real = lca.compute_lcia
    calls = []

    def edit_during_baseline(*a, **k):
        if not calls:
            ScenarioStore().set_value(sid, "kwh", 3.0)
        calls.append(1)
        return real(*a, **k)

    monkeypatch.setattr(lca, "compute_lcia", edit_during_baseline)
    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_ids": [sid]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    scores = {x["scenario"]: x["score"] for x in r.json()["results"]}
    assert abs(scores["efficient"] - 1.6) < 1e-6  # 0.1 + 3 kWh x 0.5, not the 0.6 of before the edit


def test_a_scenario_subject_gets_scores_and_split_from_one_window(client, token, project, monkeypatch):
    """Asked in two requests, a scenario subject paid two parameter windows — apply, factorise, restore —
    for numbers one window holds. With `stacked_dimensions` the split comes along, and it is the split
    `compare-stacked` gives for the same subject: same numbers, the scenario's, not the baseline's."""
    from prism_lca.engine import params as params_engine

    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})
    subjects = [
        {"database": DB, "code": "bottle", "label": "Baseline"},
        {"database": DB, "code": "bottle", "scenario": sid, "label": "efficient"},
    ]
    writes: list[int] = []
    real = params_engine.apply_values
    monkeypatch.setattr(
        params_engine, "apply_values", lambda *a, **k: writes.append(1) or real(*a, **k)
    )

    together = client.post(
        "/api/v1/calc/compare",
        json={"subjects": subjects, "methods": [METHOD], "stacked_dimensions": ["geo"]},
        headers=token,
    )
    assert together.status_code == 200, together.text
    assert len(writes) == 2  # the scenario's apply + restore, once
    apart = client.post(
        "/api/v1/calc/compare-stacked",
        json={"subjects": subjects, "methods": [METHOD], "dimensions": ["geo"]},
        headers=token,
    )
    assert apart.status_code == 200, apart.text

    body = together.json()
    key = body["methods"][0]["key"]
    assert [s["scores"][key] for s in body["subjects"]] == [
        pytest.approx(1.1), pytest.approx(0.6)
    ]
    assert body["stacked"] == apart.json()
    assert [s["methods"][key]["total"] for s in body["stacked"]["subjects"]] == [
        pytest.approx(1.1), pytest.approx(0.6)
    ]


def test_without_stacked_dimensions_the_answer_carries_no_split(client, token, project):
    _seed(get_bd())
    r = client.post(
        "/api/v1/calc/compare",
        json={"subjects": [{"database": DB, "code": "bottle"}], "methods": [METHOD]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert "stacked" not in r.json()


def test_a_split_that_cannot_be_computed_does_not_cost_the_scores(client, token, project, monkeypatch):
    """Asked apart, a failing split left the scores standing and said why afterwards. Asked together it
    must do the same: the scores come back, the split is left out, and the caller asks for it on its own."""
    from prism_lca.engine import compare as compare_engine
    from prism_lca.engine import params as params_engine
    from prism_lca.errors import PrismError

    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _formula(client, token, "bottle", "e", "kwh")
    sid = _mk(client, token, "efficient", overrides={"kwh": 1.0})

    def failing(*args, **kwargs):
        raise PrismError("This model cannot be split by that tag family.", code="breakdown_failed")

    monkeypatch.setattr(compare_engine.lca, "compare_stacked", failing)
    r = client.post(
        "/api/v1/calc/compare",
        json={
            "subjects": [{"database": DB, "code": "bottle", "scenario": sid, "label": "efficient"}],
            "methods": [METHOD],
            "stacked_dimensions": ["tag:Phase"],
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["subjects"][0]["scores"][body["methods"][0]["key"]] == pytest.approx(0.6)
    assert body["stacked"]["subjects"] == []
    # …and the window closed behind it: the baseline is back.
    assert params_engine.snapshot_all(DB)["kwh"] == pytest.approx(2.0)


def test_merged_splits_keep_the_first_name_of_a_key():
    """One traversal of all subjects names a CPC code after the first activity that carries a name; a
    subject whose activities carry none must not turn it back into the bare code."""
    from prism_lca.engine.compare import _merged_stacked

    def part(label: str, cpc_label: str) -> dict:
        return {
            "subjects": [{"label": label}],
            "keys": {"cpc": ["01341"]},
            "labels": {"cpc": {"01341": cpc_label}},
            "dimensions": ["cpc"],
        }

    named, bare = part("A", "01341 — Apples"), part("B", "01341")
    for parts in ([named, bare], [bare, named]):
        merged = _merged_stacked(parts, ["cpc"])
        assert merged["labels"]["cpc"] == {"01341": "01341 — Apples"}
        assert merged["keys"]["cpc"] == ["01341"]
    assert [s["label"] for s in _merged_stacked([named, bare], ["cpc"])["subjects"]] == ["A", "B"]
