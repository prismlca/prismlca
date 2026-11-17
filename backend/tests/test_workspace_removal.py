"""Deleting a workspace is all or nothing (engine/workspace_removal.py).

A folder that cannot be removed — on Windows: one with an open file in it — must leave the workspace as it
was, listed and complete, and say why. A deletion that went through must leave nothing a new workspace of
the same name could start in. And a process that dies in the middle must lose nothing: the next start
puts back what was not deleted yet and removes what was.
"""
from __future__ import annotations

import gc
import os
import shutil
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prism_lca.app import create_app
from prism_lca.engine import workspace_removal
from prism_lca.engine.bootstrap import get_bd


@pytest.fixture(autouse=True)
def _no_waiting(monkeypatch):
    """A refused rename is tried again after a pause; the tests that refuse it must not sit through that."""
    monkeypatch.setattr(workspace_removal, "_RETRY_AFTER", ())


def _workspace(client, token, prefix: str = "ws-") -> tuple[str, Path]:
    """A new, active workspace with a model 'M' holding a parameter 'p' — something to lose."""
    name = prefix + uuid.uuid4().hex[:8]
    assert client.post("/api/v1/projects", json={"name": name}, headers=token).status_code == 200
    folder = Path(get_bd().projects.dir)
    assert client.post("/api/v1/databases/foreground", json={"name": "M"}, headers=token).status_code == 200
    r = client.post("/api/v1/params", json={"database": "M", "name": "p", "amount": 7.0}, headers=token)
    assert r.status_code == 200, r.text
    return name, folder


def _listed(client, token) -> dict[str, bool]:
    """Every workspace in the list, and whether it is the active one."""
    return {p["name"]: p["is_active"] for p in client.get("/api/v1/projects", headers=token).json()}


def _base() -> Path:
    return Path(get_bd().projects._base_data_dir)


def _leftovers() -> list[Path]:
    """Every folder a deletion has set aside, whichever state it is in."""
    return sorted(p for p in _base().iterdir() if p.name.startswith(".remov"))


def _refuse_rename(monkeypatch, refused=lambda attempt: True) -> list[int]:
    """Make a rename fail as Windows does for a folder with an open file in it — every attempt, or those
    ``refused`` picks by their number (1 is the first). Returns a one-item list counting the attempts."""
    real, attempts = os.rename, [0]

    def refusing(src, dst):
        attempts[0] += 1
        if refused(attempts[0]):
            raise PermissionError(13, "The process cannot access the file because it is being used by another process")
        return real(src, dst)

    monkeypatch.setattr(workspace_removal.os, "rename", refusing)
    return attempts


@pytest.mark.parametrize("standing_in", ["the workspace", "another workspace"])
def test_a_workspace_in_use_is_not_deleted_and_stays_as_it_was(client, token, monkeypatch, standing_in):
    name, folder = _workspace(client, token)
    if standing_in == "another workspace":
        other = "other-" + uuid.uuid4().hex[:8]
        assert client.post("/api/v1/projects", json={"name": other}, headers=token).status_code == 200
    active_before = next(n for n, active in _listed(client, token).items() if active)
    files_before = sorted(p.relative_to(folder) for p in folder.rglob("*") if p.is_file())
    assert files_before, "the workspace has no files, so nothing could be half removed"
    _refuse_rename(monkeypatch)

    r = client.delete(f"/api/v1/projects/{name}", headers=token)

    assert r.status_code == 409, r.text
    error = r.json()["error"]
    assert error["code"] == "workspace_in_use"
    assert name in error["message"] and "in use" in error["message"]
    assert "Nothing was removed" in error["hint"] and "Try again" in error["hint"]
    # Still listed, and the user is still standing where they stood.
    listed = _listed(client, token)
    assert name in listed
    assert [n for n, active in listed.items() if active] == [active_before]
    assert get_bd().projects.current == active_before
    # Complete: every file, and the model with its parameter can be read again.
    assert sorted(p.relative_to(folder) for p in folder.rglob("*") if p.is_file()) == files_before
    assert _leftovers() == []
    assert client.post(f"/api/v1/projects/{name}/activate", headers=token).status_code == 200
    params = client.get("/api/v1/params?database=M", headers=token).json()
    assert [(p["name"], p["amount"]) for p in params] == [("p", 7.0)]

    # …and once the folder is free again, the same request deletes it.
    monkeypatch.undo()
    assert client.delete(f"/api/v1/projects/{name}", headers=token).status_code == 200
    assert name not in _listed(client, token) and not folder.exists()


