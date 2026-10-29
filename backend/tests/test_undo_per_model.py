"""Undo and Redo scoped to the open model.

The stack stays one LIFO history for the workspace — taking a step out of
the middle is only safe with declared effects per command type, which the commands do not have. So the
scope is a guard: Undo on model B takes back B's newest step only when it is the newest step at all, and
otherwise refuses, naming the model the newest step belongs to. It never takes back a change in A.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def two_models(client, token, project):
    del project
    for name in ("A", "B"):
        r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
        assert r.status_code == 200, r.text
    return client, token


def _set(client, token, database, amount, turn=None):
    headers = dict(token)
    if turn:
        headers["X-Prism-Turn"] = turn
    r = client.post("/api/v1/params", json={"database": database, "name": "p", "amount": amount}, headers=headers)
    assert r.status_code == 200, r.text


def _new_process(client, token, database, name="p", turn=None):
    """A step that is NOT on the positive list: another model could link to the new process."""
    headers = dict(token)
    if turn:
        headers["X-Prism-Turn"] = turn
    r = client.post("/api/v1/model/activities", json={"database": database, "name": name, "unit": "kg"}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


def _value(client, token, database):
    r = client.get(f"/api/v1/params?database={database}", headers=token)
    return {p["name"]: p["amount"] for p in r.json()}.get("p")


def _history(client, token, database=None):
    q = f"?database={database}" if database else ""
    r = client.get(f"/api/v1/model/history{q}", headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def _step(client, token, verb, database=None, turn=None):
    body = {k: v for k, v in (("database", database), ("turn", turn)) if v}
    return client.post(f"/api/v1/model/{verb}", json=body, headers=token)


def test_undo_on_a_model_takes_back_its_own_newest_step(two_models):
    client, token = two_models
    _set(client, token, "A", 1.0)
    _set(client, token, "A", 2.0)
    assert _history(client, token, "A")["can_undo"] is True
    r = _step(client, token, "undo", "A")
    assert r.status_code == 200, r.text
    assert _value(client, token, "A") == 1.0


def test_it_reaches_past_another_models_local_steps_and_leaves_them(two_models):
    """Positive list: a parameter set in B is local to B, so Undo in A takes A's step
    from under it — and B's value stays exactly as it was."""
    client, token = two_models
    _set(client, token, "A", 1.0)
    _set(client, token, "A", 2.0)
    _set(client, token, "B", 5.0)  # newest step: B's, but local
    h = _history(client, token, "A")
    assert h["can_undo"] is True and "p" in h["next_undo"]
    assert _step(client, token, "undo", "A").status_code == 200
    assert _value(client, token, "A") == 1.0
    assert _value(client, token, "B") == 5.0, "B's change was taken back from A"
    # …and B's own undo still finds B's step.
    assert _step(client, token, "undo", "B").status_code == 200


def test_a_step_that_is_not_local_still_holds_the_undo(two_models):
    client, token = two_models
    _set(client, token, "A", 1.0)
    code = _new_process(client, token, "B")  # newest step: B's, not on the list

    h = _history(client, token, "A")
    assert h["can_undo"] is False and h["next_undo"] is None
    assert h["undo_elsewhere"]["model"] == "B", "the toolbar cannot say where the step is"

    r = _step(client, token, "undo", "A")
    assert r.status_code == 409 and r.json()["error"]["code"] == "undo_elsewhere"
    assert "‘B’" in r.json()["error"]["message"]
    procs = client.get("/api/v1/model/activities/B", headers=token).json()
    assert any(a["code"] == code for a in procs), "B's change was taken back from A"
    assert _value(client, token, "A") == 1.0

    # In B it is an ordinary undo — and then A's step is on top again.
    assert _step(client, token, "undo", "B").status_code == 200
    assert _history(client, token, "A")["can_undo"] is True


def test_redo_is_scoped_the_same_way(two_models):
    client, token = two_models
    _set(client, token, "A", 1.0)
    _new_process(client, token, "B")
    assert _step(client, token, "undo", "B").status_code == 200
    h = _history(client, token, "A")
    assert h["can_redo"] is False and h["redo_elsewhere"]["model"] == "B"
    assert _step(client, token, "redo", "A").json()["error"]["code"] == "redo_elsewhere"
    assert _step(client, token, "redo", "B").status_code == 200


def test_a_turn_across_models_is_taken_back_only_in_its_local_part(two_models):
    """Local steps of B inside the turn are reached past: the turn's block in A is A's part of it."""
    client, token = two_models
    _set(client, token, "A", 1.0)
    _set(client, token, "B", 5.0, turn="t1")
    _set(client, token, "A", 2.0, turn="t1")
    _set(client, token, "A", 3.0, turn="t1")
    h = _history(client, token, "A")
    assert h["next_undo_turn"].items() >= {"turn": "t1", "size": 2}.items()  # plus the span it covers
    r = _step(client, token, "undo", "A", turn="t1")
    assert r.status_code == 200 and r.json()["undone"] == 2
    assert _value(client, token, "A") == 1.0
    assert _value(client, token, "B") == 5.0


