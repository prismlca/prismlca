""""Why different?" computed by the comparison itself (engine/difference_run.py, engine/difference_plan.py).

The Results page asks ``/calc/compare`` for one subject at a time and hands every request the run's token, all its
subjects and where this one stands. The split that comes back has to be the split ``/calc/difference`` gives for the
same pair, and it has to add up to the difference of the two scores of the same run — to 1e-9.
"""
from __future__ import annotations

import pytest
from difference_model import (
    CH4,
    DB,
    GWP,
    ONE,
    add_scenario,
    build_model,
    copy_model,
    edit_copy,
    one_process_model,
)

from prism_lca.engine import compare, difference_run, lca, param_window
from prism_lca.engine import difference_terms as terms
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.scenarios import ScenarioStore

RTOL = 1e-9
METHODS = [list(GWP), list(CH4)]


@pytest.fixture(autouse=True)
def _clean():
    difference_run.drop_all()
    yield
    difference_run.drop_all()
    param_window.reset_for_tests()


def _run(client, token, subjects: list[dict], run: str = "run-1", methods=None) -> tuple[list[dict], dict]:
    """Compute ``subjects`` the way the Results page does — one request each — and gather the rows and the splits
    (by subject index) of the run."""
    rows: list[dict] = []
    splits: dict[int, dict] = {}
    plan: list[dict] = []
    for i, s in enumerate(subjects):
        r = client.post("/api/v1/calc/compare", json={
            "subjects": [s], "methods": methods or METHODS, "inventory": True,
            "difference": {"run": run, "of": subjects, "at": i},
        }, headers=token)
        assert r.status_code == 200, r.text
        body = r.json()
        rows += body["subjects"]
        plan = body["difference"]["plan"]
        for split in body["difference"]["splits"]:
            assert split["subject"] not in splits
            splits[split["subject"]] = split
    return rows, {"plan": plan, "splits": splits}


def _alone(client, token, body: dict) -> dict:
    r = client.post("/api/v1/calc/difference", json={**body, "methods": METHODS, "top_n": difference_run.TOP_N},
                    headers=token)
    assert r.status_code == 200, r.text
    (result,) = r.json()["results"]
    return r.json() | {"result": result}


def _same_split(with_scores: dict, alone: dict, rows: list[dict], sub: int, ref: int) -> None:
    """The split read off the comparison is the split on its own, and adds up to the run's own two scores."""
    assert with_scores["reference"] == ref and "error" not in with_scores
    for block, single in zip(with_scores["indicators"], alone["result"]["indicators"], strict=True):
        key = " · ".join(block["method"])
        before, after = rows[ref]["scores"][key], rows[sub]["scores"][key]
        scale = max(abs(before), abs(after))
        assert abs(block["reference_score"] - before) <= RTOL * scale
        assert abs(block["score"] - after) <= RTOL * scale
        assert abs(block["delta"] - (after - before)) <= RTOL * scale
        assert abs(block["delta"] - single["delta"]) <= RTOL * scale
        assert block["exact"] is True and single["exact"] is True
        assert block["changes"] == single["changes"]
        explained = sum(c["contribution"] for c in block["changes"]) + block.get("more", {}).get("contribution", 0)
        assert explained == pytest.approx(block["delta"], rel=1e-5, abs=1e-12)


def test_scenarios_are_split_against_their_baseline_as_difference_splits_them(client, token, project):
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.004, "n_parts": 5.0})
    b = add_scenario(client, token, "b", {"r_share": 0.6, "credit_kwh": 0.9})
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "product", "scenario": a},
                {"database": DB, "code": "product", "scenario": b}]
    rows, run = _run(client, token, subjects)
    assert run["plan"] == [{"reason": "reference"}, {"reference": 0}, {"reference": 0}]
    assert sorted(run["splits"]) == [1, 2]
    for sub, sid in ((1, a), (2, b)):
        alone = _alone(client, token, {"database": DB, "code": "product", "scenario": sid})
        _same_split(run["splits"][sub], alone, rows, sub, 0)


