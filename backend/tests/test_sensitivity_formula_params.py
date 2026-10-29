"""Sensitivity runs on a formula-driven parameter (follow-up to the formula-override work).

The defect: `b = 2*a`, a sweep writes `b = 6`, the recalculation puts `2*a` straight back, and every
point scores the baseline — the sensitivity of `b` was silently zero, and the tornado showed it with
swing 0. Now each step goes through `scenarios.Plan`: the formula is out for the step, the marker names
it, the restore (also after a crash) puts it back, and the answer says which formula was set aside.

Model as in test_scenario_formula_overrides: `a` = 1, `b` = "2*a", the bottle's electricity exchange
is driven by `b`; score per bottle = 0.5 * b + 0.1.
"""
from __future__ import annotations

import threading

import pytest
from test_scenario_formula_overrides import DB, METHOD, _assert_baseline_back, _model, _score

from prism_lca.app import create_app
from prism_lca.engine import param_window, params, sensitivity
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.scenarios import ScenarioStore


@pytest.fixture(autouse=True)
def _no_leftover_marker():
    yield
    param_window.reset_for_tests()


def _post(client, token, endpoint: str, body: dict):
    r = client.post(f"/api/v1/calc/sensitivity/{endpoint}", json={"database": DB, "method": METHOD, **body},
                    headers=token)
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- #
# (a) the variation of a formula parameter takes effect
# --------------------------------------------------------------------------- #
def test_a_sweep_of_a_formula_parameter_moves_the_result(client, token, project):
    _model(client, token)
    out = _post(client, token, "sweep", {"code": "bottle", "param": "b", "values": [2, 6, 10]})
    scores = {p["value"]: p["score"] for p in out["points"]}
    assert scores[6.0] == pytest.approx(_score(6))
    assert scores[10.0] == pytest.approx(_score(10))
    assert out["replaces_formula"] == "2*a"
    _assert_baseline_back()
    assert not param_window.path().exists()


def test_a_sweep_of_an_input_says_nothing_about_formulas(client, token, project):
    _model(client, token)
    out = _post(client, token, "sweep", {"code": "bottle", "param": "a", "values": [3]})
    assert out["points"][0]["score"] == pytest.approx(_score(6))  # b follows a
    assert "replaces_formula" not in out
    _assert_baseline_back()


def test_a_tornado_varies_only_the_inputs_unless_asked(client, token, project):
    _model(client, token)
    out = _post(client, token, "tornado", {"code": "bottle", "delta": 0.5})
    assert [e["param"] for e in out["entries"]] == ["a"]
    a = out["entries"][0]
    assert a["low"] == pytest.approx(_score(1)) and a["high"] == pytest.approx(_score(3))
    assert "replaces_formula" not in a
    assert out["skipped"] == [{"param": "b", "reason": "has_formula", "formula": "2*a"}]
    _assert_baseline_back()


def test_a_tornado_on_a_named_formula_parameter_says_what_it_broke(client, token, project):
    _model(client, token)
    out = _post(client, token, "tornado", {"code": "bottle", "delta": 0.5, "params": ["b", "a"]})
    by = {e["param"]: e for e in out["entries"]}
    assert by["b"]["low"] == pytest.approx(_score(1)) and by["b"]["high"] == pytest.approx(_score(3))
    assert by["b"]["swing"] == pytest.approx(1.0)
    assert by["b"]["replaces_formula"] == "2*a"
    # The step on `a` after the one on `b` sees `b = 2*a` again — its formula was put back between.
    assert by["a"]["low"] == pytest.approx(_score(1)) and by["a"]["high"] == pytest.approx(_score(3))
    assert "replaces_formula" not in by["a"]
    assert "skipped" not in out
    _assert_baseline_back()
    assert not param_window.path().exists()


def test_a_break_even_on_a_formula_parameter_is_found(client, token, project):
    _model(client, token)
    bd = get_bd()
    bd.Database(DB).new_activity(
        "alt", name="alt bottle", unit="unit", **{"reference product": "alt bottle"}
    ).save()
    alt = bd.get_activity((DB, "alt"))
    alt.new_exchange(input=alt.key, amount=1, type="production").save()
    alt.new_exchange(input=("biosphere", "co2"), amount=2.1, type="biosphere").save()
    out = _post(client, token, "breakeven", {"code_a": "bottle", "code_b": "alt", "param": "b",
                                            "lo": 0.0, "hi": 10.0})
    assert out["found"] is True
    assert out["value"] == pytest.approx(4.0, abs=1e-3)  # 0.5 b + 0.1 == 2.1
    assert out["replaces_formula"] == "2*a"
    _assert_baseline_back()