def test_a_folder_that_is_free_a_moment_later_is_deleted_without_a_refusal(client, token, monkeypatch):
    """A reader that holds a file for a moment — our own search warm-up after a switch — is waited for."""
    name, folder = _workspace(client, token)
    waited: list[float] = []
    monkeypatch.setattr(workspace_removal, "_RETRY_AFTER", (0.01, 0.02, 0.03))
    monkeypatch.setattr(workspace_removal.time, "sleep", waited.append)
    attempts = _refuse_rename(monkeypatch, lambda attempt: attempt <= 2)

    r = client.delete(f"/api/v1/projects/{name}", headers=token)

    assert r.status_code == 200, r.text
    assert waited == [0.01, 0.02]
    assert attempts[0] == 4  # two refusals, the rename that went through, and the one that records the deletion
    assert name not in _listed(client, token) and not folder.exists()
    assert _leftovers() == []


def test_a_deletion_whose_second_rename_is_refused_is_a_deletion_all_the_same(client, token, settings, monkeypatch):
    """The row is gone, the folder could not get the name that says so and its files could not be removed
    either. The missing row says it: the next start removes the folder instead of putting it back."""
    name, folder = _workspace(client, token)
    _refuse_rename(monkeypatch, lambda attempt: attempt == 2)
    monkeypatch.setattr(workspace_removal.shutil, "rmtree", lambda *a, **k: None)

    assert client.delete(f"/api/v1/projects/{name}", headers=token).status_code == 200

    assert name not in _listed(client, token) and not folder.exists()
    left = _leftovers()
    assert len(left) == 1 and left[0].name.startswith(workspace_removal._REMOVING)
    monkeypatch.undo()
    TestClient(create_app(settings))
    assert _leftovers() == [] and not folder.exists()


def test_creating_a_workspace_settles_what_a_deleted_one_of_that_name_left(client, token, settings, monkeypatch):
    """As above, but the name is used again before the next start. Listed again and with a folder of its
    own, the new workspace would make the old folder look like an interrupted deletion — so creating it
    first gives that folder the name of a finished one."""
    name, folder = _workspace(client, token)
    _refuse_rename(monkeypatch, lambda attempt: attempt == 2)
    monkeypatch.setattr(workspace_removal.shutil, "rmtree", lambda *a, **k: None)
    assert client.delete(f"/api/v1/projects/{name}", headers=token).status_code == 200
    assert [p.name.startswith(workspace_removal._REMOVING) for p in _leftovers()] == [True]

    # While the old folder can neither be renamed nor removed, the name is not given out again…
    _refuse_rename(monkeypatch)
    r = client.post("/api/v1/projects", json={"name": name}, headers=token)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "workspace_in_use"
    assert "was not created" in r.json()["error"]["message"]
    assert name not in _listed(client, token) and not folder.exists()

    # …and once it can, the new workspace starts empty and the old files go at the next start.
    monkeypatch.undo()
    monkeypatch.setattr(workspace_removal.shutil, "rmtree", lambda *a, **k: None)
    assert client.post("/api/v1/projects", json={"name": name}, headers=token).status_code == 200
    assert [p.name.startswith(workspace_removal._REMOVED) for p in _leftovers()] == [True]
    assert [d["name"] for d in client.get("/api/v1/databases", headers=token).json() if d["kind"] == "foreground"] == []
    monkeypatch.undo()
    TestClient(create_app(settings))
    assert _leftovers() == [] and (folder / "parameters.db").is_file()


def test_files_that_cannot_be_removed_do_not_reach_a_new_workspace_of_the_same_name(
    client, token, settings, monkeypatch
):
    """The folder was renamed and the row is gone, and then a file refuses to go. The workspace is deleted
    all the same; what is left lies where no workspace looks, and the next sweep takes it."""
    name, folder = _workspace(client, token)
    monkeypatch.setattr(workspace_removal.shutil, "rmtree", lambda *a, **k: None)

    assert client.delete(f"/api/v1/projects/{name}", headers=token).status_code == 200

    assert name not in _listed(client, token)
    assert not folder.exists()
    left = _leftovers()
    assert len(left) == 1 and (left[0] / "parameters.db").is_file(), "nothing was left, so nothing is proven"

    # The same name again: the same folder, and nothing of the old workspace in it.
    assert client.post("/api/v1/projects", json={"name": name}, headers=token).status_code == 200
    assert Path(get_bd().projects.dir) == folder
    models = [d["name"] for d in client.get("/api/v1/databases", headers=token).json() if d["kind"] == "foreground"]
    assert models == []
    r = client.post("/api/v1/databases/foreground", json={"name": "M"}, headers=token)
    assert r.status_code == 200, r.text
    assert client.get("/api/v1/params?database=M", headers=token).json() == []

    # The next start removes what the deletion had to leave, and nothing of the new workspace.
    monkeypatch.undo()
    assert left[0].name.startswith(workspace_removal._REMOVED)
    TestClient(create_app(settings))
    assert _leftovers() == []
    assert (folder / "parameters.db").is_file(), "the start took the new workspace's folder"
    assert client.get("/api/v1/params?database=M", headers=token).json() == []


