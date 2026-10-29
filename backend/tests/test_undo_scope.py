"""What the undo stack must NOT reach: another project, and an open parameter window.

Three shipped faults, all of them silent:

* **F1** the stacks survived a project switch, so `Undo` ran a command of the previous project in
  the new one. Where both projects hold a model of the same name — the normal case here, since a
  model gets copied into a neighbouring project to try something — that wrote to the wrong project
  with no error and no message. `test_an_undo_after_a_project_switch_cannot_reach_the_old_project`
  is that data change, reproduced.
* **F2** the audit line counts are cached per *path string*, and a recreated project reuses its
  path, so `next_index()` kept counting on a file that no longer had those lines.
* **An open parameter window**: an undo written into it is reverted by that window's own restore.

Every test here first asserts the state it stands on: an assertion about `p == 99` proves nothing
unless something proves it was 99 to begin with.
"""
from __future__ import annotations

import uuid

import pytest

from prism_lca.engine import audit_store, param_window


def _project(client, token) -> str:
    name = "proj-" + uuid.uuid4().hex[:8]
    r = client.post("/api/v1/projects", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    return name


def _activate(client, token, name) -> None:
    r = client.post(f"/api/v1/projects/{name}/activate", headers=token)
    assert r.status_code == 200, r.text


def _model(client, token, name) -> None:
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text


def _set_param(client, token, database, name, amount) -> None:
    r = client.post(
        "/api/v1/params", json={"database": database, "name": name, "amount": amount}, headers=token
    )
    assert r.status_code == 200, r.text


def _param_value(client, token, database, name) -> float:
    r = client.get(f"/api/v1/params?database={database}", headers=token)
    assert r.status_code == 200, r.text
    row = next(p for p in r.json() if p["name"] == name)
    return row["amount"]


def _history(client, token) -> dict:
    r = client.get("/api/v1/model/history", headers=token)
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- #
# F1
# --------------------------------------------------------------------------- #
def test_a_project_switch_empties_the_undo_stack(client, token):
    """The cheap half of F1: after a switch there is nothing to undo, and the buttons can say so."""
    first = _project(client, token)
    _model(client, token, "M")
    _set_param(client, token, "M", "p", 1.0)
    assert _history(client, token)["can_undo"] is True, "nothing was on the stack to begin with"

    second = _project(client, token)  # creates and activates
    assert _history(client, token) == {
        "can_undo": False,
        "can_redo": False,
        "next_undo": None,
        "next_redo": None,
        "next_undo_turn": None,
        "next_redo_turn": None,
        "undo_elsewhere": None,
        "redo_elsewhere": None,
        "next_undo_at": None,
        "next_redo_at": None,
    }

    # …and coming back does not bring it back: the stacks are session state, not project state.
    _activate(client, token, first)
    assert _history(client, token)["can_undo"] is False
    del second


def test_an_undo_after_a_project_switch_cannot_reach_the_old_project(client, token):
    """The fault with the data risk, as a change that either happens or does not.

    Two projects, each with a model called 'M' holding a parameter 'p'. The command on the stack
    belongs to the project we are *not* standing in any more; its `undo()` would write 1.0 into a
    model called 'M', and there is one of those here too.
    """
    victim = _project(client, token)
    _model(client, token, "M")
    _set_param(client, token, "M", "p", 99.0)
    assert _param_value(client, token, "M", "p") == 99.0, "the victim was never set up"

    _project(client, token)  # the second project, where the command will be executed
    _model(client, token, "M")  # same model name — this is what makes the fault silent
    _set_param(client, token, "M", "p", 1.0)
    _set_param(client, token, "M", "p", 2.0)  # so an undo would write 1.0 back
    assert _param_value(client, token, "M", "p") == 2.0
    assert _history(client, token)["next_undo"], "no command to undo — the test proves nothing"

    _activate(client, token, victim)
    assert _param_value(client, token, "M", "p") == 99.0, "the switch itself changed the victim"

    r = client.post("/api/v1/model/undo", headers=token)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "nothing_to_undo"
    # The point of the whole exercise: the other project's parameter is untouched.
    assert _param_value(client, token, "M", "p") == 99.0


def test_deleting_a_project_empties_the_undo_stack(client, token):
    """Deleting the project you are standing in drops you into 'default' — a switch by another name,
    and the stacks would be left pointing at a project that no longer exists."""
    doomed = _project(client, token)
    _model(client, token, "M")
    _set_param(client, token, "M", "p", 1.0)
    assert _history(client, token)["can_undo"] is True

    r = client.delete(f"/api/v1/projects/{doomed}", headers=token)
    assert r.status_code == 200, r.text
    assert _history(client, token)["can_undo"] is False


# --------------------------------------------------------------------------- #
# F2
# --------------------------------------------------------------------------- #
def test_a_recreated_project_starts_its_log_at_index_zero(client, token):
    """F2: `_counts` is keyed by the path string and a recreated project reuses its path.

    The visible consequence is in `AuditLog.tsx`, which uses `key={a.index}`: duplicate React keys,
    and a log whose indices lie about how much history there is.
    """
    name = _project(client, token)
    _model(client, token, "Gone")
    _set_param(client, token, "Gone", "p", 1.0)
    before = client.get("/api/v1/model/audit", headers=token).json()
    assert len(before) > 1, "the first project wrote no history, so nothing could be cached"
    assert audit_store.next_index() == len(before), "the count was not cached in the first place"

    assert client.delete(f"/api/v1/projects/{name}", headers=token).status_code == 200
    r = client.post("/api/v1/projects", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text  # same name, and therefore the same directory

    _model(client, token, "Fresh")
    entries = client.get("/api/v1/model/audit", headers=token).json()
    assert [e["index"] for e in entries] == list(range(len(entries)))
    assert entries[0]["index"] == 0


# --------------------------------------------------------------------------- #
# An undo while a parameter window is open
# --------------------------------------------------------------------------- #
@pytest.fixture
def no_open_windows():
    """The frame stack is process-global; a test that leaves one open would refuse every later undo."""
    yield
    param_window.reset_for_tests()


def test_undo_is_refused_while_a_parameter_window_is_open(client, token, project, no_open_windows):
    """Not an extension — this case exists today and nobody notices it: the undo lands on the
    overridden values and the window's `restore_baseline` puts the pre-undo state back."""
    del project
    _model(client, token, "Win")
    _set_param(client, token, "Win", "p", 1.0)
    _set_param(client, token, "Win", "p", 2.0)
    assert _history(client, token)["can_undo"] is True

    param_window.open_window("Win", "scenario", "Cold winter", {"p": 2.0}, {"p": 5.0})
    assert param_window.open_now() is not None, "the window was not recorded, so nothing is guarded"

    r = client.post("/api/v1/model/undo", headers=token)
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "param_window_open"
    assert "Cold winter" in err["message"] and "Win" in err["message"]
    assert "seconds" in err["hint"]  # it says the wait is short, which is the actionable half
    assert _param_value(client, token, "Win", "p") == 2.0  # nothing was undone

    redo = client.post("/api/v1/model/redo", headers=token)
    assert redo.status_code == 409 and redo.json()["error"]["code"] == "param_window_open"

    param_window.reset_for_tests()
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert _param_value(client, token, "Win", "p") == 1.0


def test_the_refusal_names_the_same_state_the_health_linter_names(client, token, project,
                                                                 no_open_windows):
    """One state, one wording. The linter reports a window a dead process left behind, this reports
    one that is open right now; an author who has read one must recognise the other."""
    del project
    _model(client, token, "Win2")
    _set_param(client, token, "Win2", "p", 1.0)
    _set_param(client, token, "Win2", "p", 2.0)
    param_window.open_window("Win2", "scenario", "Mild climate", {"p": 2.0}, {"p": 7.0})

    refusal = client.post("/api/v1/model/undo", headers=token).json()["error"]["message"]
    linter_phrasing = param_window._labels(param_window._frames)  # what `unresolved` puts in its text
    assert linter_phrasing == "scenario “Mild climate”"
    assert linter_phrasing in refusal
