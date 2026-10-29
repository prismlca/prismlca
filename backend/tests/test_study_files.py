"""Study metadata: one file per model, and the redo of scenario copies and imports keeping their ids.

Two lifecycle gaps of the per-model study files, fixed together:
- `studies/<safe>.json` let "Model A" and "Model_A" share one file — one model's goal & scope overwrote the
  other's. The name now carries a hash of the exact model name; legacy files are migrated where a workspace
  becomes active.
- Redo of a scenario copy or a workbook import created new ids, so a later step of the same turn that named
  the scenario by id stopped.
"""
from __future__ import annotations

import json

from prism_lca.engine import study
from prism_lca.engine.study import StudyMetaStore, migrate_legacy_files, study_file_name


def _model(client, token, name):
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text


# --- A: one file per model -----------------------------------------------------------------------


def test_two_models_whose_names_used_to_collide_keep_their_own_goal(project):
    del project
    store = StudyMetaStore()
    store.update("Model A", {"goal": "the first"})
    store.update("Model_A", {"goal": "the second"})
    assert store.get("Model A")["goal"] == "the first"
    assert store.get("Model_A")["goal"] == "the second"
    assert study_file_name("Model A") != study_file_name("Model_A")


def test_the_file_name_stays_short_for_a_long_model_name():
    name = "x" * 240
    assert len((study_file_name(name) + ".tmp").encode("utf-8")) < 255


def _legacy(folder, stem, data):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{stem}.json").write_text(json.dumps(data), encoding="utf-8")


def test_a_shared_legacy_file_goes_to_every_model_that_saw_it(tmp_path):
    folder = tmp_path / "studies"
    _legacy(folder, "Model_A", {"goal": "shared"})
    out = migrate_legacy_files(["Model A", "Model_A", "Other"], folder)
    assert out == {"moved": 1, "copies": 2, "archived": 0, "failed": 0, "conflicts": 0}
    for name in ("Model A", "Model_A"):
        assert json.loads((folder / study_file_name(name)).read_text())["goal"] == "shared"
    assert not (folder / "Model_A.json").exists()
    # Idempotent: nothing left to do.
    assert migrate_legacy_files(["Model A", "Model_A"], folder) == {"moved": 0, "copies": 0, "archived": 0, "failed": 0, "conflicts": 0}


def test_an_owned_legacy_file_is_moved_and_an_orphan_is_archived_for_good(tmp_path):
    folder = tmp_path / "studies"
    _legacy(folder, "Kept", {"goal": "mine"})
    _legacy(folder, "Gone_model", {"goal": "a deleted model's"})
    migrate_legacy_files(["Kept"], folder)
    assert json.loads((folder / study_file_name("Kept")).read_text())["goal"] == "mine"
    assert (folder / study.LEGACY_ARCHIVE / "Gone_model.json").exists()
    # A model created later under a matching name does not inherit it.
    migrate_legacy_files(["Kept", "Gone model"], folder)
    assert not (folder / study_file_name("Gone model")).exists()


def test_a_copy_already_written_by_an_interrupted_run_is_kept(tmp_path):
    folder = tmp_path / "studies"
    _legacy(folder, "M", {"goal": "legacy"})
    (folder / study_file_name("M")).write_text(json.dumps({"goal": "already migrated"}), encoding="utf-8")
    migrate_legacy_files(["M"], folder)
    assert json.loads((folder / study_file_name("M")).read_text())["goal"] == "already migrated"
    assert not (folder / "M.json").exists()


def test_activating_a_workspace_migrates_its_legacy_files(client, token, project):
    del project
    _model(client, token, "Bottle (A)")
    folder = study.prism_meta_dir() / "studies"
    _legacy(folder, "Bottle__A_", {"goal": "from an older version"})
    from prism_lca.engine.bootstrap import get_bd

    name = get_bd().projects.current
    r = client.post(f"/api/v1/projects/{name}/activate", headers=token)
    assert r.status_code == 200, r.text
    assert StudyMetaStore().get("Bottle (A)")["goal"] == "from an older version"