@pytest.mark.parametrize("endpoint,body", [
    ("sweep", {"code": "bottle", "param": "nope", "values": [1]}),
    ("breakeven", {"code_a": "bottle", "code_b": "bottle", "param": "nope", "lo": 0, "hi": 1}),
    ("tornado", {"code": "bottle", "params": ["nope"]}),
])
def test_an_unknown_parameter_is_refused_not_swept_flat(client, token, project, endpoint, body):
    _model(client, token)
    r = client.post(f"/api/v1/calc/sensitivity/{endpoint}", json={"database": DB, "method": METHOD, **body},
                    headers=token)
    assert r.status_code == 404, r.text
    assert r.json()["error"]["code"] == "param_not_found"
    assert not param_window.path().exists()


# --------------------------------------------------------------------------- #
# (b) the formula is back afterwards — also after a crash in the middle of a sweep
# --------------------------------------------------------------------------- #
def test_the_marker_names_the_formula_while_the_step_is_in(client, token, project, monkeypatch):
    _model(client, token)
    seen: list[dict] = []
    real = params.apply_values

    def watched(database, values, formulas=None):
        seen.append({"formulas": dict(formulas or {}), "marker": param_window.read()})
        return real(database, values, formulas)

    monkeypatch.setattr(params, "apply_values", watched)
    sensitivity.sweep(DB, "bottle", METHOD, "b", [5.0])
    step = next(s for s in seen if s["formulas"].get("b", "2*a") is None)
    frame = step["marker"]["frames"][0]
    assert step["marker"]["version"] == 2
    assert frame["formulas"]["b"] == {"baseline": "2*a", "wrote": None}
    assert frame["overrides"]["b"] == pytest.approx(5.0)


def test_a_crash_in_the_middle_of_a_sweep_puts_the_formula_back_on_start(client, token, project, settings):
    _model(client, token)
    base = params.snapshot_all(DB)
    base_formulas = params.snapshot_formulas(DB)
    frame = param_window.open_window(DB, "sensitivity", "sensitivity sweep of 'b'", base, {})
    sensitivity._apply(DB, frame, base, {"b": 6.0}, base_formulas)
    sensitivity._apply(DB, frame, base, {"b": 8.0}, base_formulas)
    assert params.snapshot_formulas(DB)["b"] is None and params.snapshot_all(DB)["b"] == pytest.approx(8.0)
    param_window._frames.clear()  # the process dies with b = 8 and no formula
    create_app(settings)  # what a restart runs
    _assert_baseline_back()
    assert not param_window.path().exists()


def test_a_crash_in_a_tornado_after_the_formula_step_is_restored_too(client, token, project, settings):
    """Step on `b` (formula out), then step on `a` (formula back in), then death: the marker must know
    `b` holds its own formula again, or the restore calls it a hand edit."""
    _model(client, token)
    base = params.snapshot_all(DB)
    base_formulas = params.snapshot_formulas(DB)
    frame = param_window.open_window(DB, "sensitivity", "one-at-a-time sensitivity analysis", base, {})
    sensitivity._apply(DB, frame, base, {"b": 3.0}, base_formulas)
    sensitivity._apply(DB, frame, base, {"a": 1.5}, base_formulas)
    assert params.snapshot_formulas(DB)["b"] == "2*a"
    param_window._frames.clear()
    create_app(settings)
    _assert_baseline_back()
    assert not param_window.path().exists()
    assert param_window.unresolved(DB) is None