def test_a_row_that_cannot_be_deleted_gets_its_folder_back(client, token, monkeypatch):
    """The folder is renamed first; if the list entry then cannot be removed, the entry must not be left
    pointing at nothing."""
    from bw2data.project import ProjectDataset

    name, folder = _workspace(client, token)

    def broken(*args, **kwargs):
        raise RuntimeError("projects.db cannot be written")

    monkeypatch.setattr(ProjectDataset, "delete", broken)
    with pytest.raises(RuntimeError, match="cannot be written"):
        client.delete(f"/api/v1/projects/{name}", headers=token)
    monkeypatch.undo()

    assert (folder / "parameters.db").is_file()
    assert _leftovers() == []
    assert _listed(client, token).get(name) is True  # listed, and still the active one
    params = client.get("/api/v1/params?database=M", headers=token).json()
    assert [(p["name"], p["amount"]) for p in params] == [("p", 7.0)]


def _interrupt_after_the_rename(client, token) -> tuple[str, Path, Path]:
    """The state a process leaves that dies between the rename and the row: the workspace is listed, and
    all of its data lies under the first of the two names. Returns name, folder and where it lies now."""
    name, folder = _workspace(client, token)
    assert client.post("/api/v1/projects/default/activate", headers=token).status_code == 200
    gc.collect()  # as the deletion does: let go of this process's own connections
    aside = folder.with_name(f"{workspace_removal._REMOVING}0a1b2c3d-{folder.name}")
    os.rename(folder, aside)
    assert name in _listed(client, token) and not folder.exists()
    return name, folder, aside


def test_a_deletion_interrupted_before_its_row_went_is_undone_at_the_next_start(client, token, settings):
    """The workspace is still listed, so its data must come back — before anything opens it, because
    opening a listed workspace creates an empty folder under its name."""
    name, folder, aside = _interrupt_after_the_rename(client, token)

    restarted = TestClient(create_app(settings))

    assert not aside.exists() and _leftovers() == []
    assert (folder / "parameters.db").is_file()
    assert restarted.post(f"/api/v1/projects/{name}/activate", headers=token).status_code == 200
    params = restarted.get("/api/v1/params?database=M", headers=token).json()
    assert [(p["name"], p["amount"]) for p in params] == [("p", 7.0)]


def test_a_workspace_whose_folder_cannot_be_put_back_is_not_opened_until_it_can(client, token, settings, monkeypatch):
    """The start-up could not put the folder back — a scan had a file open just then. Opening the
    workspace now would have Brightway create an empty folder under its name, and the data would stay
    where nobody looks. So it is refused, the folder waits, and the next attempt puts it back."""
    name, folder, aside = _interrupt_after_the_rename(client, token)
    _refuse_rename(monkeypatch)

    restarted = TestClient(create_app(settings))  # which also looks for a workspace with data to land in
    assert not folder.exists(), "the start opened the workspace and gave it an empty folder"
    r = restarted.post(f"/api/v1/projects/{name}/activate", headers=token)

    assert r.status_code == 409, r.text
    error = r.json()["error"]
    assert error["code"] == "workspace_in_use"
    assert name in error["message"] and "cannot be opened yet" in error["message"]
    assert "Its data is complete" in error["hint"]
    assert not folder.exists() and (aside / "parameters.db").is_file()
    assert get_bd().projects.current != name

    monkeypatch.undo()
    assert restarted.post(f"/api/v1/projects/{name}/activate", headers=token).status_code == 200
    assert not aside.exists() and _leftovers() == []
    params = restarted.get("/api/v1/params?database=M", headers=token).json()
    assert [(p["name"], p["amount"]) for p in params] == [("p", 7.0)]


