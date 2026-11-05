"""An external agent session undoes and redoes its own steps; any other step needs the user's approval for that step."""

from __future__ import annotations

import pytest

from prism_lca.engine import step_owner

SESSION = "mcp-aaaaaaaa-"
OTHER = "mcp-bbbbbbbb-"


@pytest.fixture
def shared(client, token, project):
    del project
    r = client.post("/api/v1/databases/foreground", json={"name": "Shared"}, headers=token)
    assert r.status_code == 200, r.text
    return client, token


def _h(token: dict, turn: str | None = None, approved: str | None = None) -> dict:
    headers = dict(token)
    if turn:
        headers["X-Prism-Turn"] = turn
    if approved:
        headers["X-Prism-Approved-Step"] = approved
    return headers


def _process(client, token, name: str, turn: str | None = None) -> None:
    r = client.post(
        "/api/v1/model/activities",
        json={"database": "Shared", "name": name, "unit": "kg", "source": "ai" if turn else "user"},
        headers=_h(token, turn),
    )
    assert r.status_code == 200, r.text


def _names(client, token) -> set[str]:
    r = client.get("/api/v1/model/activities/Shared", headers=token)
    assert r.status_code == 200, r.text
    return {a["name"] for a in r.json()}


def _step(client, token, verb: str, turn: str | None = None, approved: str | None = None):
    return client.post(
        f"/api/v1/model/{verb}",
        json={"database": "Shared", "source": "ai" if turn else "user"},
        headers=_h(token, turn, approved),
    )


def _next(client, token, verb: str, turn: str | None) -> dict:
    r = client.get(f"/api/v1/model/history/next?verb={verb}&database=Shared", headers=_h(token, turn))
    assert r.status_code == 200, r.text
    return r.json()


def test_an_external_undo_of_the_users_step_is_refused_and_leaves_the_stack(shared):
    client, token = shared
    _process(client, token, "user's own work")
    r = _step(client, token, "undo", SESSION + "2")
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "undo_not_yours"
    assert "user's own work" in r.json()["error"]["message"]
    # Nothing was taken: the step is still there for the user, and the user's own undo still works.
    assert "user's own work" in _names(client, token)
    assert _step(client, token, "undo").status_code == 200
    assert "user's own work" not in _names(client, token)


def test_the_sessions_own_step_is_undone_without_asking(shared):
    client, token = shared
    _process(client, token, "agent's process", SESSION + "1")
    assert _next(client, token, "undo", SESSION + "2")["needs_approval"] is False
    r = _step(client, token, "undo", SESSION + "2")
    assert r.status_code == 200, r.text
    assert "agent's process" not in _names(client, token)
    # Its own undone step comes back the same way.
    assert _step(client, token, "redo", SESSION + "3").status_code == 200
    assert "agent's process" in _names(client, token)


def test_an_undo_meant_for_its_own_step_does_not_take_the_users_newer_one(shared):
    client, token = shared
    _process(client, token, "agent's process", SESSION + "1")
    _process(client, token, "user's process made after the agent's")
    r = _step(client, token, "undo", SESSION + "3")
    assert r.status_code == 409, r.text
    assert {"agent's process", "user's process made after the agent's"} <= _names(client, token)


def test_another_sessions_step_and_the_chats_step_are_not_this_sessions(shared):
    client, token = shared
    _process(client, token, "other session's", OTHER + "1")
    assert _step(client, token, "undo", SESSION + "1").status_code == 409
    _process(client, token, "the chat's", "turn-abc-123")
    assert _step(client, token, "undo", SESSION + "2").status_code == 409
    assert {"other session's", "the chat's"} <= _names(client, token)


def test_an_approved_step_is_taken_and_only_that_step(shared):
    client, token = shared
    _process(client, token, "first")
    ask = _next(client, token, "undo", SESSION + "1")
    assert ask["needs_approval"] is True and "first" in ask["summary"] and isinstance(ask["step"], int)
    # An approval covers the step it named, not a newer one.
    _process(client, token, "made while the card was open")
    r = _step(client, token, "undo", SESSION + "1", approved=f"undo:{ask['step']}")
    assert r.status_code == 409, r.text
    assert {"first", "made while the card was open"} <= _names(client, token)
    # Approved for the step that IS on top: taken.
    ask = _next(client, token, "undo", SESSION + "2")
    r = _step(client, token, "undo", SESSION + "2", approved=f"undo:{ask['step']}")
    assert r.status_code == 200, r.text
    assert "made while the card was open" not in _names(client, token)
    # An approval to undo is not one to redo the same step.
    r = _step(client, token, "redo", SESSION + "3", approved=f"undo:{ask['step']}")
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "redo_changed"
    assert _step(client, token, "redo", SESSION + "4", approved=f"redo:{ask['step']}").status_code == 200