def test_a_model_of_one_process_is_split_too(client, token, project):
    """A one-process system's supply comes back from the solver as a scalar; the split reads it all the same."""
    build_model(client, token)
    one_process_model(client, token)
    heavy = add_scenario(client, token, "heavy", {"mass": 8.0}, database=ONE)
    subjects = [{"database": ONE, "code": "bottle"}, {"database": ONE, "code": "bottle", "scenario": heavy}]
    rows, run = _run(client, token, subjects)
    _same_split(run["splits"][1], _alone(client, token, subjects[1]), rows, 1, 0)
    change = run["splits"][1]["indicators"][0]["changes"][0]
    assert (change["before"], change["after"], change["formula"], change["share_pct"]) == (4.0, 8.0, "mass", 100.0)


def test_a_scenario_listed_before_its_baseline_is_split_when_the_baseline_comes(client, token, project):
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    subjects = [{"database": DB, "code": "product", "scenario": a}, {"database": DB, "code": "product"}]
    rows, run = _run(client, token, subjects)
    assert run["plan"] == [{"reference": 1}, {"reason": "reference"}]
    _same_split(run["splits"][0], _alone(client, token, {"database": DB, "code": "product", "scenario": a}),
                rows, 0, 1)


def test_without_the_baseline_a_scenario_is_not_split_and_reads_nothing(client, token, project, monkeypatch):
    """Against another scenario the split would name the differences of two sets of overrides, which reads as what a
    scenario changes and is not; the page asks for the baseline instead."""
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.004})
    b = add_scenario(client, token, "b", {"leak": 0.02, "n_parts": 3.0})
    monkeypatch.setattr(terms, "Recorder", lambda *a, **k: pytest.fail("a side was read"))
    subjects = [{"database": DB, "code": "product", "scenario": a}, {"database": DB, "code": "product", "scenario": b}]
    rows, run = _run(client, token, subjects)
    assert run == {"plan": [{"reason": "no_baseline"}, {"reason": "no_baseline"}], "splits": {}}
    assert all(len(r["scores"]) == 2 for r in rows)


@pytest.mark.parametrize("copy_first", [False, True])
def test_a_copy_is_split_against_its_original_in_either_order(client, token, project, copy_first):
    build_model(client, token)
    codes = copy_model(client, token)
    edit_copy(client, token, codes)
    original, copy = {"database": DB, "code": "product"}, {"database": "fx copy", "code": codes["product"]}
    subjects = [copy, original] if copy_first else [original, copy]
    sub, ref = (0, 1) if copy_first else (1, 0)
    rows, run = _run(client, token, subjects)
    assert run["plan"][ref] == {"reason": "reference"} and run["plan"][sub] == {"reference": ref}
    split = run["splits"][sub]
    assert split["pairing"] == {"paired": 3, "only_in_subject": ["paint"], "only_in_reference": ["recycle"]}
    alone = _alone(client, token, {"database": "fx copy", "code": codes["product"], "against": {"database": DB}})
    _same_split(split, alone, rows, sub, ref)


def test_a_copy_is_split_against_its_original_not_a_sibling_copy_listed_before(client, token, project):
    """Two copies of one model pair with each other by name as well; each is split against the one it records."""
    build_model(client, token)
    first = copy_model(client, token, "fx copy")
    second = copy_model(client, token, "fx copy 2")
    edit_copy(client, token, second, name="fx copy 2")
    subjects = [{"database": "fx copy", "code": first["product"]}, {"database": DB, "code": "product"},
                {"database": "fx copy 2", "code": second["product"]}]
    rows, run = _run(client, token, subjects)
    assert run["plan"] == [{"reference": 1}, {"reason": "reference"}, {"reference": 1}]
    alone = _alone(client, token, {"database": "fx copy 2", "code": second["product"], "against": {"database": DB}})
    _same_split(run["splits"][2], alone, rows, 2, 1)