def test_a_turn_with_another_models_step_between_its_own_takes_only_its_own(two_models):
    """A2(t1), B(t1), A3(t1): an implementation that popped "the top two" would take B."""
    client, token = two_models
    _set(client, token, "A", 1.0)
    _set(client, token, "B", 9.0)
    _set(client, token, "A", 2.0, turn="t1")
    _set(client, token, "B", 5.0, turn="t1")
    _set(client, token, "A", 3.0, turn="t1")
    assert _history(client, token, "A")["next_undo_turn"].items() >= {"turn": "t1", "size": 2}.items()  # plus the span it covers
    r = _step(client, token, "undo", "A", turn="t1")
    assert r.status_code == 200 and r.json()["undone"] == 2
    assert _value(client, token, "A") == 1.0
    assert _value(client, token, "B") == 5.0, "B's step in the middle was taken"
    r = _step(client, token, "redo", "A", turn="t1")
    assert r.status_code == 200 and r.json()["redone"] == 2
    assert _value(client, token, "A") == 3.0 and _value(client, token, "B") == 5.0


def test_redo_recreates_a_scenario_under_its_old_id(two_models):
    """Create, rename, undo both, redo both: the rename names the scenario by id, and the redone create
    used to hand out a fresh one — the redo stopped at the rename (an existing defect)."""
    client, token = two_models
    _set(client, token, "A", 1.0)
    headers = {**token, "X-Prism-Turn": "t2"}
    r = client.post("/api/v1/scenarios", json={"database": "A", "name": "s", "overrides": {"p": 2.0}}, headers=headers)
    sid = r.json()["scenario"]["id"]
    r = client.post(
        "/api/v1/scenarios/update",
        json={"database": "A", "id": sid, "name": "s2", "overrides": {"p": 2.0}},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert _step(client, token, "undo", "A", turn="t2").json()["undone"] == 2
    r = _step(client, token, "redo", "A", turn="t2")
    assert r.json()["redone"] == 2 and r.json()["stopped"] is None
    names = [s["name"] for s in client.get("/api/v1/scenarios?database=A", headers=token).json()]
    assert names == ["s2"]


def test_a_turn_with_a_step_that_is_not_local_is_not_offered_as_a_block(two_models):
    client, token = two_models
    _new_process(client, token, "B", turn="t1")  # not local: the turn cannot be cut apart around it
    _set(client, token, "A", 2.0, turn="t1")
    h = _history(client, token, "A")
    # The single step on top is A's and offered; the turn is not, because it also changed B.
    assert h["can_undo"] is True
    assert h["next_undo_turn"] is None
    r = _step(client, token, "undo", "A", turn="t1")
    assert r.status_code == 409 and r.json()["error"]["code"] == "turn_elsewhere"


def test_without_a_model_it_is_the_workspace_undo_it_always_was(two_models):
    client, token = two_models
    _set(client, token, "A", 1.0)
    _set(client, token, "B", 5.0)
    assert _history(client, token)["next_undo"] is not None
    assert _step(client, token, "undo").status_code == 200
    assert _step(client, token, "undo").status_code == 200


# --- four holes in the attribution the guard trusts ------------------


def test_a_scenario_of_another_model_cannot_be_changed_under_this_ones_name(two_models):
    """A scenario id of B sent with `database: A` deleted B's scenario while the undo step said A — so
    Undo on A took back a change in B."""
    client, token = two_models
    _set(client, token, "B", 1.0)
    r = client.post(
        "/api/v1/scenarios", json={"database": "B", "name": "s", "overrides": {"p": 2.0}}, headers=token
    )
    assert r.status_code == 200, r.text
    sid = r.json()["scenario"]["id"]
    r = client.post("/api/v1/scenarios/delete", json={"database": "A", "id": sid}, headers=token)
    assert r.status_code == 409 and r.json()["error"]["code"] == "scenario_other_model"
    assert any(s["id"] == sid for s in client.get("/api/v1/scenarios?database=B", headers=token).json())


def test_a_tag_selection_across_models_belongs_to_those_models_only(two_models):
    """Spanning A and B, the step named no model and counted as workspace-wide — offered in C."""
    client, token = two_models
    assert client.post("/api/v1/databases/foreground", json={"name": "C"}, headers=token).status_code == 200
    keys = []
    for db in ("A", "B"):
        r = client.post("/api/v1/model/activities", json={"database": db, "name": f"x{db}", "unit": "kilogram"}, headers=token)
        assert r.status_code == 200, r.text
        keys.append({"database": db, "code": r.json()["activity"]["code"]})
    r = client.post("/api/v1/model/tags/bulk", json={"keys": keys, "dimension": "Phase", "value": "Use"}, headers=token)
    assert r.status_code == 200, r.text
    assert _history(client, token, "C")["can_undo"] is False
    assert _history(client, token, "A")["can_undo"] is True


def test_the_workspace_lines_never_push_a_models_own_out_of_its_budget():
    from prism_lca.engine.commands import AuditEntry, CommandBus

    def e(i, **kw):
        return AuditEntry(index=i, timestamp="t", source="user", action="a", summary=str(i), **kw)

    entries = [e(0, database="A"), e(1, database="A")] + [e(i, workspace=True) for i in range(2, 12)]
    kept = CommandBus._newest(entries, 5)
    assert [x.index for x in kept if x.database == "A"] == [0, 1], "the model's own lines were evicted"
    assert len(kept) == 5


def test_a_step_whose_model_is_gone_is_not_held_on_another_page(client, token, project):
    """An undone bundle import: its model is gone, its redo would bring it back — from no page could it
    be taken if the step stayed bound to that model."""
    del project
    from prism_lca.engine.commands import Command, CommandBus

    class Ghost(Command):
        action = "ghost"

        def execute(self):
            return {}

        def undo(self):
            pass

        def summary(self):
            return "Import bundle 'Gone'"

        def audit_database(self):
            return "Gone"

    bus = CommandBus()
    bus._redo.append(Ghost())
    assert bus.history(database="Anything")["can_redo"] is True


def test_the_positive_list_is_exactly_the_reviewed_one():
    """A tripwire: a command joins the list only after its execute/undo was checked for touching
    nothing outside its own model. The two that made the first design
    unsafe — move to library (its undo deletes the library dataset, and Brightway cuts every link to
    it) and a tag-group merge (its undo strips values from the shared vocabulary) — must stay off it,
    as must anything that creates or deletes a process another model could link to."""
    import inspect

    from prism_lca.engine import commands

    local = {
        name
        for name, cls in inspect.getmembers(commands, inspect.isclass)
        if issubclass(cls, commands.Command) and cls is not commands.Command and cls.local_to_model
    }
    assert local == {
        "AddExchangeCommand", "SetExchangeAmountCommand", "RemoveExchangeCommand",
        "SetExchangeUncertaintyCommand", "SetExchangeCommentCommand", "SetExchangePedigreeCommand",
        "SetExchangeFormulaCommand", "SetActivityFieldsCommand", "SetClassificationCommand",
        "SetProductPropertiesCommand", "SetParameterCommand", "SetParametersCommand",
        "DeleteParameterCommand", "CreateParamGroupCommand", "CreateScenarioCommand",
        "UpdateScenarioCommand", "DuplicateScenarioCommand", "DeleteScenarioCommand",
        "SetScenarioValueCommand", "ImportScenariosCommand", "SetStudyMetaCommand",
    }
    for barrier in ("MoveToLibraryCommand", "MergeTagGroupCommand", "CreateActivityCommand",
                    "DeleteActivityCommand", "CopyToForegroundCommand", "SetTagCommand", "LinkModelsCommand"):
        assert barrier not in local


def test_history_says_when_the_next_step_was_made_and_redo_keeps_that_time(two_models):
    """The canvas keeps an undo history of its own; the toolbar takes back whichever came last, by these times."""
    import time

    client, token = two_models
    before = time.time() * 1000
    _set(client, token, "A", 1.0)
    _set(client, token, "A", 2.0)
    h = _history(client, token, "A")
    assert before <= h["next_undo_at"] <= time.time() * 1000 and h["next_redo_at"] is None
    second = h["next_undo_at"]
    assert _step(client, token, "undo", "A").status_code == 200
    h = _history(client, token, "A")
    assert h["next_redo_at"] == second and h["next_undo_at"] <= second
    assert _step(client, token, "redo", "A").status_code == 200
    assert _history(client, token, "A")["next_undo_at"] == second


def test_a_held_step_still_reports_its_time_and_a_turn_block_its_span(two_models):
    """The canvas's undo history must not take back a step older than one the model holds, nor reach into
    the middle of an assistant turn — both need the times."""
    client, token = two_models
    _set(client, token, "A", 1.0)
    _new_process(client, token, "B")  # not local: holds A's Undo
    h = _history(client, token, "A")
    assert h["can_undo"] is False and h["undo_elsewhere"] is not None
    assert h["next_undo_at"] is not None  # A's own newest step, held
    _set(client, token, "A", 2.0, turn="t1")
    _set(client, token, "A", 3.0, turn="t1")
    h = _history(client, token, "A")
    offer = h["next_undo_turn"]
    assert offer["size"] == 2 and offer["from_at"] <= offer["to_at"] == h["next_undo_at"]

