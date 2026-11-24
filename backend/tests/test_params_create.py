"""Creating a parameter never overwrites one: the add form's write (`create: true`) against a taken name.

`POST /api/v1/params` is an upsert — the right shape for an edit, the wrong one for the add form, where a
name that exists is a parameter the author did not know about. With `create` the route refuses it and
leaves value, rule and history as they were; without it the write still upserts.
"""
from __future__ import annotations

import uuid


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _param(client, token, db, name, **body):
    return client.post("/api/v1/params", json={"database": db, "name": name, **body}, headers=token)


def _get(client, token, db, name) -> dict:
    rows = client.get("/api/v1/params", params={"database": db}, headers=token).json()
    return next(p for p in rows if p["name"] == name)


def _audit(client, token, db) -> list[str]:
    """The model's log summaries, oldest first."""
    rows = client.get("/api/v1/model/audit", params={"database": db, "limit": 50}, headers=token).json()
    return [r["summary"] for r in rows]


def test_creating_a_taken_name_is_refused_and_changes_nothing(client, token):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0, unit="kg", rule={"kind": "positive"}).status_code == 200
    before = _audit(client, token, db)

    r = _param(client, token, db, "mass", amount=7.0, rule={}, create=True)

    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "param_exists"
    assert "'mass' already exists" in err["message"]
    p = _get(client, token, db, "mass")
    assert p["amount"] == 2.0
    assert p["unit"] == "kg"
    assert p["rule"] == {"kind": "positive"}
    # Nothing written, so nothing to undo and no line in the log.
    assert _audit(client, token, db) == before


def test_the_taken_check_reads_the_name_as_it_is_stored(client, token):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200

    r = _param(client, token, db, "  mass ", amount=7.0, create=True)

    assert r.status_code == 409, r.text
    assert _get(client, token, db, "mass")["amount"] == 2.0


def test_creating_a_free_name_still_creates_it(client, token):
    db = _fg(client, token)

    r = _param(client, token, db, "mass", amount=2.0, unit="kg", create=True)

    assert r.status_code == 200, r.text
    assert _get(client, token, db, "mass")["amount"] == 2.0
    assert _audit(client, token, db)[-1] == "Set parameter 'mass' = 2 kg (new)"


def test_without_create_the_write_still_updates(client, token):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200

    assert _param(client, token, db, "mass", amount=7.0).status_code == 200

    assert _get(client, token, db, "mass")["amount"] == 7.0


def test_a_padded_name_overwriting_a_parameter_is_undone_to_its_old_value(client, token):
    # The command used to snapshot " mass" — nothing — so the write counted as new, replaced "mass",
    # and its undo looked for " mass", found nothing and kept 7.
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    assert _param(client, token, db, " mass", amount=7.0).status_code == 200
    assert _audit(client, token, db)[-1] == "Set parameter 'mass' = 7 (was 2)"

    assert client.post("/api/v1/model/undo", headers=token).status_code == 200

    assert _get(client, token, db, "mass")["amount"] == 2.0