def test_a_copy_of_a_copy_is_split_against_its_nearest_original_and_never_round_in_a_circle(client, token, project):
    """A copy records only the process it was made from; the planner follows the line, so the first model is never
    taken for a copy of its grandchild listed before it."""
    build_model(client, token)
    copy_model(client, token, "fx copy")
    r = client.post("/api/v1/databases/foreground/duplicate", json={"source": "fx copy", "name": "fx copy 2"},
                    headers=token)
    assert r.status_code == 200, r.text

    def product(db: str) -> dict:
        return {"database": db, "code": next(a.key[1] for a in get_bd().Database(db) if a["name"] == "product")}

    grandchild, first, child = product("fx copy 2"), {"database": DB, "code": "product"}, product("fx copy")
    _rows, run = _run(client, token, [grandchild, first, child])
    assert run["plan"] == [{"reference": 2}, {"reason": "reference"}, {"reference": 1}]
    _rows, run = _run(client, token, [grandchild, first], run="run-2")
    assert run["plan"] == [{"reference": 1}, {"reason": "reference"}]


def test_a_renamed_copy_of_a_copy_is_split_against_the_first_model_without_the_copy_between(client, token, project):
    """The record is followed back through the copy between, which need not be among the subjects; a renamed process
    is paired by it, not by its name."""
    build_model(client, token)
    edit_copy(client, token, copy_model(client, token, "fx copy"))
    r = client.post("/api/v1/databases/foreground/duplicate", json={"source": "fx copy", "name": "fx copy 2"},
                    headers=token)
    assert r.status_code == 200, r.text
    renamed = next(a for a in get_bd().Database("fx copy 2") if a["name"] == "product")
    renamed["name"] = "product, second edition"
    renamed.save()
    subjects = [{"database": DB, "code": "product"}, {"database": "fx copy 2", "code": renamed.key[1]}]
    rows, run = _run(client, token, subjects)
    assert run["plan"] == [{"reason": "reference"}, {"reference": 0}]
    assert run["splits"][1]["pairing"] == {"paired": 3, "only_in_subject": ["paint"], "only_in_reference": ["recycle"]}
    alone = _alone(client, token, {"database": "fx copy 2", "code": renamed.key[1], "against": {"database": DB}})
    _same_split(run["splits"][1], alone, rows, 1, 0)


def test_independent_processes_and_datasets_are_not_split_and_read_nothing(client, token, project, monkeypatch):
    build_model(client, token)

    made: list[bool] = []
    real = terms.Recorder.__init__

    def counted(self, reference: bool) -> None:
        made.append(reference)
        real(self, reference)

    monkeypatch.setattr(terms.Recorder, "__init__", counted)
    get_bd().databases["bg"]["prism_read_only"] = True  # what an imported background database carries
    get_bd().databases.flush()
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "part"},
                {"database": "bg", "code": "steel"}]
    _rows, run = _run(client, token, subjects)
    assert run["plan"] == [{"reason": "independent"}, {"reason": "independent"}, {"reason": "dataset"}]
    assert run["splits"] == {} and made == []


def test_a_pair_that_cannot_be_split_says_why_and_the_scores_stand(client, token, project, monkeypatch):
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    b = add_scenario(client, token, "b", {"leak": 0.02})
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "product", "scenario": a},
                {"database": DB, "code": "product", "scenario": b}]
    real = terms.Recorder.__call__
    calls = {"n": 0}

    def flaky(self, system, method):
        calls["n"] += 1
        if calls["n"] > 2 * len(METHODS):  # the third subject's side
            raise RuntimeError("unreadable")
        return real(self, system, method)

    monkeypatch.setattr(terms.Recorder, "__call__", flaky)
    rows, run = _run(client, token, subjects)
    assert len(rows) == 3 and all(len(r["scores"]) == 2 for r in rows)
    assert "indicators" in run["splits"][1]
    assert run["splits"][2] == {"subject": 2, "reference": 0,
                                "error": difference_run.UNREADABLE}