def test_a_failing_step_still_restores_the_formula(client, token, project, monkeypatch):
    _model(client, token)
    real = sensitivity._score
    calls = {"n": 0}

    def boom(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("solver died")
        return real(*args, **kwargs)

    monkeypatch.setattr(sensitivity, "_score", boom)
    with pytest.raises(RuntimeError):
        sensitivity.sweep(DB, "bottle", METHOD, "b", [5.0, 6.0, 7.0])
    _assert_baseline_back()
    assert not param_window.path().exists()


# --------------------------------------------------------------------------- #
# (d) lock order LCA -> bus -> store: a sensitivity run takes neither of the latter
# --------------------------------------------------------------------------- #
def test_a_sensitivity_run_never_waits_for_the_bus_or_a_store(client, token, project):
    _model(client, token)
    bus = client.app.state.command_bus
    held, release = threading.Event(), threading.Event()

    def hold() -> None:
        with bus._lock, ScenarioStore()._lock:
            held.set()
            release.wait(20)

    result: list[dict] = []

    def work() -> None:
        result.append(sensitivity.tornado(DB, "bottle", METHOD, 0.5, names=["a", "b"]))
        result.append(sensitivity.sweep(DB, "bottle", METHOD, "b", [4.0]))
        result.append(sensitivity.breakeven(DB, "bottle", "bottle", METHOD, "b", 1.0, 2.0, iterations=2))

    holder = threading.Thread(target=hold)
    holder.start()
    assert held.wait(5)
    worker = threading.Thread(target=work)
    worker.start()
    worker.join(15)
    finished = not worker.is_alive()
    release.set()
    holder.join(5)
    worker.join(15)
    assert finished, "a sensitivity run waited for the command bus or the scenario store"
    assert len(result) == 3
    _assert_baseline_back()


# --------------------------------------------------------------------------- #
# Break-even: a jump is not a crossing, and two crossings are two
# --------------------------------------------------------------------------- #
def _bind_bottle(client, token, formula: str) -> None:
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": DB, "activity_code": "bottle", "uid": "e", "formula": formula},
        headers=token,
    )
    assert r.status_code == 200, r.text


def _reference(bd, co2: float) -> None:
    """A second subject with a fixed score, `co2` kg CO2."""
    bd.Database(DB).new_activity("ref", name="reference", unit="unit", **{"reference product": "reference"}).save()
    ref = bd.get_activity((DB, "ref"))
    ref.new_exchange(input=ref.key, amount=1, type="production").save()
    ref.new_exchange(input=("biosphere", "co2"), amount=co2, type="biosphere").save()


def _breakeven(client, token, **body) -> dict:
    return _post(client, token, "breakeven", {"code_a": "bottle", "code_b": "ref", "param": "b",
                                             "lo": 0.0, "hi": 10.0, **body})


def test_a_jump_across_the_other_score_is_not_a_break_even(client, token, project):
    """Bottle 0.1 kg below b = 4 and 2.1 kg from there on, against 1.1 kg: the difference goes from −1 to
    +1 with no point where it is 0. Bisection used to call the jump a root, residual 1."""
    _model(client, token)
    _reference(get_bd(), 1.1)
    _bind_bottle(client, token, "4 if b >= 4 else 0")
    out = _breakeven(client, token)
    assert out["found"] is False and out["value"] is None and out["roots"] == []
    assert out["reason"] == "discontinuity"
    assert out["discontinuities"][0]["value"] == pytest.approx(4.0, abs=1e-6)
    assert abs(out["discontinuities"][0]["difference"]) == pytest.approx(1.0)
    assert abs(out["best"]["difference"]) == pytest.approx(1.0)
    _assert_baseline_back()


def test_two_crossings_inside_the_bracket_are_both_found(client, token, project):
    """0.5 (b−2)(b−8) + 0.1 against 0.1: equal at b = 2 and b = 8. Both ends of [0, 10] have the same
    sign, and testing only the ends answered "no break-even"."""
    _model(client, token)
    _reference(get_bd(), 0.1)
    _bind_bottle(client, token, "(b - 2) * (b - 8) + 0.3")  # roots near 2.05 and 7.95, off the grid
    out = _breakeven(client, token)
    assert out["found"] is True
    roots = [5 - (9 - 0.3) ** 0.5, 5 + (9 - 0.3) ** 0.5]
    assert out["roots"] == pytest.approx(roots, abs=1e-6)
    assert out["value"] == pytest.approx(roots[0], abs=1e-6)
    assert "reason" not in out and "discontinuities" not in out
    _assert_baseline_back()


def test_no_sign_change_says_so_and_names_the_closest_point(client, token, project):
    _model(client, token)
    _reference(get_bd(), 0.0)  # bottle 0.5 b + 0.1 > 0 on the whole bracket
    out = _breakeven(client, token)
    assert out["found"] is False and out["reason"] == "no_sign_change"
    assert out["best"] == {"value": 0.0, "difference": pytest.approx(0.1)}


