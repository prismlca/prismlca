"""Two small honesty fixes: the study audit line names only what
changed (V342), and the project list counts its databases (V337)."""
from __future__ import annotations

import uuid


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _latest_summary(client, token) -> str:
    entries = client.get("/api/v1/model/audit", headers=token).json()
    return entries[-1]["summary"]


def test_the_study_audit_names_only_the_fields_that_changed(client, token, project):
    db = _fg(client, token)
    full = {"database": db, "goal": "PCF of a bottle", "scope": "cradle to gate", "author": ""}
    assert client.post("/api/v1/study", json=full, headers=token).status_code == 200
    # The sheet sends every field it shows; only the author is new this time.
    again = {**full, "author": "Somebody"}
    assert client.post("/api/v1/study", json=again, headers=token).status_code == 200
    line = _latest_summary(client, token)
    assert "author" in line
    assert "goal" not in line and "scope" not in line
    # Nothing new at all is said as such, not as a list of untouched fields.
    assert client.post("/api/v1/study", json=again, headers=token).status_code == 200
    assert _latest_summary(client, token).endswith("(no change)")


def test_the_project_list_counts_databases(client, token, project):
    _fg(client, token)
    projects = client.get("/api/v1/projects", headers=token).json()
    active = next(p for p in projects if p["is_active"])
    assert active["database_count"] >= 1


def test_project_routes_survive_the_lock_and_threadpool_move(client, token, project):
    """The project routes run in the threadpool under the LCA lock now — create,
    activate and delete still answer, and a switch to another project drops the undo stack."""
    from prism_lca.engine.bootstrap import get_bd

    other = f"prism-test-{uuid.uuid4().hex[:8]}"
    made = client.post("/api/v1/projects", json={"name": other}, headers=token)
    assert made.status_code == 200, made.text
    assert get_bd().projects.current == other
    back = client.post(f"/api/v1/projects/{project}/activate", headers=token)
    assert back.status_code == 200, back.text
    assert get_bd().projects.current == project
    gone = client.delete(f"/api/v1/projects/{other}", headers=token)
    assert gone.status_code == 200, gone.text
    assert other not in {p["name"] for p in client.get("/api/v1/projects", headers=token).json()}


def test_a_replaced_project_drops_the_factorisation_and_the_loaded_indexes(client, token, project):
    """Restore-over and delete change the data behind a name the caches key on."""
    from prism_lca.api.v1.projects import _project_changed
    from prism_lca.engine import lca

    class Req:
        app = client.app

    client.app.state.search._cache["stale/db"] = object()
    before = lca.model_generation()
    _project_changed(Req(), replaced=True)
    assert lca.model_generation() > before
    assert "stale/db" not in client.app.state.search._cache
