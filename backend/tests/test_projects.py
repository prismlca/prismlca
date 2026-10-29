from __future__ import annotations

import uuid


def test_projects_require_token(client):
    assert client.get("/api/v1/projects").status_code == 401


def test_create_and_list(client, token):
    name = "p-" + uuid.uuid4().hex[:8]
    r = client.post("/api/v1/projects", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == name
    assert body["is_active"] is True

    names = [p["name"] for p in client.get("/api/v1/projects", headers=token).json()]
    assert name in names


def test_duplicate_conflict(client, token, project):
    r = client.post("/api/v1/projects", json={"name": project}, headers=token)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "project_exists"


def test_activate_missing_returns_404(client, token):
    r = client.post("/api/v1/projects/does-not-exist/activate", headers=token)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "project_not_found"


def test_delete_project(client, token):
    keep = "keep-" + uuid.uuid4().hex[:8]
    drop = "drop-" + uuid.uuid4().hex[:8]
    client.post("/api/v1/projects", json={"name": keep}, headers=token)
    client.post("/api/v1/projects", json={"name": drop}, headers=token)
    # stand in `keep`, delete the other → gone, `keep` untouched
    client.post(f"/api/v1/projects/{keep}/activate", headers=token)

    r = client.delete(f"/api/v1/projects/{drop}", headers=token)
    assert r.status_code == 200, r.text
    names = [p["name"] for p in client.get("/api/v1/projects", headers=token).json()]
    assert drop not in names
    assert keep in names


def test_delete_active_falls_back_to_default(client, token, project):
    r = client.delete(f"/api/v1/projects/{project}", headers=token)
    assert r.status_code == 200, r.text
    info = client.get("/api/v1/system/info", headers=token).json()
    assert info["current_project"]["name"] == "default"


def test_delete_default_is_protected(client, token):
    r = client.delete("/api/v1/projects/default", headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "project_protected"


def test_delete_missing_returns_404(client, token):
    r = client.delete("/api/v1/projects/does-not-exist", headers=token)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "project_not_found"


def test_empty_default_is_hidden_while_another_workspace_is_active(client, token, project):
    # `project` is a fresh, active workspace; bw2data's empty `default` must not clutter the picker.
    names = [p["name"] for p in client.get("/api/v1/projects", headers=token).json()]
    assert project in names
    assert "default" not in names
    # ... but it is listed as soon as the user stands in it (deleting the active one drops them there).
    client.delete(f"/api/v1/projects/{project}", headers=token)
    names = [p["name"] for p in client.get("/api/v1/projects", headers=token).json()]
    assert "default" in names


def test_no_workspace_change_while_a_background_import_runs(client, token, project, monkeypatch):
    """The import worker sets the workspace once and writes for minutes; a
    switch in between sent the rest of the import elsewhere. Every workspace change is refused
    meanwhile, with a message that says why — and allowed again once the import has finished."""
    import uuid as _uuid

    from prism_lca.engine import ecoinvent

    other = "other-" + _uuid.uuid4().hex[:6]
    assert client.post("/api/v1/projects", json={"name": other}, headers=token).status_code == 200
    assert client.post(f"/api/v1/projects/{project}/activate", headers=token).status_code == 200
    monkeypatch.setattr(ecoinvent._status, "state", ecoinvent.JobState.running)
    monkeypatch.setattr(ecoinvent._status, "project", project)
    for method, path, body in (
        ("post", f"/api/v1/projects/{other}/activate", None),
        ("post", "/api/v1/projects", {"name": "x-" + _uuid.uuid4().hex[:6]}),
        ("delete", f"/api/v1/projects/{other}", None),
    ):
        r = getattr(client, method)(path, headers=token, **({"json": body} if body else {}))
        assert r.status_code == 409, (path, r.text)
        assert r.json()["error"]["code"] == "import_running"
    assert client.get("/api/v1/system/info", headers=token).json()["current_project"]["name"] == project
    monkeypatch.setattr(ecoinvent._status, "state", ecoinvent.JobState.done)
    assert client.post(f"/api/v1/projects/{other}/activate", headers=token).status_code == 200


def test_a_background_reset_waits_for_a_running_import(client, token, project, monkeypatch):
    """A reset during an import set the job idle without stopping it, which
    let the workspace guard through while the worker wrote on. A reset is refused meanwhile."""
    from prism_lca.engine import ecoinvent

    code = client.post("/api/v1/setup/background/reset-code", headers=token).json()["code"]
    monkeypatch.setattr(ecoinvent._status, "state", ecoinvent.JobState.running)
    r = client.post("/api/v1/setup/background/reset", json={"code": code}, headers=token)
    assert r.status_code == 409, r.text
    assert ecoinvent._status.state == ecoinvent.JobState.running  # still owned by the import
