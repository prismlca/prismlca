from __future__ import annotations

import os
import threading
import uuid
from pathlib import Path

import pytest


def _open_files_under(folder: Path) -> list[str] | None:
    """The files below ``folder`` this process still has open, or None where /proc cannot say (Windows,
    macOS). A file that was deleted while open is listed too, as ``… (deleted)``: on Linux that works, on
    Windows it is the delete that fails."""
    fds = Path("/proc/self/fd")
    if not fds.is_dir():
        return None
    still_open = []
    for fd in fds.iterdir():
        try:
            target = os.readlink(fd)
        except OSError:
            continue
        if target.startswith(str(folder)):
            still_open.append(target)
    return sorted(still_open)


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


def test_a_workspace_calculated_in_can_be_deleted_with_nothing_of_it_left_open(client, token):
    """bw2calc keeps a database's processed ZIP files open while its LCA is cached, and Windows refuses to
    delete an open file, so deleting a workspace right after a calculation in it fails there. /proc shows on
    Linux what would still be open on Windows; on Windows the delete itself is the check."""
    from test_calc import _seed_calc

    from prism_lca.engine.bootstrap import get_bd

    name = "calc-" + uuid.uuid4().hex[:8]
    assert client.post("/api/v1/projects", json={"name": name}, headers=token).status_code == 200
    _seed_calc(get_bd())
    folder = Path(get_bd().projects.dir)
    r = client.post(
        "/api/v1/calc/lcia", json={"database": "cfg", "code": "bottle", "method": ["test", "gwp"]}, headers=token
    )
    assert r.status_code == 200, r.text

    r = client.delete(f"/api/v1/projects/{name}", headers=token)
    assert r.status_code == 200, r.text
    assert not folder.exists()
    assert _open_files_under(folder) in ([], None)


def test_a_workspace_with_a_model_and_a_parameter_can_be_deleted_with_nothing_of_it_left_open(client, token):
    """The sequence that failed on Windows: a model is created — an `async` route, so it reads the
    workspace's parameters on the server's event loop — and the workspace is deleted from a worker thread.
    The event loop's connection to `parameters.db` has to be gone by then."""
    from prism_lca.engine.bootstrap import get_bd

    name = "param-" + uuid.uuid4().hex[:8]
    assert client.post("/api/v1/projects", json={"name": name}, headers=token).status_code == 200
    folder = Path(get_bd().projects.dir)
    assert client.post("/api/v1/databases/foreground", json={"name": "M"}, headers=token).status_code == 200
    r = client.post("/api/v1/params", json={"database": "M", "name": "p", "amount": 1.0}, headers=token)
    assert r.status_code == 200, r.text

    r = client.delete(f"/api/v1/projects/{name}", headers=token)
    assert r.status_code == 200, r.text
    assert not folder.exists()
    assert _open_files_under(folder) in ([], None)


@pytest.mark.parametrize("deleted_from", ["inside", "another workspace"])
def test_a_workspace_another_thread_has_read_can_be_deleted_with_nothing_of_it_left_open(
    client, token, deleted_from
):
    """A SQLite connection belongs to the thread that opened it, and Brightway's switch closes only those of
    the thread that switches. Here a thread reads the workspace's parameters and stays alive, as the
    server's event loop and its worker threads do: its connection must not outlive the workspace — whether
    the workspace is deleted while it is the active one or after another one was opened."""
    from bw2data.parameters import ProjectParameter

    from prism_lca.engine.bootstrap import get_bd

    name = "read-" + uuid.uuid4().hex[:8]
    assert client.post("/api/v1/projects", json={"name": name}, headers=token).status_code == 200
    folder = Path(get_bd().projects.dir)
    has_read, may_end = threading.Event(), threading.Event()

    def reader() -> None:
        list(ProjectParameter.select())  # opens this thread's own connection
        has_read.set()
        may_end.wait(60)

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    try:
        assert has_read.wait(60), "the other thread never read the workspace"
        before = _open_files_under(folder)
        if before is not None:
            assert any(t.endswith("parameters.db") for t in before), "nothing was open to begin with"
        if deleted_from == "another workspace":
            other = "other-" + uuid.uuid4().hex[:8]
            assert client.post("/api/v1/projects", json={"name": other}, headers=token).status_code == 200

        r = client.delete(f"/api/v1/projects/{name}", headers=token)
        assert r.status_code == 200, r.text
        assert not folder.exists()
        assert _open_files_under(folder) in ([], None)
    finally:
        may_end.set()
        thread.join(60)


@pytest.mark.parametrize("left_by", ["opening another", "creating another"])
def test_a_workspace_that_was_left_is_let_go_of_by_the_threads_that_read_it(client, token, left_by):
    """The server's event loop and its worker threads read a workspace and live on after the user has left
    it. Their connections must close at the switch: an open `parameters.db` keeps Windows from deleting,
    moving or renaming the folder of a workspace nobody is in — from outside the app too."""
    from bw2data.parameters import ProjectParameter

    from prism_lca.engine.bootstrap import get_bd

    name = "left-" + uuid.uuid4().hex[:8]
    assert client.post("/api/v1/projects", json={"name": name}, headers=token).status_code == 200
    folder = Path(get_bd().projects.dir)
    has_read, may_end = threading.Event(), threading.Event()

    def reader() -> None:
        list(ProjectParameter.select())  # opens this thread's own connection
        has_read.set()
        may_end.wait(60)

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    try:
        assert has_read.wait(60), "the other thread never read the workspace"
        before = _open_files_under(folder)
        if before is not None:
            assert any(t.endswith("parameters.db") for t in before), "nothing was open to begin with"

        if left_by == "opening another":
            r = client.post("/api/v1/projects/default/activate", headers=token)
        else:
            r = client.post("/api/v1/projects", json={"name": "next-" + uuid.uuid4().hex[:8]}, headers=token)
        assert r.status_code == 200, r.text

        assert _open_files_under(folder) in ([], None)
        # Windows refuses to rename a folder with an open file in it, so there this is the check.
        moved = folder.with_name(folder.name + ".moved")
        os.rename(folder, moved)
        os.rename(moved, folder)
    finally:
        may_end.set()
        thread.join(60)
