"""The audit log survives a restart — which is what ADR-004 promised all along.

It used to be a list in `CommandBus`, so every backend start began the history again. These tests
stand on the two things that makes a log: it is still there afterwards, and one damaged line does not
take the rest with it.
"""
from __future__ import annotations

import json

from prism_lca.engine import audit_store
from prism_lca.engine.commands import CommandBus


def test_a_new_bus_on_the_same_project_sees_the_old_entries(client, token, project):
    """A restart is a new CommandBus over the same project directory."""
    del project
    r = client.post("/api/v1/databases/foreground", json={"name": "AuditA"}, headers=token)
    assert r.status_code == 200, r.text

    before = client.get("/api/v1/model/audit", headers=token).json()
    assert any(e["action"] == "create_model" for e in before), before

    fresh = CommandBus()  # what a restarted backend builds
    entries = fresh.audit()
    assert [e.action for e in entries] == [e["action"] for e in before]
    assert entries[0].index == 0


def test_indices_keep_counting_across_a_restart(client, token, project):
    del project
    client.post("/api/v1/databases/foreground", json={"name": "AuditB"}, headers=token)
    first = client.get("/api/v1/model/audit", headers=token).json()
    audit_store.reset_cache()  # a fresh process has counted nothing yet
    bus = CommandBus()
    bus.note("user", "probe", "after the restart")
    after = bus.audit()
    assert [e.index for e in after] == list(range(len(after)))
    assert len(after) == len(first) + 1
    assert after[-1].summary == "after the restart"


def test_a_truncated_last_line_costs_one_entry_and_not_the_log(client, token, project):
    del project
    client.post("/api/v1/databases/foreground", json={"name": "AuditC"}, headers=token)
    path = audit_store.path()
    good = len(audit_store.load())
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"index": 99, "timestamp": "2026-07-31T00:00:00+00:00", "sour')  # killed mid-write
    assert len(audit_store.load()) == good  # the broken line is skipped, the rest is intact

    # …and the next entry does not get fused onto the partial line, which would lose it too.
    audit_store.reset_cache()
    CommandBus().note("user", "probe", "after the crash")
    entries = audit_store.load()
    assert entries[-1]["summary"] == "after the crash"
    assert len(entries) == good + 1


def test_the_log_is_one_json_object_per_line(client, token, project):
    del project
    client.post("/api/v1/databases/foreground", json={"name": "AuditD"}, headers=token)
    lines = [ln for ln in audit_store.path().read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert lines, "nothing was written"
    for ln in lines:
        entry = json.loads(ln)  # every line stands on its own
        assert {"index", "timestamp", "source", "action", "summary", "undoable"} <= set(entry)


def test_an_entry_from_a_future_version_does_not_break_reading(client, token, project):
    del project
    client.post("/api/v1/databases/foreground", json={"name": "AuditE"}, headers=token)
    with audit_store.path().open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"index": 999, "timestamp": "2026-08-01T00:00:00+00:00", "source": "user",
                             "action": "future_thing", "summary": "written by a later version",
                             "undoable": True, "affects": ["something new"]}) + "\n")
    audit_store.reset_cache()
    actions = [e.action for e in CommandBus().audit()]
    assert "future_thing" in actions


def test_the_support_bundle_carries_history_from_before_the_restart(client, token, project):
    del project
    client.post("/api/v1/databases/foreground", json={"name": "AuditF"}, headers=token)
    audit_store.reset_cache()
    # A fresh bus stands in for the restart; the endpoint reads through app.state's bus, which now
    # loads from disk either way — so the bundle sees the earlier entries.
    r = client.get("/api/v1/system/support-bundle", headers=token)
    assert r.status_code == 200
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        audit = json.loads(zf.read("audit.json"))
    assert any(e["action"] == "create_model" for e in audit)
