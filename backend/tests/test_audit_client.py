"""An external client names itself in ``X-Prism-Client``, and every audit line
written under that request carries the label — the executed command, and the undo that takes it
back, each with the client of *its own* request.

The label is a label, not an identity: a value outside the pattern is treated as absent, because
the log is append-only forever and nothing unvalidated goes into it.
"""
from __future__ import annotations

import json
import uuid

from prism_lca.engine import audit_store
from prism_lca.engine.commands import CommandBus


def _model(client, token) -> str:
    name = "client-" + uuid.uuid4().hex[:8]
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    return name


def _h(token: dict, label: str | None = None) -> dict:
    return {**token, **({"X-Prism-Client": label} if label is not None else {})}


def _set_param(client, headers, database, name, amount) -> None:
    r = client.post(
        "/api/v1/params",
        json={"database": database, "name": name, "amount": amount, "source": "ai"},
        headers=headers,
    )
    assert r.status_code == 200, r.text


def _entries(client, token, database, action) -> list[dict]:
    r = client.get(f"/api/v1/model/audit?database={database}", headers=token)
    assert r.status_code == 200, r.text
    return [e for e in r.json() if e["action"] == action]


def test_a_command_carries_the_client_header_and_none_without_it(client, token, project):
    db = _model(client, token)
    _set_param(client, _h(token, "Claude Code"), db, "pa", 1)
    _set_param(client, token, db, "pb", 2)
    by_name = {("pa" if "'pa'" in e["summary"] else "pb"): e for e in _entries(client, token, db, "set_parameter")}
    assert by_name["pa"]["client"] == "Claude Code"
    assert by_name["pa"]["source"] == "ai"  # the body's source is untouched
    assert "client" not in by_name["pb"]


def test_an_invalid_client_label_is_absent(client, token, project):
    db = _model(client, token)
    for i, label in enumerate(["", "x" * 81, "evil<script>", "semi;colon", "tab\there"]):
        _set_param(client, _h(token, label), db, f"p{i}", i)
    # The longest valid one, with every allowed punctuation mark and a Unicode letter.
    ok = "Cowork/1.2_beta-3: Jürgen " + "x" * 54
    assert len(ok) == 80
    _set_param(client, {**token, "X-Prism-Client": ok.encode("utf-8")}, db, "pok", 9)
    entries = _entries(client, token, db, "set_parameter")
    assert [e["client"] for e in entries if "client" in e] == [ok]


def test_undo_carries_the_client_of_the_undo_request(client, token, project):
    db = _model(client, token)
    _set_param(client, _h(token, "codex"), db, "pa", 1)
    r = client.post("/api/v1/model/undo", headers=_h(token, "codex"))
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/model/redo", headers=_h(token, "codex"))
    assert r.status_code == 200, r.text
    # Undo from the app itself: the change was the agent's, the undo is not.
    r = client.post("/api/v1/model/undo", headers=token)
    assert r.status_code == 200, r.text
    undos = _entries(client, token, db, "undo")
    assert [e.get("client") for e in undos] == ["codex", None]
    assert [e.get("client") for e in _entries(client, token, db, "redo")] == ["codex"]


def test_the_client_filter_narrows_the_log(client, token, project):
    db = _model(client, token)
    _set_param(client, _h(token, "codex"), db, "pa", 1)
    _set_param(client, token, db, "pb", 2)
    r = client.get(f"/api/v1/model/audit?database={db}&client=codex", headers=token)
    assert r.status_code == 200, r.text
    assert [e["client"] for e in r.json()] == ["codex"]


def test_an_old_line_without_client_still_loads(client, token, project):
    del project
    old = {"index": audit_store.next_index(), "timestamp": "2026-08-01T00:00:00", "source": "user",
           "action": "probe_old", "summary": "written before the field existed"}
    audit_store.append(old)
    line = audit_store.path().read_text(encoding="utf-8").strip().splitlines()[-1]
    assert "client" not in json.loads(line)
    entry = next(e for e in CommandBus().audit() if e.action == "probe_old")
    assert entry.client is None
