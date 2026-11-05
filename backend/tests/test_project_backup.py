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
    with pytest.raises(OSError), maintenance.staged_backup(path, "half-copied") as staged:
        maintenance.restore_project(staged)
    projects = get_bd().projects
    assert "half-copied" not in projects
    assert not projects._project_dir(ProjectDataset(name="half-copied", full_hash=False)).exists()


def _seed_round_trip(bd) -> None:
    """A background, an LCIA method and a model with the values Brightway pickles: amounts, uncertainty,
    classifications, tuples, nested dicts."""
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    fg = bd.Database("fg")
    fg.write(
        {
            ("fg", "elec"): {
                "name": "electricity", "unit": "kWh", "reference product": "electricity", "location": "CH",
                "classifications": [("CPC", "17100: Electrical energy")],
                "exchanges": [
                    {"input": ("fg", "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere",
                     "uncertainty type": 2, "loc": -0.69, "scale": 0.2, "pedigree": {"reliability": 2}},
                ],
            },
            ("fg", "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle",
                "exchanges": [
                    {"input": ("fg", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("fg", "elec"), "amount": 0.0, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    for e in fg.get("bottle").technosphere():
        e["prism_uid"] = "e"
        e.save()
    bd.databases["fg"]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])
    bd.calculation_setups["setup"] = {"inv": [{("fg", "bottle"): 1}], "ia": [("test", "gwp")]}


def test_a_realistic_workspace_survives_the_restore_checks(client, token, project, tmp_path, monkeypatch):
    """Every store bw2data pickles is present, checked and restored as it was."""
    from prism_lca.engine import workspace_pickles
    from prism_lca.engine.bootstrap import get_bd

    del project
    bd = get_bd()
    _seed_round_trip(bd)
    body = {"activity_database": "fg", "activity_code": "bottle", "uid": "e"}
    assert client.post("/api/v1/params", json={"database": "fg", "name": "kwh", "amount": 2.0},
                       headers=token).status_code == 200
    assert client.post("/api/v1/params/exchange-formula", json={**body, "formula": "kwh * 1"},
                       headers=token).status_code == 200
    assert client.post("/api/v1/model/exchanges/uncertainty",
                       json={**body, "distribution": "lognormal", "params": {"median": 2.0, "gsd": 1.5}},
                       headers=token).status_code == 200
    assert client.post("/api/v1/scenarios", json={"database": "fg", "name": "efficient",
                                                  "overrides": {"kwh": 1.0}}, headers=token).status_code == 200
    calc = {"database": "fg", "code": "bottle", "method": ["test", "gwp"]}
    score = client.post("/api/v1/calc/lcia", json=calc, headers=token).json()["score"]
    path = Path(client.post("/api/v1/system/backup", json={"directory": str(tmp_path)},
                            headers=token).json()["path"])
    with tarfile.open(path) as tf:
        names = tf.getnames()
    for store in ("/lci/databases.db", "/parameters.db", "/preferences.pickle", "/geomapping.pickle",
                  "/setups.pickle"):
        assert any(n.endswith(store) for n in names), store
    assert any("/intermediate/" in n and n.endswith(".pickle") for n in names)

    checked: list[int] = []
    real = workspace_pickles._check
    monkeypatch.setattr(workspace_pickles, "_check", lambda data: checked.append(len(data)) or real(data))
    r = client.post("/api/v1/projects/restore", json={"path": str(path), "project_name": "round-trip"},
                    headers=token)
    assert r.status_code == 200, r.text
    assert len(checked) > 10

    active = bd.projects.current
    bd.projects.set_current("round-trip")
    try:
        exc = next(iter(bd.Database("fg").get("bottle").technosphere()))
        assert exc["amount"] == 2.0 and exc.get("formula") == "kwh * 1"
        assert exc.get("uncertainty type") == 2
        elec = bd.Database("fg").get("elec")
        assert elec["classifications"] == [("CPC", "17100: Electrical energy")]
        assert next(iter(elec.biosphere()))["pedigree"] == {"reliability": 2}
        assert bd.calculation_setups["setup"]["ia"] == [("test", "gwp")]
        assert ("test", "gwp") in bd.methods
    finally:
        bd.projects.set_current(active)
    client.post("/api/v1/projects/round-trip/activate", headers=token)
    assert abs(client.post("/api/v1/calc/lcia", json=calc, headers=token).json()["score"] - score) < 1e-9
    assert [s["name"] for s in client.get("/api/v1/scenarios", params={"database": "fg"},
                                          headers=token).json()] == ["efficient"]