# --------------------------------------------------------------------------- #
# Recovery: only the step that is in the model makes a value ours
# --------------------------------------------------------------------------- #
def _open(base) -> dict:
    return param_window.open_window(DB, "sensitivity", "one-at-a-time sensitivity analysis", base, {})


def _bottle_state() -> tuple[float, float]:
    """The exchange the parameters drive, and the score — what a restore that skipped the
    recalculation would leave wrong while every parameter looks right."""
    from prism_lca.engine import lca

    bottle = get_bd().get_activity((DB, "bottle"))
    elec = next(e for e in bottle.technosphere() if e.input.key == (DB, "elec"))
    return float(elec["amount"]), lca.compute_lcia(DB, "bottle", METHOD, 1.0)["score"]


def test_a_hand_edit_equal_to_an_earlier_step_survives_a_crash(client, token, project, settings):
    """a = 1.5 (step 1), then b = 4 with a back at 1 (step 2), then death. The author sets a = 1.5. The
    marker named a = 1.5 as ours because step 1 once wrote it, and the restore took the edit back to 1."""
    _model(client, token)
    base, formulas = params.snapshot_all(DB), params.snapshot_formulas(DB)
    frame = _open(base)
    sensitivity._apply(DB, frame, base, {"a": 1.5}, formulas)
    sensitivity._apply(DB, frame, base, {"b": 4.0}, formulas)
    param_window._frames.clear()
    params.apply_values(DB, {"a": 1.5})  # the hand edit after the crash (b still a number: 4)
    create_app(settings)
    assert params.snapshot_all(DB)["a"] == pytest.approx(1.5)
    assert params.snapshot_formulas(DB)["b"] == "2*a"
    assert params.snapshot_all(DB)["b"] == pytest.approx(3.0)
    assert _bottle_state() == (pytest.approx(3.0), pytest.approx(_score(3)))


@pytest.mark.parametrize("first,second", [({"b": 6.0}, {"a": 1.5}), ({"a": 1.5}, {"b": 6.0})])
def test_a_crash_between_marking_a_step_and_writing_it_is_restored(client, token, project, settings,
                                                                    first, second):
    """The marker already names step 2, the model still holds step 1 (``pending``)."""
    _model(client, token)
    base, formulas = params.snapshot_all(DB), params.snapshot_formulas(DB)
    frame = _open(base)
    sensitivity._apply(DB, frame, base, first, formulas)
    step = scenarios_plan(second, formulas)
    param_window.set_overrides(frame, step.numbers, step.replaced)
    param_window._frames.clear()  # dies before the write
    create_app(settings)
    _assert_baseline_back()
    assert _bottle_state() == (pytest.approx(2.0), pytest.approx(_score(2)))
    assert not param_window.path().exists()


@pytest.mark.parametrize("first,second", [({"b": 6.0}, {"a": 1.5}), ({"a": 1.5}, {"b": 6.0})])
def test_a_crash_halfway_through_writing_a_step_is_restored(client, token, project, settings, first, second):
    """Step 2's write is row by row: the first row (`a`) is in, `b` still holds step 1, nothing was
    recalculated — so the exchange still holds step 1's amount."""
    from bw2data.parameters import DatabaseParameter

    _model(client, token)
    base, formulas = params.snapshot_all(DB), params.snapshot_formulas(DB)
    frame = _open(base)
    sensitivity._apply(DB, frame, base, first, formulas)
    step = scenarios_plan(second, formulas)
    param_window.set_overrides(frame, step.numbers, step.replaced)
    row = DatabaseParameter.get(DatabaseParameter.database == DB, DatabaseParameter.name == "a")
    row.amount = {**base, **step.numbers}["a"]
    row.formula = step.formulas["a"]
    row.save()
    param_window._frames.clear()  # dies before the row of `b` and before any recalculation
    assert _bottle_state()[0] != pytest.approx(2.0)  # the exchange is really left perturbed
    create_app(settings)
    _assert_baseline_back()
    assert _bottle_state() == (pytest.approx(2.0), pytest.approx(_score(2)))
    assert not param_window.path().exists()
    assert param_window.unresolved(DB) is None


