"""One assistant turn (one chat message → one agent run) is one group.

The AI loop sends ``X-Prism-Turn`` with every backend call of a run; the bus stamps every executed
command with it, the audit log stores it, and undo/redo can take a whole contiguous turn back in
one go. The rules under test, in the order they were settled:

* the turn is **written, never inferred** — a malformed header is treated as absent, because the
  log file is append-only forever;
* a turn is only offered (and only taken) while it lies **contiguously on top** of the stack —
  anything else would pull from the middle, which D4 forbids;
* a failure **mid-batch stops the batch honestly**: the failed command goes back on its stack,
  what was undone stays undone, and the answer carries both numbers. No rollback theatre.
"""
from __future__ import annotations

import uuid

from prism_lca.engine.commands import CURRENT_TURN, Command, CommandBus


def _model(client, token) -> str:
    name = "turns-" + uuid.uuid4().hex[:8]
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    return name


def _h(token: dict, turn: str | None = None) -> dict:
    return {**token, **({"X-Prism-Turn": turn} if turn else {})}


def _set_param(client, headers, database, name, amount) -> None:
    r = client.post(
        "/api/v1/params",
        json={"database": database, "name": name, "amount": amount, "source": "ai"},
        headers=headers,
    )
    assert r.status_code == 200, r.text


def _params(client, token, database) -> dict[str, float]:
    r = client.get(f"/api/v1/params?database={database}", headers=token)
    assert r.status_code == 200, r.text
    return {p["name"]: p["amount"] for p in r.json()}


def _history(client, token) -> dict:
    r = client.get("/api/v1/model/history", headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def _audit(client, token, database) -> list[dict]:
    r = client.get(f"/api/v1/model/audit?database={database}", headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def test_a_turn_is_written_to_the_log_and_a_malformed_one_is_not(client, token, project):
    db = _model(client, token)
    _set_param(client, _h(token, "turn-alpha"), db, "pa", 1)
    _set_param(client, _h(token, "not a valid turn!!"), db, "pb", 2)
    _set_param(client, token, db, "pc", 3)
    by_summary = {e["summary"]: e for e in _audit(client, token, db) if e["action"] == "set_parameter"}
    assert by_summary[next(s for s in by_summary if "'pa'" in s)].get("turn") == "turn-alpha"
    # Malformed and absent headers both mean "no turn" — nothing unvalidated reaches the file.
    assert "turn" not in by_summary[next(s for s in by_summary if "'pb'" in s)]
    assert "turn" not in by_summary[next(s for s in by_summary if "'pc'" in s)]


def test_history_names_only_the_contiguous_block_on_top(client, token, project):
    db = _model(client, token)
    _set_param(client, _h(token, "turn-one"), db, "pa", 1)
    _set_param(client, _h(token, "turn-one"), db, "pb", 2)
    # The user changes something after the turn: the turn is no longer on top, so it is not offered.
    _set_param(client, token, db, "pc", 3)
    assert _history(client, token)["next_undo_turn"] is None
    _set_param(client, _h(token, "turn-two"), db, "pd", 4)
    _set_param(client, _h(token, "turn-two"), db, "pe", 5)
    assert _history(client, token)["next_undo_turn"].items() >= {"turn": "turn-two", "size": 2}.items()  # plus the span it covers


def test_undo_turn_takes_the_whole_block_and_redo_brings_it_back(client, token, project):
    db = _model(client, token)
    _set_param(client, _h(token, "turn-one"), db, "pa", 1)
    _set_param(client, token, db, "pc", 3)
    _set_param(client, _h(token, "turn-two"), db, "pd", 4)
    _set_param(client, _h(token, "turn-two"), db, "pe", 5)
    r = client.post("/api/v1/model/undo", json={"turn": "turn-two"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json() == {"undone": 2, "stopped": None, "remaining_in_turn": 0}
    p = _params(client, token, db)
    assert "pd" not in p and "pe" not in p
    assert p["pa"] == 1 and p["pc"] == 3  # the older turn and the user's change stay untouched
    # The batch is ONE line in the log, not forty.
    last = _audit(client, token, db)[-1]
    assert last["action"] == "undo" and "2 changes of one assistant turn" in last["summary"]
    # The block moved to the redo stack whole, and comes back whole.
    assert _history(client, token)["next_redo_turn"].items() >= {"turn": "turn-two", "size": 2}.items()  # plus the span it covers
    r = client.post("/api/v1/model/redo", json={"turn": "turn-two"}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["redone"] == 2
    assert _params(client, token, db)["pe"] == 5


def test_a_turn_that_is_not_on_top_is_refused(client, token, project):
    db = _model(client, token)
    _set_param(client, _h(token, "turn-one"), db, "pa", 1)
    _set_param(client, token, db, "pc", 3)
    r = client.post("/api/v1/model/undo", json={"turn": "turn-one"}, headers=token)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "turn_not_on_top"
    # And the plain single-step undo still works exactly as before, body or no body.
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert "pc" not in _params(client, token, db)


class _Step(Command):
    """Test-local command: three of these are a turn; one refuses to be undone."""

    action = "step"
    audit_attr = None  # deliberately project-wide; the attribution tripwire scans commands.py only

    def __init__(self, name: str, fail_undo: bool = False) -> None:
        self.name = name
        self.fail_undo = fail_undo

    def execute(self) -> dict:
        return {}

    def undo(self) -> None:
        if self.fail_undo:
            raise RuntimeError("boom")

    def summary(self) -> str:
        return f"step {self.name}"


def test_a_failure_mid_batch_stops_honestly_and_keeps_the_stacks_consistent(project):
    bus = CommandBus()
    marker = CURRENT_TURN.set("turn-x")
    try:
        first, second, third = _Step("first"), _Step("second", fail_undo=True), _Step("third")
        for cmd in (first, second, third):
            bus.execute(cmd, source="ai")
    finally:
        CURRENT_TURN.reset(marker)
    r = bus.undo_turn("turn-x")
    # The third was undone, the second failed and went BACK on the stack, the first was never tried.
    assert r["undone"] == 1
    assert "step second" in r["stopped"] and "boom" in r["stopped"]
    assert r["remaining_in_turn"] == 2
    h = bus.history()
    assert h["next_undo_turn"].items() >= {"turn": "turn-x", "size": 2}.items()  # plus the span it covers
    assert h["next_redo_turn"].items() >= {"turn": "turn-x", "size": 1}.items()  # plus the span it covers