def test_a_model_changed_between_the_two_sides_is_not_split(client, token, project):
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "product", "scenario": a}]
    r = client.post("/api/v1/calc/compare", json={
        "subjects": [subjects[0]], "methods": METHODS, "difference": {"run": "moved", "of": subjects, "at": 0}},
        headers=token)
    assert r.status_code == 200 and r.json()["difference"]["splits"] == []
    r = client.post("/api/v1/params", json={"database": DB, "name": "kwh_part", "amount": 4.0}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/calc/compare", json={
        "subjects": [subjects[1]], "methods": METHODS, "difference": {"run": "moved", "of": subjects, "at": 1}},
        headers=token)
    assert r.status_code == 200, r.text
    (split,) = r.json()["difference"]["splits"]
    assert split["error"].startswith("The model changed while the results were computed")
    assert len(r.json()["subjects"][0]["scores"]) == 2


def test_a_model_changed_while_a_side_is_solved_is_not_split(client, token, project, monkeypatch):
    """Model edits do not wait for the calculation lock: one landing while a side's matrices are built must not be
    stamped onto them as the generation they were read under."""
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    real = lca.get_lca
    edits = iter([True])

    def edited_meanwhile(demand, method):
        system = real(demand, method)
        if next(edits, False):
            lca._MODEL_GEN += 1  # the edit lands after the matrices were built, before they are read
        return system

    monkeypatch.setattr(lca, "get_lca", edited_meanwhile)
    rows, run = _run(client, token, [{"database": DB, "code": "product"},
                                     {"database": DB, "code": "product", "scenario": a}])
    assert run["splits"][1]["error"] == difference_run.MOVED
    assert all(len(r["scores"]) == 2 for r in rows)


def test_a_model_changed_while_the_split_names_its_changes_is_not_split(client, token, project, monkeypatch):
    """The changes are named from the model as it is while they are listed: an edit meanwhile would label them
    from another state of the model."""
    from prism_lca.engine import difference

    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    real = difference.split_sides

    def edited_meanwhile(*args, **kwargs):
        out = real(*args, **kwargs)
        lca._MODEL_GEN += 1
        return out

    monkeypatch.setattr(difference, "split_sides", edited_meanwhile)
    _rows, run = _run(client, token, [{"database": DB, "code": "product"},
                                      {"database": DB, "code": "product", "scenario": a}])
    assert run["splits"][1]["error"] == difference_run.MOVED


def test_a_model_changed_between_the_plan_and_the_sides_is_not_split(client, token, project, monkeypatch):
    """The plan pairs a copy onto its original for the model as it was planned; sides read after an edit belong to
    another one."""
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    real = difference_run.difference_plan.plan

    def edited_after(subjects):
        out = real(subjects)
        lca._MODEL_GEN += 1
        return out

    monkeypatch.setattr(difference_run.difference_plan, "plan", edited_after)
    _rows, run = _run(client, token, [{"database": DB, "code": "product"},
                                      {"database": DB, "code": "product", "scenario": a}])
    assert run["splits"][1]["error"] == difference_run.MOVED


def test_a_workspace_switched_before_the_split_is_not_split(client, token, project, monkeypatch):
    """A switch that comes in after the last solve: the sides' node ids would be named from another workspace."""
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    real = difference_run.offer

    def switched_meanwhile(run, read, should_cancel=None):
        run.project = "another workspace"  # what the run was read in is no longer the workspace open
        return real(run, read, should_cancel=should_cancel)

    monkeypatch.setattr(difference_run, "offer", switched_meanwhile)
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "product", "scenario": a}]
    r = client.post("/api/v1/calc/compare", json={"subjects": subjects, "methods": METHODS,
                                                  "difference": {"run": "switch", "of": subjects, "at": 0}},
                    headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["difference"]["splits"] == [{"subject": 1, "reference": 0, "error": difference_run.SWITCHED}]


def test_a_request_longer_than_a_run_is_kept_does_not_lose_the_run(client, token, project, monkeypatch):
    """A run is kept for MAX_AGE after its last request began or ended; a subject that computes longer must not find
    its baseline's side expired when the next subject comes."""
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    clock = [1000.0]
    monkeypatch.setattr(difference_run, "_clock", lambda: clock[0])
    real = lca.compute_lcia

    def slow(*args, **kwargs):
        clock[0] += difference_run.MAX_AGE  # every solve takes as long as a run is kept
        return real(*args, **kwargs)

    monkeypatch.setattr(lca, "compute_lcia", slow)
    _rows, run = _run(client, token, [{"database": DB, "code": "product"},
                                      {"database": DB, "code": "product", "scenario": a}])
    assert "indicators" in run["splits"][1], run["splits"][1]


def test_a_request_that_fails_gives_its_run_back(client, token, project, monkeypatch):
    """A subject whose calculation fails ends its request without an answer; its run may expire all the same."""
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "product", "scenario": a}]
    r = client.post("/api/v1/calc/compare", json={
        "subjects": [subjects[0]], "methods": METHODS, "difference": {"run": "fails", "of": subjects, "at": 0}},
        headers=token)
    assert r.status_code == 200, r.text

    def broken(*args, **kwargs):
        raise RuntimeError("singular")

    monkeypatch.setattr(lca, "compute_lcia", broken)
    r = client.post("/api/v1/calc/compare", json={
        "subjects": [subjects[1]], "methods": METHODS, "difference": {"run": "fails", "of": subjects, "at": 1}},
        headers=token)
    assert r.status_code != 200
    assert difference_run._runs["fails"].active == 0