def scenarios_plan(overrides: dict, formulas: dict):
    from prism_lca.engine import scenarios

    return scenarios.Plan(overrides, formulas)


# --------------------------------------------------------------------------- #
# Break-even tolerances near zero
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("ref", [0.0, 1e-20])
def test_a_smooth_crossing_at_zero_is_a_break_even(client, token, project, ref):
    """A = b − 0.3 against B = 0 (or 1e-20): both scores are ~0 at the crossing, and a tolerance
    relative to them THERE asked for exact equality — a smooth root was called a discontinuity."""
    _model(client, token)
    _reference(get_bd(), ref)
    _bind_bottle(client, token, "2 * (b - 0.3) - 0.2")  # score = 0.5 * that + 0.1 = b − 0.3
    out = _breakeven(client, token, lo=0.0, hi=1.0, samples=1)
    assert out["found"] is True, out
    assert out["value"] == pytest.approx(0.3, abs=1e-6)  # the solver works in single precision
    assert "discontinuities" not in out


def test_tiny_scores_of_one_sign_are_not_a_crossing(client, token, project, monkeypatch):
    """A = 1e-200 · (1 + b) against B = 0: the product of two differences underflowed to 0 and the
    scan took two positive values for a sign change — an invented discontinuity."""
    _model(client, token)

    def fake(database, code, method, amount):
        return 1e-200 * (1 + params.snapshot_all(DB)["b"]) if code == "bottle" else 0.0

    monkeypatch.setattr(sensitivity, "_score", fake)
    out = sensitivity.breakeven(DB, "bottle", "ref", METHOD, "b", 0.0, 10.0)
    assert out["found"] is False and out["reason"] == "no_sign_change"
    assert "discontinuities" not in out
    _assert_baseline_back()


# --------------------------------------------------------------------------- #
# A settle that cannot be written
# --------------------------------------------------------------------------- #
def _fail_settle_writes(monkeypatch) -> None:
    """Refuse exactly the marker writes `settle` makes: a frame past its first step, nothing pending."""
    real = param_window._write_frames

    def write(frames):
        if frames and frames[-1].get("current") and "pending" not in frames[-1]:
            raise OSError("disk full")
        return real(frames)

    monkeypatch.setattr(param_window, "_write_frames", write)


def test_a_step_whose_settle_cannot_be_recorded_stops_the_window(client, token, project, monkeypatch):
    """Left silent, the marker on disk kept owning the previous step (b = 6) — a crash later and a hand
    edit b = 6, and the recovery put `2*a` back over it."""
    from prism_lca.errors import PrismError

    _model(client, token)
    _fail_settle_writes(monkeypatch)
    with pytest.raises(PrismError) as info:
        sensitivity.sweep(DB, "bottle", METHOD, "b", [6.0, 7.0])
    assert info.value.code == "param_window_marker_failed"
    _assert_baseline_back()
    assert not param_window.path().exists()


def _stale_pending_frame(next_overrides: dict) -> list[dict]:
    """Step 1 wrote b = 6 (formula out), step 2 a = 1.5 (b's formula back); the pending of the
    transition to step 2 is still on disk."""
    return [{
        "kind": "sensitivity", "label": "x", "database": DB,
        "baseline": {"a": 1.0, "b": 2.0},
        "overrides": {"a": 1.5, "b": 6.0},
        "current": {"a": 1.5},
        "formulas": {"b": {"baseline": "2*a", "wrote": "2*a"}},
        "pending": {"overrides": {"b": 6.0}, "formulas": {"b": None},
                    "next": {"overrides": next_overrides, "formulas": {"b": "2*a"}}},
    }]


def test_a_spent_pending_does_not_own_the_previous_step():
    live, live_formulas = {"a": 1.0, "b": 6.0}, {"a": None, "b": None}  # the author typed b = 6
    spent = param_window._diagnose(_stale_pending_frame({"a": 1.2}), live, live_formulas)
    assert "b" not in spent["restore"]
    assert [c["name"] for c in spent["changed"]] == ["b"]
    # The same pending while its transition is still open is honoured, as before.
    open_ = param_window._diagnose(_stale_pending_frame({"a": 1.5}), live, live_formulas)
    assert open_["restore"] == {"b": 2.0} and open_["restore_formulas"] == {"b": "2*a"}