def test_rename_delete_and_comparison_links_follow_the_new_names(project):
    del project
    store = StudyMetaStore()
    store.update("A", {"goal": "a"})
    store.update("B", {"goal": "b"})
    store.link("A", "B")
    store.rename_database("A", "A 2")
    assert store.get("A 2")["goal"] == "a"
    assert store.get("A") == {}
    assert store.compared_with("B") == ["A 2"]
    store.remove_database("A 2")
    assert store.compared_with("B") == []


# --- the positive list: study metadata again, with a link as the barrier --------------------------


def test_study_edits_are_reached_past_but_a_link_between_them_holds(client, token, project):
    del project
    for name in ("A", "B"):
        _model(client, token, name)
    assert client.post("/api/v1/study", json={"database": "A", "goal": "a1"}, headers=token).status_code == 200
    assert client.post("/api/v1/study", json={"database": "B", "goal": "b1"}, headers=token).status_code == 200
    # Reached past: B's edit is local.
    assert client.get("/api/v1/model/history?database=A", headers=token).json()["can_undo"] is True
    # A link between the two edits is a barrier.
    assert client.post("/api/v1/study/link", json={"database": "B", "other": "A"}, headers=token).status_code == 200
    assert client.post("/api/v1/study", json={"database": "B", "goal": "b2"}, headers=token).status_code == 200
    h = client.get("/api/v1/model/history?database=A", headers=token).json()
    assert h["can_undo"] is False and h["undo_elsewhere"] is not None


# --- B: redo keeps the ids -----------------------------------------------------------------------


def _turn(token, turn):
    return {**token, "X-Prism-Turn": turn}


def _scenarios(client, token, db):
    return client.get(f"/api/v1/scenarios?database={db}", headers=token).json()


def _param(client, token, db, amount=1.0):
    r = client.post("/api/v1/params", json={"database": db, "name": "p", "amount": amount}, headers=token)
    assert r.status_code == 200, r.text


def _undo_redo(client, token, db, turn, n):
    r = client.post("/api/v1/model/undo", json={"database": db, "turn": turn}, headers=token)
    assert r.json()["undone"] == n, r.text
    r = client.post("/api/v1/model/redo", json={"database": db, "turn": turn}, headers=token)
    assert r.json()["redone"] == n and r.json()["stopped"] is None, r.text


def test_a_copied_scenario_comes_back_under_its_id_on_redo(client, token, project):
    del project
    _model(client, token, "M")
    _param(client, token, "M")
    sid = client.post("/api/v1/scenarios", json={"database": "M", "name": "s", "overrides": {"p": 2.0}},
                      headers=token).json()["scenario"]["id"]
    h = _turn(token, "t")
    copy = client.post("/api/v1/scenarios/duplicate", json={"database": "M", "id": sid}, headers=h).json()["scenario"]
    r = client.post("/api/v1/scenarios/update",
                    json={"database": "M", "id": copy["id"], "name": "renamed", "overrides": {"p": 3.0}}, headers=h)
    assert r.status_code == 200, r.text
    for _ in range(2):  # repeated undo/redo
        _undo_redo(client, token, "M", "t", 2)
    assert sorted(s["name"] for s in _scenarios(client, token, "M")) == ["renamed", "s"]


def test_an_import_comes_back_under_its_ids_on_redo(client, token, project):
    del project
    _model(client, token, "M")
    _param(client, token, "M")
    client.post("/api/v1/scenarios", json={"database": "M", "name": "Existing", "overrides": {"p": 2.0}}, headers=token)
    from prism_lca.api.v1 import scenarios as scen_api
    from prism_lca.engine import commands

    h = _turn(token, "t")
    # Mixed: one new name (twice, casefold-equivalent), one overwrite of an existing scenario.
    cmd = commands.ImportScenariosCommand(scen_api._store(), "M", [
        {"name": "New", "overrides": {"p": 4.0}},
        {"name": "new", "overrides": {"p": 5.0}},
        {"name": "existing", "overrides": {"p": 6.0}},
    ])
    bus = client.app.state.command_bus
    from prism_lca.engine.commands import CURRENT_TURN

    tok = CURRENT_TURN.set("t")
    try:
        bus.execute(cmd)
    finally:
        CURRENT_TURN.reset(tok)
    new_id = next(s["id"] for s in _scenarios(client, token, "M") if s["name"] == "New")
    r = client.post("/api/v1/scenarios/value", json={"database": "M", "id": new_id, "param": "p", "value": 7.0}, headers=h)
    assert r.status_code == 200, r.text
    for _ in range(2):
        _undo_redo(client, token, "M", "t", 2)
    by_name = {s["name"]: s for s in _scenarios(client, token, "M")}
    assert by_name["New"]["id"] == new_id and by_name["New"]["overrides"]["p"] == 7.0
    assert by_name["Existing"]["overrides"]["p"] == 6.0


