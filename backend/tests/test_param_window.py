"""The crash marker that keeps a killed process from leaving a model standing in a scenario (V218).

A test cannot kill pytest, so the crash is simulated the only way that is actually equivalent: write
the marker a window would have written, put the override into the parameter as the window did, and
then start the machinery that a restart runs. What is asserted is the machinery, not the kill.
"""
from __future__ import annotations

import json
import math
import pathlib
import re

import pytest
import stats_arrays as sa

from prism_lca.app import create_app
from prism_lca.engine import (
    health,
    lca,
    param_window,
    params,
    report_snapshot,
    scenarios,
    sensitivity,
)
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.scenarios import ScenarioStore
from prism_lca.errors import PrismError

METHOD = ["test", "gwp"]
DB = "fg"


@pytest.fixture(autouse=True)
def _no_leftover_marker():
    """No test may inherit another's marker, and none may leave one behind."""
    yield
    param_window.reset_for_tests()


def _seed(bd) -> None:
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
                    # Lognormal, so the Monte-Carlo window below has something to sample. The
                    # static amount is unchanged, so every deterministic score here still holds.
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere",
                     "uncertainty type": sa.LognormalUncertainty.id, "loc": math.log(0.5),
                     "scale": 0.3},
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


def _model(client, token) -> None:
    """A model with one parameter (`kwh` = 2.0) driving one exchange."""
    _seed(get_bd())
    assert client.post(
        "/api/v1/params", json={"database": DB, "name": "kwh", "amount": 2.0}, headers=token
    ).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": DB, "activity_code": "bottle", "uid": "e", "formula": "kwh"},
        headers=token,
    ).status_code == 200


