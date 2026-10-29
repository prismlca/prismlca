from __future__ import annotations

import io
import json
import uuid
import zipfile


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post("/api/v1/model/activities",
                       json={"database": db, "name": name, "unit": "kg"},
                       headers=token).json()["activity"]["code"]


def test_delete_preview_lists_dependents(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    # B consumes A
    client.post("/api/v1/model/exchanges",
                json={"activity_database": db, "activity_code": b, "input_database": db,
                      "input_code": a, "amount": 1.0}, headers=token)

    prev = client.get(f"/api/v1/model/delete-preview/{db}/{a}", headers=token).json()
    assert prev["blocked"] is True
    assert prev["dependent_count"] == 1
    assert prev["dependents"][0]["code"] == b

    # B has no dependents
    prev_b = client.get(f"/api/v1/model/delete-preview/{db}/{b}", headers=token).json()
    assert prev_b["blocked"] is False
    assert prev_b["dependent_count"] == 0


def test_support_bundle_contents(client, token, project):
    db = _fg(client, token)
    _create(client, token, db, "A")

    r = client.get("/api/v1/system/support-bundle", headers=token)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        names = set(z.namelist())
        assert {"info.json", "health.json", "audit.json"} <= names
        info = json.loads(z.read("info.json"))
        assert "bw2data" in info["engine"]
        health = json.loads(z.read("health.json"))
        assert db in health  # foreground db health is included


def test_project_backup_creates_file(client, token, project, tmp_path):
    r = client.post("/api/v1/projects/backup", json={"dir_backup": str(tmp_path)}, headers=token)
    assert r.status_code == 200, r.text
    from pathlib import Path

    path = Path(r.json()["path"])
    assert path.exists()
    assert path.suffix in (".gz", ".tar")
