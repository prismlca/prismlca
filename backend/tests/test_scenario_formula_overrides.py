"""Scenarios that override a formula-driven parameter, or override with a formula.

The defect: `b = 2*a`, a scenario says `b = 6`, the window wrote 6 into `b`, the recalculation that
followed put `2*a` back — and the comparison said Δ 0 as though the variant had been computed. Now the
override replaces the formula for the length of the window, the restore puts it back (also after a
crash, via the marker), and an override may itself be a formula.

The model: `a` = 1, `b` = "2*a"; the bottle's electricity exchange is driven by `b`. Score per bottle =
0.5 * b + 0.1 (electricity 0.5 kg CO2/kWh, 0.1 kg direct).
"""
from __future__ import annotations

import pytest

from prism_lca.app import create_app
from prism_lca.engine import param_window, params, scenarios
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.scenarios import ScenarioStore

METHOD = ["test", "gwp"]
DB = "fg"


@pytest.fixture(autouse=True)
def _no_leftover_marker():
    yield
    param_window.reset_for_tests()


def _score(b: float) -> float:
    return 0.5 * b + 0.1


def _model(client, token, rule: dict | None = None) -> None:
    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    fg = bd.Database(DB)
    fg.write(
        {
            (DB, "elec"): {
                "name": "electricity", "unit": "kWh", "reference product": "electricity",
                "exchanges": [
                    {"input": (DB, "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            (DB, "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle",
                "exchanges": [
                    {"input": (DB, "bottle"), "amount": 1, "type": "production"},
                    {"input": (DB, "elec"), "amount": 0.0, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    for e in fg.get("bottle").technosphere():
        e["prism_uid"] = "e"
        e.save()
    bd.databases[DB]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])
    for body in ({"name": "a", "amount": 1.0}, {"name": "b", "formula": "2*a", **({"rule": rule} if rule else {})}):
        r = client.post("/api/v1/params", json={"database": DB, **body}, headers=token)
        assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": DB, "activity_code": "bottle", "uid": "e", "formula": "b"},
        headers=token,
    )
    assert r.status_code == 200, r.text


def _scenario(client, token, overrides: dict, name="variant"):
    return client.post("/api/v1/scenarios", json={"database": DB, "name": name, "overrides": overrides}, headers=token)


def _sid(client, token, overrides: dict, name="variant") -> str:
    r = _scenario(client, token, overrides, name)
    assert r.status_code == 200, r.text
    return r.json()["scenario"]["id"]


def _compute(client, token, sid: str) -> dict:
    r = client.post(
        "/api/v1/scenarios/compute",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_id": sid},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _assert_baseline_back() -> None:
    assert params.snapshot_formulas(DB)["b"] == "2*a"
    assert params.snapshot_all(DB)["b"] == pytest.approx(2.0)
    assert params.snapshot_formulas(DB)["a"] is None
    assert params.snapshot_all(DB)["a"] == pytest.approx(1.0)


# --------------------------------------------------------------------------- #
# (a) a number on a formula parameter takes effect — on every path
# --------------------------------------------------------------------------- #
def test_a_number_on_a_formula_parameter_moves_the_result(client, token, project):
    _model(client, token)
    sid = _sid(client, token, {"b": 6})

    result = _compute(client, token, sid)
    assert result["score"] == pytest.approx(_score(6))
    assert result["replaces_formula"] == {"b": "2*a"}
    _assert_baseline_back()
    assert not param_window.path().exists()

    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_ids": [sid]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    rows = r.json()["results"]
    assert rows[0]["score"] == pytest.approx(_score(2))
    assert rows[1]["score"] == pytest.approx(_score(6))
    assert rows[1]["replaces_formula"] == {"b": "2*a"}
    assert "replaces_formula" not in rows[0]
    _assert_baseline_back()

    with scenarios.applied(ScenarioStore(), DB, sid):
        assert params.snapshot_formulas(DB)["b"] is None
        assert params.snapshot_all(DB)["b"] == pytest.approx(6.0)
    _assert_baseline_back()

    # The Results page's pipeline (engine/compare.py).
    r = client.post(
        "/api/v1/calc/compare",
        json={"subjects": [{"database": DB, "code": "bottle"}, {"database": DB, "code": "bottle", "scenario": sid}],
              "methods": [METHOD]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    subjects = r.json()["subjects"]
    assert list(subjects[1]["scores"].values())[0] == pytest.approx(_score(6))
    assert subjects[1]["replaces_formula"] == {"b": "2*a"}
    _assert_baseline_back()


def test_a_comparison_puts_a_formula_back_between_two_scenarios(client, token, project):
    """Scenario 1 takes `b`'s formula out; scenario 2 moves `a` only and must see `b = 2*a` again."""
    _model(client, token)
    first = _sid(client, token, {"b": 6}, name="b fixed")
    second = _sid(client, token, {"a": 3}, name="a up")
    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_ids": [first, second]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    rows = r.json()["results"]
    assert [row["score"] for row in rows] == pytest.approx([_score(2), _score(6), _score(6)])
    assert "replaces_formula" not in rows[2]
    _assert_baseline_back()


# --------------------------------------------------------------------------- #
# (c) a formula as the override
# --------------------------------------------------------------------------- #
def test_a_formula_override_is_evaluated_in_the_model_namespace(client, token, project):
    _model(client, token)
    sid = _sid(client, token, {"b": "3 * a"})
    result = _compute(client, token, sid)
    assert result["score"] == pytest.approx(_score(3))
    assert result["replaces_formula"] == {"b": "2*a"}
    _assert_baseline_back()

    # …with the scenario's other overrides in its namespace.
    both = _sid(client, token, {"a": 2, "b": "3 * a"}, name="both")
    assert _compute(client, token, both)["score"] == pytest.approx(_score(6))
    _assert_baseline_back()


def test_a_formula_override_on_a_plain_parameter_is_undone_too(client, token, project):
    _model(client, token)
    sid = _sid(client, token, {"a": "1.5 + 1.5"})
    result = _compute(client, token, sid)
    assert result["score"] == pytest.approx(_score(6))
    assert "replaces_formula" not in result  # `a` had no formula to replace
    _assert_baseline_back()


def test_set_value_takes_a_formula(client, token, project):
    _model(client, token)
    sid = _sid(client, token, {"a": 2})
    r = client.post("/api/v1/scenarios/value", json={"id": sid, "param": "b", "value": "a * 4"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["overrides"] == {"a": 2.0, "b": "a * 4"}
    assert _compute(client, token, sid)["score"] == pytest.approx(_score(8))


def test_a_numeric_string_stays_a_number(client, token, project):
    _model(client, token)
    sid = _sid(client, token, {"a": "2"})
    assert ScenarioStore().get(sid)["overrides"] == {"a": 2.0}


def test_the_parameters_own_formula_is_an_ineffective_override(client, token, project):
    _model(client, token)
    r = _scenario(client, token, {"b": "2 * a"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "scenario_override_is_baseline"


# --------------------------------------------------------------------------- #
# (d) a formula that cannot be evaluated is refused on the way in
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("overrides", "needle"),
    [
        ({"b": "3 * nope"}, "nope"),       # unknown name
        ({"b": "3 *"}, "not valid"),       # syntax
        ({"b": "b * 2"}, "itself"),        # self reference
        ({"a": "b + 1"}, "circular"),      # a -> b -> a
        ({"b": "'text'"}, "number"),       # not a number
    ],
)
def test_an_invalid_formula_override_is_refused(client, token, project, overrides, needle):
    _model(client, token)
    r = _scenario(client, token, overrides)
    assert r.status_code == 400, r.text
    err = r.json()["error"]
    assert err["code"] == "formula_error", err
    assert needle in err["message"], err["message"]
    assert "'variant'" in err["message"]
    assert client.get(f"/api/v1/scenarios?database={DB}", headers=token).json() == []


def test_a_formula_override_is_held_to_the_parameters_rule(client, token, project):
    _model(client, token, rule={"kind": "range", "min": 0, "max": 5})
    r = _scenario(client, token, {"b": "10 * a"})
    assert r.status_code == 400, r.text
    assert "b" in r.json()["error"]["message"]
    assert _scenario(client, token, {"b": "4 * a"}).status_code == 200


def test_the_rule_is_checked_again_when_the_baseline_moved(client, token, project):
    """Stored when `a` = 1 (b = 4, allowed); `a` moved to 2 since, so b = 8 breaks b's rule."""
    _model(client, token, rule={"kind": "range", "min": 0, "max": 5})
    sid = _sid(client, token, {"b": "4 * a"})
    assert client.post("/api/v1/params", json={"database": DB, "name": "a", "amount": 2.0}, headers=token).status_code == 200
    r = client.post(
        "/api/v1/scenarios/compute",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_id": sid},
        headers=token,
    )
    assert r.status_code == 400, r.text
    assert params.snapshot_formulas(DB)["b"] == "2*a"
    assert not param_window.path().exists()


# --------------------------------------------------------------------------- #
# (b) the restore puts the formula back — also after a crash
# --------------------------------------------------------------------------- #
def _crash_inside(overrides: dict) -> None:
    """Enter a window exactly as the scenario paths do, then 'die': the marker stays on disk and the
    process forgets its frame, as a killed process would."""
    baseline = params.snapshot_all(DB)
    applied = scenarios.Plan(overrides, params.snapshot_formulas(DB))
    param_window.open_window(DB, "scenario", "variant", baseline, applied.numbers, applied.replaced)
    params.apply_values(DB, {**baseline, **applied.numbers}, applied.formulas)
    param_window._frames.clear()


@pytest.mark.parametrize("overrides", [{"b": 6.0}, {"b": "3 * a"}, {"a": "4"}, {"a": "2 + 2"}])
def test_a_crash_inside_the_window_is_undone_on_start_formula_included(client, token, project, settings, overrides):
    _model(client, token)
    clean = (params.snapshot_formulas(DB), params.snapshot_all(DB))
    _crash_inside(overrides)
    assert (params.snapshot_formulas(DB), params.snapshot_all(DB)) != clean  # the crash left it perturbed
    create_app(settings)  # what a restart runs
    _assert_baseline_back()
    assert not param_window.path().exists()


def test_a_formula_edited_after_the_crash_is_reported_not_overwritten(client, token, project, settings):
    _model(client, token)
    _crash_inside({"b": "3 * a"})
    # The author typed a new formula between the crash and the restart.
    from bw2data.parameters import DatabaseParameter

    row = DatabaseParameter.get(DatabaseParameter.database == DB, DatabaseParameter.name == "b")
    row.formula = "5 * a"
    row.save()
    create_app(settings)
    assert params.snapshot_formulas(DB)["b"] == "5 * a"
    left = param_window.unresolved(DB)
    assert left is not None and left["parameters"] == ["b"]
    assert "formula 5 * a" in left["message"] and "formula 2*a" in left["message"]


def test_a_marker_without_formulas_is_still_version_1(client, token, project):
    _model(client, token)
    baseline = params.snapshot_all(DB)
    frame = param_window.open_window(DB, "scenario", "plain", baseline, {"a": 2.0})
    try:
        assert param_window.read()["version"] == 1
    finally:
        param_window.restore_and_close(DB, baseline, frame)
    frame = param_window.open_window(
        DB, "scenario", "formula", baseline, {}, {"b": {"baseline": "2*a", "wrote": "3*a"}}
    )
    try:
        assert param_window.read()["version"] == 2
    finally:
        param_window.restore_and_close(DB, baseline, frame)
    _assert_baseline_back()


# --------------------------------------------------------------------------- #
# Regressions found after the first implementation
# --------------------------------------------------------------------------- #
def _xlsx(rows: list[list]) -> str:
    import base64
    import io

    from openpyxl import Workbook

    wb = Workbook()
    for row in rows:
        wb.active.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_an_import_refused_after_merging_leaves_nothing_behind(client, token, project):
    """Each column passes alone; merged into the stored `b = "4*a"`, `a = 3` breaks b's rule. The column
    before it must not have been stored by a command that then failed."""
    _model(client, token, rule={"kind": "range", "min": 0, "max": 10})
    _sid(client, token, {"a": 2, "b": "4*a"}, name="S")
    before = client.get(f"/api/v1/scenarios?database={DB}", headers=token).json()
    xlsx = _xlsx([["parameter", "New", "S"], ["a", 1.5, 3]])
    r = client.post("/api/v1/scenarios/import", json={"database": DB, "xlsx_base64": xlsx}, headers=token)
    assert r.status_code == 400, r.text
    after = client.get(f"/api/v1/scenarios?database={DB}", headers=token).json()
    assert after == before


def test_an_import_that_holds_is_written_and_undone_as_one_step(client, token, project):
    _model(client, token, rule={"kind": "range", "min": 0, "max": 10})
    _sid(client, token, {"a": 2, "b": "4*a"}, name="S")
    xlsx = _xlsx([["parameter", "New", "S", "New"], ["a", 1.5, 2.5, None], ["b", None, None, "3*a"]])
    r = client.post("/api/v1/scenarios/import", json={"database": DB, "xlsx_base64": xlsx}, headers=token)
    assert r.status_code == 200, r.text
    assert (r.json()["created"], r.json()["overwritten"]) == (1, 2)  # the second "New" merges into the first
    by_name = {s["name"]: s["overrides"] for s in client.get(f"/api/v1/scenarios?database={DB}", headers=token).json()}
    assert by_name == {"S": {"a": 2.5, "b": "4*a"}, "New": {"a": 1.5, "b": "3*a"}}
    assert client.post("/api/v1/model/undo", json={}, headers=token).status_code == 200
    by_name = {s["name"]: s["overrides"] for s in client.get(f"/api/v1/scenarios?database={DB}", headers=token).json()}
    assert by_name == {"S": {"a": 2.0, "b": "4*a"}}


def test_a_crash_in_the_next_scenario_of_a_comparison_is_still_restored(client, token, project, settings):
    """Scenario 1 gives the plain `a` a formula, scenario 2 a number. The marker must record that the
    formula went away again, or the restore takes `a = 6, no formula` for a hand edit."""
    _model(client, token)
    baseline = params.snapshot_all(DB)
    base_formulas = params.snapshot_formulas(DB)
    frame = param_window.open_window(DB, "comparison", "a scenario comparison", baseline, {})
    for overrides in ({"a": "1.5 * 2"}, {"a": 6.0}):
        applied = scenarios.Plan(overrides, base_formulas)
        param_window.set_overrides(frame, applied.numbers, applied.replaced)
        params.apply_values(DB, {**baseline, **applied.numbers}, applied.formulas)
    assert frame["formulas"]["a"] == {"baseline": None, "wrote": None}
    param_window._frames.clear()  # the process dies inside the second scenario
    create_app(settings)
    _assert_baseline_back()
    assert not param_window.path().exists()


def test_a_number_on_a_formula_parameter_is_not_ineffective_when_its_inputs_move(client, token, project):
    """{a: 3, b: 2} holds b at 2 while a moves; without the b override b would follow a to 6."""
    _model(client, token)
    sid = _sid(client, token, {"a": 3, "b": 2})
    assert _compute(client, token, sid)["score"] == pytest.approx(_score(2))
    listed = client.get(f"/api/v1/scenarios?database={DB}", headers=token).json()
    assert listed[0]["ineffective"] == []
    r = client.post("/api/v1/scenarios/value", json={"id": sid, "param": "b", "value": 2}, headers=token)
    assert r.status_code == 200, r.text
    # …while b = 2 with nothing else moved is still the baseline under another name.
    r = _scenario(client, token, {"b": 2}, name="same")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "scenario_override_is_baseline"


# --------------------------------------------------------------------------- #
# Further regressions, second pass
# --------------------------------------------------------------------------- #
def _elec_amount() -> float:
    return next(iter(get_bd().Database(DB).get("bottle").technosphere()))["amount"]


def _set_row(name: str, amount: float, formula: str | None) -> None:
    """A parameter row written without any recalculation — a restore that died half way."""
    from bw2data.parameters import DatabaseParameter

    row = DatabaseParameter.get(DatabaseParameter.database == DB, DatabaseParameter.name == name)
    row.amount, row.formula = amount, formula
    row.save()


def test_a_restore_that_died_before_recalculating_is_finished_on_start(client, token, project, settings):
    """Parameters back, exchanges not: the marker must not be cleared over exchanges computed from the
    scenario (the electricity exchange would stay at b = 6)."""
    _model(client, token)
    _crash_inside({"b": 6.0})
    assert _elec_amount() == pytest.approx(6.0)
    _set_row("b", 2.0, "2*a")  # the parameter half of the restore, and then the process died
    create_app(settings)
    assert _elec_amount() == pytest.approx(2.0)
    _assert_baseline_back()
    assert not param_window.path().exists()


def test_a_crash_between_marking_a_transition_and_writing_it_is_restored(client, token, project, settings):
    """{b: 6} → {b: "3*a"} → {a: 4}; the process dies after the marker names the third scenario and
    before its write — b still holds PrismLCA's own "3*a", which the marker must accept as ours."""
    _model(client, token)
    baseline = params.snapshot_all(DB)
    base_formulas = params.snapshot_formulas(DB)
    frame = param_window.open_window(DB, "comparison", "a scenario comparison", baseline, {})
    for overrides in ({"b": 6.0}, {"b": "3*a"}):
        applied = scenarios.Plan(overrides, base_formulas)
        param_window.set_overrides(frame, applied.numbers, applied.replaced)
        params.apply_values(DB, {**baseline, **applied.numbers}, applied.formulas)
        param_window.settle(frame)
    third = scenarios.Plan({"a": 4.0}, base_formulas)
    param_window.set_overrides(frame, third.numbers, third.replaced)  # …and the write never happens
    assert params.snapshot_formulas(DB)["b"] == "3*a"
    param_window._frames.clear()
    create_app(settings)
    _assert_baseline_back()
    assert _elec_amount() == pytest.approx(2.0)
    assert not param_window.path().exists()


def test_validation_waits_for_a_scenario_held_applied_by_another_thread(client, token, project):
    """While another thread holds {a: 3} applied, b holds 6; judged then, {b: 2} would look effective.
    The check has to wait for the baseline."""
    import threading

    _model(client, token)
    sid = _sid(client, token, {"a": 3}, name="a up")
    inside, release = threading.Event(), threading.Event()

    def hold() -> None:
        with scenarios.applied(ScenarioStore(), DB, sid):
            inside.set()
            release.wait(5)

    holder = threading.Thread(target=hold)
    holder.start()
    assert inside.wait(5)
    answer: list = []
    checker = threading.Thread(target=lambda: answer.append(scenarios.ineffective_overrides(DB, {"b": 2})))
    checker.start()
    checker.join(0.3)
    assert checker.is_alive(), "the check read the model while a scenario was applied"
    release.set()
    holder.join(5)
    checker.join(5)
    assert answer == [["b"]]


def test_a_single_value_is_judged_with_one_snapshot_and_two_evaluations(client, token, project, monkeypatch):
    _model(client, token)
    for i in range(20):
        r = client.post("/api/v1/params", json={"database": DB, "name": f"c{i}", "formula": "2*a"}, headers=token)
        assert r.status_code == 200, r.text
    overrides = {f"c{i}": 2.0 for i in range(20)}
    calls = {"eval": 0, "ns": 0}
    real_eval, real_ns = params.evaluate_overrides, params.parameter_namespace

    def counting_eval(*a, **k):
        calls["eval"] += 1
        return real_eval(*a, **k)

    def counting_ns(*a, **k):
        calls["ns"] += 1
        return real_ns(*a, **k)

    monkeypatch.setattr(params, "evaluate_overrides", counting_eval)
    monkeypatch.setattr(params, "parameter_namespace", counting_ns)
    assert scenarios.ineffective_overrides(DB, overrides, only={"c0"}) == ["c0"]
    assert calls == {"eval": 2, "ns": 1}


def test_a_set_the_model_cannot_be_evaluated_under_is_refused_and_shown(client, token, project):
    """a = 1, d = 1, b = "2*d", c = "1/(2-a)": {a: 2, b: 2} divides by zero in c. Refused on the way in;
    stored anyway (an older store), the list says why instead of calling b effective."""
    _model(client, token)
    for body in ({"name": "d", "amount": 1.0}, {"name": "b", "formula": "2*d"}, {"name": "c", "formula": "1/(2-a)"}):
        assert client.post("/api/v1/params", json={"database": DB, **body}, headers=token).status_code == 200
    r = _scenario(client, token, {"a": 2, "b": 2})
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "formula_error"
    assert "division by zero" in r.json()["error"]["message"]

    sid = _sid(client, token, {"a": 1.5}, name="ok")
    r = client.post("/api/v1/scenarios/value", json={"id": sid, "param": "a", "value": 2}, headers=token)
    assert r.status_code == 400, r.text
    entry = ScenarioStore().get(sid)
    ScenarioStore().put(sid, {**entry, "overrides": {"a": 2.0, "b": 2.0}})
    listed = client.get(f"/api/v1/scenarios?database={DB}", headers=token).json()
    assert listed[0]["ineffective"] == []
    assert "division by zero" in listed[0]["evaluation_error"]


def test_an_import_does_not_read_the_store_again_after_writing(client, token, project, monkeypatch):
    _model(client, token)
    xlsx = _xlsx([["parameter", "New"], ["a", 1.5]])

    def broken(self, database):
        raise OSError("disk went away")

    monkeypatch.setattr(ScenarioStore, "list_all", broken)
    r = client.post("/api/v1/scenarios/import", json={"database": DB, "xlsx_base64": xlsx}, headers=token)
    assert r.status_code == 200, r.text
    assert [s["name"] for s in r.json()["scenarios"]] == ["New"]
    monkeypatch.undo()
    # …and it is on the undo stack, because the command did not fail.
    assert client.post("/api/v1/model/undo", json={}, headers=token).status_code == 200
    assert client.get(f"/api/v1/scenarios?database={DB}", headers=token).json() == []


def test_undoing_an_import_is_one_write(client, token, project, monkeypatch):
    _model(client, token)
    _sid(client, token, {"a": 2}, name="S")
    xlsx = _xlsx([["parameter", "New", "S"], ["a", 1.5, 2.5]])
    assert client.post("/api/v1/scenarios/import", json={"database": DB, "xlsx_base64": xlsx}, headers=token).status_code == 200
    imported = ScenarioStore().list_all(DB)
    writes = {"n": 0}
    real = ScenarioStore._write

    def failing(self, data):
        writes["n"] += 1
        raise OSError("disk full")

    monkeypatch.setattr(ScenarioStore, "_write", failing)
    try:
        r = client.post("/api/v1/model/undo", json={}, headers=token)
        assert r.status_code >= 400
    except OSError:
        pass  # the test client re-raises what the app did not turn into an answer
    assert writes["n"] == 1
    assert ScenarioStore().list_all(DB) == imported  # nothing half reverted
    monkeypatch.setattr(ScenarioStore, "_write", real)


# --------------------------------------------------------------------------- #
# Further regressions, third pass
# --------------------------------------------------------------------------- #
def test_scenario_commands_never_reach_for_the_calculation_lock(client, token, project):
    """The parameter routes take the LCA lock BEFORE the command bus; a scenario command that took it
    inside the bus deadlocked against them. While another thread holds the LCA lock, create, set_value,
    undo and redo of scenario commands must all finish."""
    import threading

    from prism_lca.engine import commands, lca

    _model(client, token)
    bus = client.app.state.command_bus
    store = ScenarioStore()
    held, release = threading.Event(), threading.Event()

    def hold() -> None:
        with lca._LCA_LOCK:
            held.set()
            release.wait(10)

    done: list[str] = []

    def work() -> None:
        created = bus.execute(commands.CreateScenarioCommand(store, DB, "v", "", {"a": 2}))
        sid = created["scenario"]["id"]
        bus.execute(commands.SetScenarioValueCommand(store, sid, "b", "3*a"))
        bus.undo()
        bus.redo()
        done.append(sid)

    holder = threading.Thread(target=hold)
    holder.start()
    assert held.wait(5)
    worker = threading.Thread(target=work)
    worker.start()
    worker.join(5)
    finished = not worker.is_alive()
    release.set()
    holder.join(5)
    worker.join(5)
    assert finished, "a scenario command waited for the calculation lock inside the bus lock"
    assert ScenarioStore().get(done[0])["overrides"] == {"a": 2.0, "b": "3*a"}


def test_the_scenario_write_routes_run_off_the_event_loop(client):
    """Waiting for the calculation lock inside an `async def` stalled every other request."""
    import inspect

    from prism_lca.api.v1 import scenarios as scenario_routes

    del client
    writes = {"", "/update", "/duplicate", "/value", "/delete", "/import"}
    found = {}
    for route in scenario_routes.router.routes:
        path = getattr(route, "path", "")
        if "POST" in getattr(route, "methods", set()):
            found[path.removeprefix("/scenarios")] = inspect.iscoroutinefunction(route.endpoint)
    assert writes <= set(found), found
    assert not any(found[p] for p in writes), found


def test_a_sweep_step_is_settled_so_a_later_hand_edit_survives_a_crash(client, token, project, settings):
    """A sweep writes a = 2, then a = 3, and the process dies. The author then sets a = 2 by hand: that is
    theirs now, not the sweep's earlier step, and must not be taken back to 1."""
    from prism_lca.engine import sensitivity

    _model(client, token)
    base = params.snapshot_all(DB)
    formulas = params.snapshot_formulas(DB)
    frame = param_window.open_window(DB, "sensitivity", "sensitivity sweep of 'a'", base, {})
    sensitivity._apply(DB, frame, base, {"a": 2.0}, formulas)
    sensitivity._apply(DB, frame, base, {"a": 3.0}, formulas)
    param_window._frames.clear()
    params.apply_values(DB, {"a": 2.0})  # the hand edit after the crash
    create_app(settings)
    assert params.snapshot_all(DB)["a"] == pytest.approx(2.0)
    left = param_window.unresolved(DB)
    assert left is not None and left["parameters"] == ["a"]


def test_listing_scenarios_reads_the_model_once(client, token, project, monkeypatch):
    _model(client, token)
    for i in range(5):
        _sid(client, token, {"a": 2.0 + i}, name=f"s{i}")
    calls = {"eval": 0, "ns": 0}
    real_eval, real_ns = params.evaluate_overrides, params.parameter_namespace

    def counting_eval(*a, **k):
        calls["eval"] += 1
        return real_eval(*a, **k)

    def counting_ns(*a, **k):
        calls["ns"] += 1
        return real_ns(*a, **k)

    monkeypatch.setattr(params, "evaluate_overrides", counting_eval)
    monkeypatch.setattr(params, "parameter_namespace", counting_ns)
    listed = client.get(f"/api/v1/scenarios?database={DB}", headers=token).json()
    assert len(listed) == 5
    assert calls["ns"] == 1
    assert calls["eval"] <= 5 + 1, calls


def test_a_restore_whose_exchange_recalculation_fails_keeps_the_marker(client, token, project, settings, monkeypatch):
    """The ordinary recalculation swallows a failing exchange formula; the crash restore must not, or it
    clears its marker over exchanges still computed from the scenario."""
    from bw2data.parameters import ActivityParameter

    _model(client, token)
    _crash_inside({"b": 6.0})
    _set_row("b", 2.0, "2*a")

    def broken(group):
        raise ZeroDivisionError("division by zero")

    monkeypatch.setattr(ActivityParameter, "recalculate_exchanges", staticmethod(broken))
    create_app(settings)
    assert param_window.path().exists()
    assert _elec_amount() == pytest.approx(6.0)