# --- the migration: its lifecycle gaps -----------------------------


def test_an_unreadable_legacy_file_is_archived_and_the_scan_goes_on(tmp_path):
    folder = tmp_path / "studies"
    folder.mkdir(parents=True)
    (folder / "A.json").write_text("{not json", encoding="utf-8")
    _legacy(folder, "Z", {"goal": "healthy"})
    out = migrate_legacy_files(["A", "Z"], folder)
    assert out["archived"] == 1 and out["failed"] == 0
    assert json.loads((folder / study_file_name("Z")).read_text())["goal"] == "healthy"


def test_after_a_restore_over_the_folder_the_backups_legacy_file_wins(tmp_path):
    """Brightway copies a backup OVER the workspace folder: the current per-model file is still there,
    and the backup's legacy file is the one that must be restored."""
    folder = tmp_path / "studies"
    _legacy(folder, "M", {"goal": "backup"})
    (folder / study_file_name("M")).write_text(json.dumps({"goal": "current"}), encoding="utf-8")
    migrate_legacy_files(["M"], folder, prefer_legacy=True)
    assert json.loads((folder / study_file_name("M")).read_text())["goal"] == "backup"


def test_a_failed_copy_leaves_the_legacy_file_for_the_next_run(tmp_path, monkeypatch):
    folder = tmp_path / "studies"
    _legacy(folder, "M", {"goal": "legacy"})

    def broken(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(study, "write_json_atomic", broken)
    assert migrate_legacy_files(["M"], folder)["failed"] == 1
    assert (folder / "M.json").exists(), "the only copy was deleted"
    monkeypatch.undo()
    migrate_legacy_files(["M"], folder)
    assert json.loads((folder / study_file_name("M")).read_text())["goal"] == "legacy"


def test_a_rename_takes_an_unmigrated_legacy_file_along(project):
    del project
    folder = study.prism_meta_dir() / "studies"
    _legacy(folder, "Old_name", {"goal": "from before"})
    store = StudyMetaStore()
    store.rename_database("Old name", "New name")
    assert store.get("New name")["goal"] == "from before"
    assert not (folder / "Old_name.json").exists()


def test_a_read_catches_an_unfinished_migration_up(client, token, project):
    del project
    _model(client, token, "Late")
    folder = study.prism_meta_dir() / "studies"
    _legacy(folder, "Late", {"goal": "still legacy"})
    assert StudyMetaStore().get("Late")["goal"] == "still legacy"
    # Only a model may claim a legacy file; for a name that is none, it is an orphan.
    _legacy(folder, "Nobody", {"goal": "orphan"})
    assert StudyMetaStore().get("Nobody") == {}
    assert (folder / study.LEGACY_ARCHIVE / "Nobody.json").exists()


def test_deleting_the_active_workspace_migrates_the_one_it_falls_back_to(client, token, project, monkeypatch):
    del project
    import uuid

    import prism_lca.app as app_module

    calls = []
    monkeypatch.setattr(app_module, "_migrate_study_files", lambda **kw: calls.append(kw))
    name = "proj-" + uuid.uuid4().hex[:8]
    assert client.post("/api/v1/projects", json={"name": name}, headers=token).status_code == 200
    calls.clear()
    r = client.delete(f"/api/v1/projects/{name}", headers=token)
    assert r.status_code == 200, r.text
    assert calls, "the workspace it fell back to was not migrated"


def test_a_rename_stops_before_anything_changes_when_its_legacy_file_cannot_be_moved(client, token, project, monkeypatch):
    del project
    _model(client, token, "Old name")
    folder = study.prism_meta_dir() / "studies"
    _legacy(folder, "Old_name", {"goal": "must not be stranded"})

    def broken(*a, **k):
        raise OSError("read-only folder")

    monkeypatch.setattr(study, "write_json_atomic", broken)
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.brightway_repository import BrightwayRepository
    from prism_lca.errors import PrismError

    try:
        BrightwayRepository().rename_foreground_database("Old name", "New name")
        raise AssertionError("the rename went ahead")
    except PrismError as exc:
        assert exc.code == "study_migration_failed"
    assert "Old name" in get_bd().databases and "New name" not in get_bd().databases
    assert (folder / "Old_name.json").exists()


def test_a_restore_migrates_with_the_backup_winning_only_in_the_active_workspace(client, token, project, monkeypatch):
    del project
    from prism_lca.engine import maintenance
    from prism_lca.engine.bootstrap import get_bd

    calls = []
    monkeypatch.setattr(study, "migrate_active_workspace", lambda **kw: calls.append(kw) or {})
    current = get_bd().projects.current
    for restored, expected in (("some-other-workspace", []), (current, [{"prefer_legacy": True}])):
        calls.clear()
        monkeypatch.setattr(maintenance, "restore_project", lambda *a, _n=restored, **k: {"project_name": _n})
        r = client.post("/api/v1/projects/restore", json={"path": "/x.tar.gz", "overwrite": True}, headers=token)
        assert r.status_code == 200, r.text
        assert calls == expected, (restored, calls)


def test_a_restore_whose_study_files_cannot_be_put_in_place_says_so(client, token, project, monkeypatch):
    del project
    from prism_lca.engine import maintenance
    from prism_lca.engine.bootstrap import get_bd

    def unwritable(**kw):
        raise OSError("read-only")

    monkeypatch.setattr(study, "migrate_active_workspace", unwritable)
    current = get_bd().projects.current
    monkeypatch.setattr(maintenance, "restore_project", lambda *a, **k: {"project_name": current})
    from prism_lca.api.v1 import projects as projects_api

    cleaned = []
    real = projects_api._project_changed
    monkeypatch.setattr(projects_api, "_project_changed", lambda *a, **k: cleaned.append(k) or real(*a, **k))
    r = client.post("/api/v1/projects/restore", json={"path": "/x.tar.gz", "overwrite": True}, headers=token)
    assert r.status_code == 500 and r.json()["error"]["code"] == "restore_study_incomplete"
    assert cleaned == [{"replaced": True}], "caches and undo history were left on the replaced workspace"


def test_a_legacy_file_that_differs_from_the_copy_is_archived_never_deleted(tmp_path):
    """Without the restore marker, a differing copy wins (it is the newer study) — and the legacy file is
    kept in the archive, so no version is ever lost."""
    folder = tmp_path / "studies"
    _legacy(folder, "M", {"goal": "backup"})
    (folder / study_file_name("M")).write_text(json.dumps({"goal": "current"}), encoding="utf-8")
    out = migrate_legacy_files(["M"], folder)
    assert out["conflicts"] == 1
    assert json.loads((folder / study_file_name("M")).read_text())["goal"] == "current"
    assert json.loads((folder / study.LEGACY_ARCHIVE / "M.json").read_text())["goal"] == "backup"


def test_the_backup_still_wins_after_a_restore_migration_that_failed_half_way(tmp_path, monkeypatch):
    folder = tmp_path / "studies"
    _legacy(folder, "M", {"goal": "backup"})
    (folder / study_file_name("M")).write_text(json.dumps({"goal": "current"}), encoding="utf-8")

    def broken(*a, **k):
        raise OSError("transient")

    monkeypatch.setattr(study, "write_json_atomic", broken)
    assert migrate_legacy_files(["M"], folder, prefer_legacy=True)["failed"] == 1
    monkeypatch.undo()
    # An ordinary run later: the marker keeps "the backup wins".
    migrate_legacy_files(["M"], folder)
    assert json.loads((folder / study_file_name("M")).read_text())["goal"] == "backup"
    assert not (folder / study.PREFER_LEGACY_MARKER).exists()