def test_a_failed_deletion_whose_folder_cannot_be_put_back_leaves_the_user_in_default(client, token, monkeypatch):
    """Two failures in a row: the row cannot be deleted, and the folder cannot be renamed back. The
    workspace is still listed and its data is whole, but set aside — so the app must not step back into
    it, and opening it later puts the folder back first."""
    from bw2data.project import ProjectDataset

    name, folder = _workspace(client, token)

    def broken(*args, **kwargs):
        raise RuntimeError("projects.db cannot be written")

    monkeypatch.setattr(ProjectDataset, "delete", broken)
    _refuse_rename(monkeypatch, lambda attempt: attempt >= 2)  # set aside, then never renamed again
    with pytest.raises(RuntimeError, match="cannot be written"):
        client.delete(f"/api/v1/projects/{name}", headers=token)

    assert get_bd().projects.current == "default"
    assert not folder.exists(), "the workspace was opened again and got an empty folder"
    left = _leftovers()
    assert len(left) == 1 and (left[0] / "parameters.db").is_file()
    assert name in _listed(client, token)

    monkeypatch.undo()
    assert client.post(f"/api/v1/projects/{name}/activate", headers=token).status_code == 200
    assert _leftovers() == []
    params = client.get("/api/v1/params?database=M", headers=token).json()
    assert [(p["name"], p["amount"]) for p in params] == [("p", 7.0)]


def test_a_folder_in_doubt_is_kept(client, token):
    """Listed, a folder under its name, and one set aside before the row went: which of the two holds the
    workspace's data cannot be told, so neither is touched. Nothing in the app leads here any more; a
    folder copied in by hand could."""
    name, folder, aside = _interrupt_after_the_rename(client, token)
    folder.mkdir()
    kept = sorted(p.relative_to(aside) for p in aside.rglob("*") if p.is_file())

    assert workspace_removal.recover() == {"restored": 0, "removed": 0}
    assert client.post(f"/api/v1/projects/{name}/activate", headers=token).status_code == 200

    assert sorted(p.relative_to(aside) for p in aside.rglob("*") if p.is_file()) == kept
    shutil.rmtree(aside)  # not this test's point: leave the directory as the other tests expect it


def test_recovery_removes_only_what_no_listed_workspace_owns(client, token, project):
    """It looks at the whole data directory, so it must know its own folders from everyone else's — and a
    folder whose second rename was refused (no row, still the first name) from one that is still listed."""
    del client, token, project
    base = _base()
    recorded = base / f"{workspace_removal._REMOVED}0a1b2c3d-gone.12345678"
    unrecorded = base / f"{workspace_removal._REMOVING}4e5f6a7b-gone-too.12345678"
    for ours in (recorded, unrecorded):
        (ours / "lci").mkdir(parents=True)
        (ours / "lci" / "databases.db").write_bytes(b"x")
    stranger = base / ".removed-by-someone-else"
    stranger.mkdir()
    before = sorted(p.name for p in base.iterdir() if p not in (recorded, unrecorded))

    assert workspace_removal.recover() == {"restored": 0, "removed": 2}

    assert not recorded.exists() and not unrecorded.exists()
    assert sorted(p.name for p in base.iterdir()) == before
    stranger.rmdir()


def test_a_workspace_whose_folder_is_already_gone_leaves_the_list(client, token):
    name, folder = _workspace(client, token)
    assert client.post("/api/v1/projects/default/activate", headers=token).status_code == 200
    shutil.rmtree(folder)

    assert client.delete(f"/api/v1/projects/{name}", headers=token).status_code == 200
    assert name not in _listed(client, token)


@pytest.mark.skipif(os.name != "nt", reason="only Windows refuses to rename a folder with an open file in it")
def test_on_windows_an_open_file_in_the_folder_refuses_the_deletion_as_a_whole(client, token):
    """The assumption everything above rests on, checked against the real file system: with a file of the
    workspace open elsewhere, the folder cannot be renamed, so nothing is deleted."""
    name, folder = _workspace(client, token)
    with open(folder / "held-open.txt", "w") as held:
        held.write("in use")
        held.flush()
        r = client.delete(f"/api/v1/projects/{name}", headers=token)
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "workspace_in_use"
        assert name in _listed(client, token)
        assert (folder / "parameters.db").is_file()
        assert _leftovers() == []
    assert client.delete(f"/api/v1/projects/{name}", headers=token).status_code == 200
    assert name not in _listed(client, token) and not folder.exists()
