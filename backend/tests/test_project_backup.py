"""The project backup — and the one thing that would make it silently useless.

`bw2io.backup_project_directory()` tars the project directory. Everything PrismLCA knows that is not
in Brightway lives in `prism_meta/` *inside* that directory, so it comes along — but that is an
assumption about somebody else's library, and if it ever stopped being true the backup would be
missing the tags, scenarios, study metadata, reports, views and the audit log with nothing to say so.
Hence a test that opens the archive and looks.
"""
from __future__ import annotations

import tarfile
from pathlib import Path

import pytest

from prism_lca.engine import maintenance, project_backup


def test_the_estimate_names_the_licence_problem(client, token, project):
    del project
    r = client.get("/api/v1/system/backup/estimate", headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["bytes"] >= 0
    # In the response, not only in a dialog: a UI redesign cannot lose it.
    assert "licensed" in body["warning"]
    assert ".prism" in body["warning"]  # and it says what to use instead


def test_the_archive_contains_what_prism_knows(client, token, project, tmp_path):
    del project
    db = "BackupModel"
    assert client.post("/api/v1/databases/foreground", json={"name": db},
                       headers=token).status_code == 200
    code = client.post("/api/v1/model/activities", json={"database": db, "name": "bottle",
                                                         "unit": "kilogram"},
                       headers=token).json()["activity"]["code"]
    client.post("/api/v1/model/tags", json={"database": db, "code": code,
                                            "dimension": "Life-cycle phase", "value": "Production"},
                headers=token)
    client.post("/api/v1/study", json={"database": db, "goal": "PCF"}, headers=token)
    client.put(f"/api/v1/views/{db}", json={"view": {"colors": {code: "#93c120"}}}, headers=token)

    r = client.post("/api/v1/system/backup", json={"directory": str(tmp_path)}, headers=token)
    assert r.status_code == 200, r.text
    path = Path(r.json()["path"])
    assert path.exists() and path.suffix == ".gz"
    assert "licensed" in r.json()["warning"]

    with tarfile.open(path) as tf:
        names = tf.getnames()
    # Brightway's own store…
    assert any("/lci/" in n or n.endswith(".db") or "processed" in n for n in names), names[:20]
    # …and ours, which is the part nobody would notice going missing.
    # The real layout: studies are one file per model in a subdirectory, the rest sits flat.
    from prism_lca.engine.study import study_file_name

    for expected in ("prism_meta/tags.json", "prism_meta/views.json", "prism_meta/audit.jsonl",
                     f"prism_meta/studies/{study_file_name(db)}"):
        assert any(n.endswith(expected) for n in names), (expected, sorted(
            n for n in names if "prism_meta" in n)[:20])


def test_a_missing_target_directory_is_refused_before_any_work(client, token, project):
    del project
    r = client.post("/api/v1/system/backup", json={"directory": "/nope/not/here"}, headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "backup_target_missing"


def test_the_warning_is_one_string_in_one_place():
    """Three places say it; one string defines it. A second copy is a second thing to forget."""
    assert "do not pass it on" in project_backup.WARNING


def test_a_backup_restores_under_a_new_name_and_never_over_an_existing_one(client, token, project, tmp_path):
    """Restore reads the workspace name from the archive; the same name again is a 409 the app turns into
    "restore under another name" — never an overwrite by accident."""
    del project
    assert client.post("/api/v1/databases/foreground", json={"name": "RestoreModel"},
                       headers=token).status_code == 200
    path = client.post("/api/v1/system/backup", json={"directory": str(tmp_path)},
                       headers=token).json()["path"]

    same = client.post("/api/v1/projects/restore", json={"path": path}, headers=token)
    assert same.status_code == 409, same.text
    assert same.json()["error"]["code"] == "workspace_exists"

    ok = client.post("/api/v1/projects/restore", json={"path": path, "project_name": "restored-copy"},
                     headers=token)
    assert ok.status_code == 200, ok.text
    assert ok.json()["project_name"] == "restored-copy"
    names = [p["name"] for p in client.get("/api/v1/projects", headers=token).json()]
    assert "restored-copy" in names
    # The restore never made the new workspace the active one (writers outside the
    # project lock would have landed in it while it was being copied).
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    active = bd.projects.current
    assert active != "restored-copy"
    # …and it is a complete workspace: switch in, the model is there.
    bd.projects.set_current("restored-copy")
    try:
        assert "RestoreModel" in bd.databases
    finally:
        bd.projects.set_current(active)


def test_a_file_that_is_not_a_backup_is_refused_with_a_reason(client, token, project, tmp_path):
    del project
    junk = tmp_path / "notes.tar.gz"
    junk.write_bytes(b"not a tarball")
    r = client.post("/api/v1/projects/restore", json={"path": str(junk)}, headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "backup_unreadable"


def test_a_restore_that_dies_while_copying_leaves_no_folder_behind(client, token, project, tmp_path, monkeypatch):
    """Disk full half-way: the partial folder would be invisible in the app and block the next attempt."""
    import shutil

    from bw2data.project import ProjectDataset

    from prism_lca.engine.bootstrap import get_bd

    del project
    path = client.post("/api/v1/system/backup", json={"directory": str(tmp_path)},
                       headers=token).json()["path"]
    real = shutil.copytree
    depth = {"n": 0}

    def half_copy(src, dst, *a, **k):
        # copytree recurses through the module attribute: only the outermost call fails, after copying.
        depth["n"] += 1
        try:
            real(src, dst, *a, **k)
        finally:
            depth["n"] -= 1
        if depth["n"] == 0:
            raise OSError("No space left on device")

    monkeypatch.setattr(shutil, "copytree", half_copy)
    with pytest.raises(OSError):
        maintenance.restore_project(path, "half-copied")
    projects = get_bd().projects
    assert "half-copied" not in projects
    assert not projects._project_dir(ProjectDataset(name="half-copied", full_hash=False)).exists()
