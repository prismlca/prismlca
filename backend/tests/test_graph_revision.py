"""The canvas graph's ``revision``: it follows every exchange of the model, including the ones the canvas
does not draw, so the Workbench can tell a calculation that still describes the model from an outdated one.
"""
import uuid


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    assert r.status_code == 200, r.text
    return db


def _create(client, token, db, name) -> str:
    r = client.post("/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


def _revision(client, token, db) -> str:
    g = client.get(f"/api/v1/model/graph/{db}", headers=token).json()
    return g["revision"]


def test_revision_follows_exchanges_the_canvas_does_not_draw(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    first = _revision(client, token, db)
    assert first == _revision(client, token, db)  # stable while nothing changes

    # An exchange that is not technosphere: no arrow on the canvas, but a calculation reads it.
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b,
              "amount": 3.0, "type": "substitution"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    g = client.get(f"/api/v1/model/graph/{db}", headers=token).json()
    assert g["edges"] == [] and g["bg_edges"] == []
    second = g["revision"]
    assert second != first

    uid = r.json()["exchange"]["uid"]
    r = client.post(
        "/api/v1/model/exchanges/amount",
        json={"activity_database": db, "activity_code": a, "uid": uid, "amount": 4.0},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert _revision(client, token, db) not in (first, second)

    # Undone, the model is the one it was — and so is its revision.
    client.post("/api/v1/model/undo", json={"database": db}, headers=token)
    assert _revision(client, token, db) == second