def _scenario(client, token, name="efficient", overrides=None) -> str:
    r = client.post(
        "/api/v1/scenarios",
        json={"database": DB, "name": name, "overrides": overrides or {"kwh": 1.0}},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()["scenario"]["id"]


def _amount(name="kwh") -> float:
    return params.snapshot_all(DB)[name]


def _write_marker(baseline: dict, overrides: dict, label="efficient", database=DB,
                  kind="scenario") -> None:
    """Exactly what `open_window` writes — by hand, so the process that wrote it can be "gone"."""
    p = param_window.path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        json.dumps(
            {
                "version": 1,
                "pid": 999999,
                "frames": [
                    {
                        "kind": kind, "label": label, "database": database,
                        "opened": "2026-08-23T10:00:00+00:00", "project": "whatever",
                        "baseline": baseline, "overrides": overrides,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def _restart(settings):
    """What a restart does to the model, without a restart."""
    return create_app(settings)


# --------------------------------------------------------------------------- #
# A clean window leaves nothing behind
# --------------------------------------------------------------------------- #
def test_clean_window_leaves_no_marker(client, token, project):
    _model(client, token)
    sid = _scenario(client, token)

    r = client.post(
        "/api/v1/scenarios/compute",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_id": sid},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert not param_window.path().exists()
    assert _amount() == 2.0

    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_ids": [sid]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert not param_window.path().exists()
    assert _amount() == 2.0

    # ...and the context manager the report and the calculation paths use.
    with scenarios.applied(ScenarioStore(), DB, sid):
        assert _amount() == 1.0
        assert param_window.path().exists()  # open, on purpose, for the length of the block
    assert not param_window.path().exists()
    assert _amount() == 2.0


# --------------------------------------------------------------------------- #
# A marker left behind is a restore on the next start
# --------------------------------------------------------------------------- #
def test_marker_left_behind_is_restored_on_start(client, token, project, settings):
    _model(client, token)
    # The crash: the override is in the model, the marker says what was there before.
    params.apply_values(DB, {"kwh": 1.0})
    _write_marker({"kwh": 2.0}, {"kwh": 1.0})
    assert _amount() == 1.0

    _restart(settings)

    assert _amount() == 2.0
    assert not param_window.path().exists()
    entries = [e for e in client.get("/api/v1/model/audit", headers=token).json()
               if e["action"] == "restore_param_window_baseline"]
    assert entries, "the restore is a model write and has to be in the audit trail"
    assert "kwh" in entries[-1]["summary"] and "efficient" in entries[-1]["summary"]
    assert entries[-1]["undoable"] is False


def test_restore_touches_only_what_the_window_moved(client, token, project, settings):
    """A parameter the window never overrode is none of the restore's business."""
    _model(client, token)
    assert client.post(
        "/api/v1/params", json={"database": DB, "name": "other", "amount": 5.0}, headers=token
    ).status_code == 200
    params.apply_values(DB, {"kwh": 1.0})
    # The marker's baseline is the whole snapshot, as `snapshot_all` gives it...
    _write_marker({"kwh": 2.0, "other": 5.0}, {"kwh": 1.0})
    # ...but the author edited the untouched one by hand after the crash.
    params.apply_values(DB, {"other": 7.0})

    _restart(settings)

    assert _amount() == 2.0
    assert _amount("other") == 7.0  # not reverted to the recorded 5.0


# --------------------------------------------------------------------------- #
# Where the marker cannot know, it says so instead of guessing
# --------------------------------------------------------------------------- #
def test_marker_whose_value_moved_since_is_reported_not_applied(client, token, project, settings):
    _model(client, token)
    # The window wrote 1.0; the value in the model is neither that nor the baseline, so somebody
    # edited it between the crash and this start.
    params.apply_values(DB, {"kwh": 1.5})
    _write_marker({"kwh": 2.0}, {"kwh": 1.0})

    _restart(settings)

    assert _amount() == 1.5, "a hand edit must not be overwritten by a stale baseline"
    assert param_window.path().exists(), "the record of what is in doubt has to survive"
    finding = _stuck_finding(DB)
    assert finding is not None
    assert "kwh" in finding["message"]
    assert "efficient" in finding["message"]


def test_marker_naming_a_deleted_parameter_is_reported_not_applied(client, token, project, settings):
    """The V200 incident: a deleted parameter with an applied scenario's overrides still in place."""
    _model(client, token)
    _write_marker({"kwh": 2.0, "gone": 3.0}, {"kwh": 1.0, "gone": 9.0})
    params.apply_values(DB, {"kwh": 1.0})

    _restart(settings)

    assert _amount() == 2.0  # the half it can prove is restored
    assert param_window.path().exists()
    finding = _stuck_finding(DB)
    assert finding is not None
    assert "gone" in finding["message"]
    assert "no longer exist" in finding["message"]


def _stuck_finding(database: str) -> dict | None:
    findings = health.lint_database(database)["findings"]
    return next((f for f in findings if f["code"] == "scenario_overrides_unresolved"), None)


def test_health_is_silent_while_a_window_is_legitimately_open(client, token, project):
    _model(client, token)
    sid = _scenario(client, token)
    with scenarios.applied(ScenarioStore(), DB, sid):
        assert param_window.path().exists()
        assert _stuck_finding(DB) is None, "a window this process holds open is not a finding"
    assert _stuck_finding(DB) is None


def test_a_failed_restore_leaves_the_marker_and_is_reported(client, token, project, monkeypatch):
    """The case the field produced: `database is locked` inside the window, restore gave up."""
    _model(client, token)
    sid = _scenario(client, token)

    def refuse(*_a, **_k):
        raise RuntimeError("database is locked")

    with pytest.raises(PrismError) as caught:
        with scenarios.applied(ScenarioStore(), DB, sid):
            monkeypatch.setattr(params, "apply_values", refuse)
    assert caught.value.code == "scenario_restore_failed"

    assert _amount() == 1.0, "the overrides really are still in the model"
    monkeypatch.undo()
    assert param_window.path().exists()
    finding = _stuck_finding(DB)
    assert finding is not None
    assert "kwh" in finding["message"]


# --------------------------------------------------------------------------- #
# Nothing computed against the wrong state may survive the restore
# --------------------------------------------------------------------------- #
def test_snapshot_cache_does_not_survive_a_restore(client, token, project, settings):
    import time

    _model(client, token)
    params.apply_values(DB, {"kwh": 1.0})
    _write_marker({"kwh": 2.0}, {"kwh": 1.0})
    report_snapshot._snapshots[("stale-key",)] = (time.monotonic(), {"subjects": []})
    report_snapshot._INPUTS_MEMO[("stale-key",)] = (time.monotonic(), {})
    before = lca.model_generation()

    _restart(settings)

    assert not report_snapshot._snapshots, "a snapshot built against the perturbed model must be gone"
    assert not report_snapshot._INPUTS_MEMO
    assert lca.model_generation() > before, "the restore is a model change and has to say so"


# --------------------------------------------------------------------------- #
# The marker's own failure
# --------------------------------------------------------------------------- #
def test_marker_write_failure_refuses_to_apply(client, token, project, monkeypatch):
    """No unmarked window: a refused calculation is loud and repeatable, an unmarked window is not."""
    _model(client, token)
    sid = _scenario(client, token)

    def refuse(_frames):
        raise OSError("No space left on device")

    monkeypatch.setattr(param_window, "_write_frames", refuse)
    r = client.post(
        "/api/v1/scenarios/compute",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_id": sid},
        headers=token,
    )
    assert r.status_code == 500, r.text
    assert r.json()["error"]["code"] == "param_window_marker_failed"
    monkeypatch.undo()
    assert _amount() == 2.0, "the overrides must never have been written"
    assert not param_window.path().exists()
    assert not param_window._frames, "and no frame may be left claiming a window is open"


@pytest.mark.parametrize(
    "content",
    [
        "{ this is not json",
        # A marker written by another version of PrismLCA: a shape this code does not know is not a
        # shape it may guess the author's parameters from.
        '{"version": 99, "frames": [{"database": "fg", "baseline": {"kwh": 2.0}}]}',
    ],
)
def test_unreadable_marker_is_set_aside_and_reported(client, token, project, settings, content):
    _model(client, token)
    p = param_window.path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")

    finding = _stuck_finding(DB)
    assert finding is not None and "cannot be read" in finding["message"]

    _restart(settings)
    assert not p.exists()
    assert list(p.parent.glob("param_window.unreadable-*.json")), "kept, not deleted"
    for leftover in p.parent.glob("param_window.unreadable-*.json"):
        leftover.unlink()


# --------------------------------------------------------------------------- #
# Every window, not only the scenario ones (V218 follow-up)
# --------------------------------------------------------------------------- #
@pytest.fixture
def writes(monkeypatch):
    """Every parameter write, with the marker exactly as it stood at that moment.

    The strong assertion is not "the marker was cleaned up afterwards" — it is that no perturbed
    value was ever in the model without the marker already naming it. Observed here rather than
    per path, so a new window cannot be tested more leniently than the old ones.
    """
    seen: list[dict] = []
    real = params.apply_values

    def watched(database, values, formulas=None):
        seen.append({"database": database, "values": dict(values), "marker": param_window.read()})
        return real(database, values, formulas)

    monkeypatch.setattr(params, "apply_values", watched)
    return seen


def _assert_marked(seen: list[dict], *, kind: str, label: str, name: str = "kwh", base: float = 2.0):
    """Every write that perturbed `name` was preceded by a marker naming exactly that value."""
    perturbing = [o for o in seen if abs(float(o["values"].get(name, base)) - base) > 1e-12]
    assert perturbing, "the window never actually perturbed anything — the test proves nothing"
    for step in perturbing:
        marker = step["marker"]
        assert marker is not None, "a value was written into the model with no marker on disk"
        frames = marker["frames"]
        # One frame per window, re-stamped per step: a stack would describe a combination of
        # override sets that was never in the model at once.
        assert len(frames) == 1, frames
        assert frames[0]["kind"] == kind
        assert frames[0]["label"] == label
        assert frames[0]["baseline"][name] == base
        assert frames[0]["overrides"][name] == pytest.approx(float(step["values"][name]))


def test_sensitivity_windows_are_marked_and_leave_nothing(client, token, project, writes):
    _model(client, token)
    cases = [
        ("tornado", {"database": DB, "code": "bottle", "method": METHOD, "delta": 0.5},
         "one-at-a-time sensitivity analysis"),
        ("sweep", {"database": DB, "code": "bottle", "method": METHOD, "param": "kwh",
                   "values": [1, 3, 4]}, "sensitivity sweep of 'kwh'"),
    ]
    for endpoint, body, label in cases:
        writes.clear()
        r = client.post(f"/api/v1/calc/sensitivity/{endpoint}", json=body, headers=token)
        assert r.status_code == 200, r.text
        _assert_marked(writes, kind="sensitivity", label=label)
        assert not param_window.path().exists()
        assert _amount() == 2.0

    # Break-even against itself: the bisection never has to converge for the window to be the point.
    writes.clear()
    sensitivity.breakeven(DB, "bottle", "bottle", METHOD, "kwh", 0.5, 5.0)
    _assert_marked(writes, kind="sensitivity", label="break-even search on 'kwh'")
    assert not param_window.path().exists()
    assert _amount() == 2.0


def test_montecarlo_compare_window_is_marked_and_leaves_nothing(client, token, project, writes):
    """The longest window in the app: two paired sampling runs with the overrides in the model."""
    _model(client, token)
    sid = _scenario(client, token)
    r = client.post(
        "/api/v1/calc/montecarlo/compare",
        json={"a": {"database": DB, "code": "bottle"},
              "b": {"database": DB, "code": "bottle", "scenario": sid},
              "method": METHOD, "iterations": 20},
        headers=token,
    )
    assert r.status_code == 200, r.text
    _assert_marked(writes, kind="scenario", label="efficient")
    assert not param_window.path().exists()
    assert _amount() == 2.0


def test_comparison_windows_are_marked_and_leave_nothing(client, token, project, writes):
    """`compare` (n subjects x m indicators) and the per-subject traversal inside `lca`."""
    _model(client, token)
    sid = _scenario(client, token)
    subject = {"database": DB, "code": "bottle", "scenario": sid}

    for endpoint, body in [
        ("compare", {"subjects": [subject], "methods": [METHOD]}),
        ("compare-stacked", {"subjects": [subject], "methods": [METHOD], "dimensions": ["isic"]}),
    ]:
        writes.clear()
        r = client.post(f"/api/v1/calc/{endpoint}", json=body, headers=token)
        assert r.status_code == 200, r.text
        _assert_marked(writes, kind="scenario", label="efficient")
        assert not param_window.path().exists()
        assert _amount() == 2.0


def test_a_sensitivity_marker_left_behind_is_restored_on_start(client, token, project, settings):
    """A sweep's frame is treated exactly like a scenario's — restored, and said out loud."""
    _model(client, token)
    params.apply_values(DB, {"kwh": 3.0})
    _write_marker({"kwh": 2.0}, {"kwh": 3.0}, label="sensitivity sweep of 'kwh'", kind="sensitivity")

    _restart(settings)

    assert _amount() == 2.0
    assert not param_window.path().exists()
    entries = [e for e in client.get("/api/v1/model/audit", headers=token).json()
               if e["action"] == "restore_param_window_baseline"]
    assert entries and "sensitivity sweep of 'kwh'" in entries[-1]["summary"]
    assert "scenario" not in entries[-1]["summary"], "it was not a scenario; do not call it one"


def test_a_sensitivity_marker_that_cannot_be_proved_is_reported(client, token, project, settings):
    _model(client, token)
    params.apply_values(DB, {"kwh": 1.7})  # neither the baseline nor what the sweep wrote
    _write_marker({"kwh": 2.0}, {"kwh": 3.0}, label="break-even search on 'kwh'", kind="sensitivity")

    _restart(settings)

    assert _amount() == 1.7
    finding = _stuck_finding(DB)
    assert finding is not None
    assert "break-even search on 'kwh'" in finding["message"]
    assert "kwh" in finding["message"]


def test_a_marker_write_failure_refuses_a_sweep_too(client, token, project, monkeypatch):
    _model(client, token)

    def refuse(_frames):
        raise OSError("No space left on device")

    monkeypatch.setattr(param_window, "_write_frames", refuse)
    r = client.post(
        "/api/v1/calc/sensitivity/sweep",
        json={"database": DB, "code": "bottle", "method": METHOD, "param": "kwh", "values": [1, 3]},
        headers=token,
    )
    assert r.status_code == 500, r.text
    assert r.json()["error"]["code"] == "param_window_marker_failed"
    monkeypatch.undo()
    assert _amount() == 2.0
    assert not param_window.path().exists()
    assert not param_window._frames


def test_every_path_that_writes_parameters_opens_a_window():
    """The list in `param_window`'s docstring, pinned — because the guard cannot say anything about
    a path that never wrote a marker.

    A missing marker means "no marked window was interrupted", not "this model is clean". A new
    caller of `params.apply_values` that skips `open_window` would therefore be invisible to both
    the startup restore and the health linter, and would look exactly like a model nothing touched.
    Whoever adds one has to come past this test and either mark the window or explain the exemption
    here.
    """
    root = pathlib.Path(param_window.__file__).resolve().parents[1]
    writers = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*.py")
        if re.search(r"\b_?params\.apply_values\(", path.read_text(encoding="utf-8"))
    }
    assert writers == {
        # The restore itself — this module IS the guard, so it does not open a window of its own.
        "engine/param_window.py",
        "engine/scenarios.py",
        "engine/sensitivity.py",
        "engine/montecarlo.py",
        "engine/compare.py",
        "engine/lca.py",
    }, writers
    for name in sorted(writers - {"engine/param_window.py"}):
        text = (root / name).read_text(encoding="utf-8")
        assert "open_window(" in text, f"{name} writes parameter values without marking the window"
        assert "restore_and_close(" in text, f"{name} restores without closing the marker"


def test_switching_overrides_keeps_the_ones_already_written(client, token, project):
    """The marker replaced its overrides before the next scenario was written, so a
    crash in between left the previous scenario in the model and a marker that could not see it."""
    from prism_lca.engine import param_window

    frame = {"overrides": {"p": 2.0}, "label": "A", "baseline": {"p": 1.0, "q": 1.0}}
    param_window.set_overrides(frame, {"q": 2.0})
    assert frame["overrides"] == {"p": 2.0, "q": 2.0}


def test_an_export_waits_for_a_scenario_window_and_ships_the_baseline(client, token, project):
    """A .prism export taken while a scenario calculation held its overrides
    in the model shipped the scenario values as the baseline. The export now waits for the window."""
    import base64
    import io
    import json as _json
    import threading
    import zipfile

    _model(client, token)
    sid = _scenario(client, token)  # kwh 2.0 → 1.0
    inside, release = threading.Event(), threading.Event()

    def hold() -> None:
        with scenarios.applied(ScenarioStore(), DB, sid):
            inside.set()
            release.wait(10)

    holder = threading.Thread(target=hold)
    holder.start()
    assert inside.wait(10)
    result: dict = {}
    exporter = threading.Thread(
        target=lambda: result.update(
            r=client.post("/api/v1/bundle/export", json={"database": DB}, headers=token)
        )
    )
    exporter.start()
    exporter.join(0.5)
    assert exporter.is_alive(), "the export did not wait for the open scenario window"
    release.set()
    holder.join(10)
    exporter.join(30)
    r = result["r"]
    assert r.status_code == 200, r.text
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(r.json()["base64"]))) as z:
        params = _json.loads(z.read("parameters.json"))
    assert {p["name"]: p["amount"] for p in params["parameters"]} == {"kwh": 2.0}  # the baseline, not 1.0