def test_a_comparison_asked_again_under_a_new_run_is_the_same_request(client, token, project):
    """The run's token is new with every Calculate; the request it rides on is the same, so it supersedes the one
    asked before and leaves no key of its own behind."""
    from prism_lca.api.v1 import calc

    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "product", "scenario": a}]
    before = dict(calc._gen)
    _run(client, token, subjects, run="first")
    mine = {k: v for k, v in calc._gen.items() if before.get(k) != v}
    _run(client, token, subjects, run="second")
    assert len(mine) == 2 and calc._gen.keys() == before.keys() | mine.keys()
    assert all(calc._gen[k] == v + 1 for k, v in mine.items())


def test_one_request_for_every_subject_splits_the_same(client, token, project):
    build_model(client, token)
    a = add_scenario(client, token, "a", {"n_parts": 6.0})
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "product", "scenario": a}]
    r = client.post("/api/v1/calc/compare", json={
        "subjects": subjects, "methods": METHODS, "difference": {"run": "whole", "of": subjects}}, headers=token)
    assert r.status_code == 200, r.text
    (split,) = r.json()["difference"]["splits"]
    _same_split(split, _alone(client, token, {"database": DB, "code": "product", "scenario": a}),
                r.json()["subjects"], 1, 0)


def test_a_side_is_let_go_once_its_pairs_are_split_and_cancel_lets_every_run_go(client, token, project):
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "product", "scenario": a}]
    _run(client, token, subjects, run="free")
    assert difference_run._runs["free"].sides == {}
    client.post("/api/v1/calc/compare", json={
        "subjects": [subjects[0]], "methods": METHODS, "difference": {"run": "held", "of": subjects}}, headers=token)
    assert list(difference_run._runs["held"].sides) == [0]
    r = client.post("/api/v1/calc/cancel", json={"channel": "compare"}, headers=token)
    assert r.status_code == 200
    assert difference_run._runs == {}


def test_cancel_reaches_the_split(client, token, project):
    """The comparison is cancellable between solves; the split must not outlast a Cancel either."""
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.01})
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "product", "scenario": a}]
    solves = len(subjects) * len(METHODS)
    asked = {"n": 0}

    def cancel_after_the_solves() -> bool:
        asked["n"] += 1
        return asked["n"] > solves

    with pytest.raises(lca.CalcCancelled):
        compare.compare(ScenarioStore(), subjects, METHODS, should_cancel=cancel_after_the_solves,
                        difference={"run": "cancelled", "of": subjects})


def test_subjects_not_at_their_place_in_the_run_are_refused(client, token, project):
    build_model(client, token)
    subjects = [{"database": DB, "code": "product"}, {"database": DB, "code": "part"}]
    r = client.post("/api/v1/calc/compare", json={
        "subjects": [subjects[1]], "methods": METHODS, "difference": {"run": "x", "of": subjects, "at": 0}},
        headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request"