def test_an_approval_covers_only_its_step_also_when_the_next_one_is_the_sessions_own(shared):
    client, token = shared
    _process(client, token, "agent's", SESSION + "1")
    _process(client, token, "user's")
    ask = _next(client, token, "undo", SESSION + "2")
    assert ask["needs_approval"] is True and "user's" in ask["summary"]
    # The user's step is taken back in the window while the card is open.
    assert _step(client, token, "undo").status_code == 200
    r = _step(client, token, "undo", SESSION + "2", approved=f"undo:{ask['step']}")
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "undo_changed"
    assert "agent's" in _names(client, token)
    # Asked again, the session's own step needs no approval.
    assert _next(client, token, "undo", SESSION + "3")["needs_approval"] is False
    assert _step(client, token, "undo", SESSION + "3").status_code == 200
    assert "agent's" not in _names(client, token)


def test_a_redo_approval_covers_only_its_step(shared):
    client, token = shared
    _process(client, token, "user's")
    _process(client, token, "agent's", SESSION + "1")
    assert _step(client, token, "undo").status_code == 200  # the agent's, in the window
    assert _step(client, token, "undo").status_code == 200  # the user's
    ask = _next(client, token, "redo", SESSION + "2")
    assert ask["needs_approval"] is True and "user's" in ask["summary"]
    assert _step(client, token, "redo").status_code == 200  # the user redoes it in the window
    r = _step(client, token, "redo", SESSION + "2", approved=f"redo:{ask['step']}")
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "redo_changed"
    assert "agent's" not in _names(client, token)


def test_the_window_and_the_chat_are_not_affected(shared):
    client, token = shared
    _process(client, token, "agent's", SESSION + "1")
    assert _next(client, token, "undo", None)["needs_approval"] is False
    assert _step(client, token, "undo").status_code == 200  # the user takes back the agent's step
    assert _step(client, token, "redo").status_code == 200
    _process(client, token, "user's")
    r = client.post(
        "/api/v1/model/undo",
        json={"database": "Shared", "source": "ai"},
        headers=_h(token, "turn-xyz-1"),
    )
    assert r.status_code == 200, r.text  # the in-app chat, where the user is present


def test_a_whole_turn_is_taken_only_when_it_is_the_sessions_own(shared):
    client, token = shared
    _process(client, token, "other's", OTHER + "7")
    r = client.post(
        "/api/v1/model/undo",
        json={"database": "Shared", "turn": OTHER + "7", "source": "ai"},
        headers=_h(token, SESSION + "1"),
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "turn_not_yours"
    _process(client, token, "own", SESSION + "2")
    r = client.post(
        "/api/v1/model/undo",
        json={"database": "Shared", "turn": SESSION + "2", "source": "ai"},
        headers=_h(token, SESSION + "3"),
    )
    assert r.status_code == 200, r.text
    assert "own" not in _names(client, token) and "other's" in _names(client, token)


def test_the_ownership_rule_fails_closed():
    # A turn that only looks external owns nothing, not even a step with the same text.
    assert step_owner.needs_approval("mcp-x", "mcp-x") is True
    assert step_owner.needs_approval(SESSION + "1", SESSION + "9") is False
    assert step_owner.needs_approval(None, SESSION + "1") is True
    assert step_owner.needs_approval(None, None) is False
    assert step_owner.needs_approval(None, "turn-abc-1") is False
    assert step_owner.parse_approval("undo:3") == ("undo", 3)
    assert step_owner.parse_approval("redo:007") == ("redo", 7)
    for raw in (None, "", "undo", "undo:", "undo:x", "delete:3", "undo:-3", "undo:3;redo:4"):
        assert step_owner.parse_approval(raw) is None


def test_step_ids_are_stable_and_never_reused():
    class Step:
        pass

    a, b = Step(), Step()
    first = step_owner.step_id(a)
    assert step_owner.step_id(a) == first
    assert step_owner.step_id(b) > first
    del a
    assert step_owner.step_id(Step()) > first
