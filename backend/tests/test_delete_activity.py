from __future__ import annotations

import uuid


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post("/api/v1/model/activities",
                       json={"database": db, "name": name, "unit": "kg"},
                       headers=token).json()["activity"]["code"]


def test_delete_consumed_activity_blocked_then_forced(client, token, project):
    """Deleting a CONSUMED activity is blocked (bw2data would silently cascade into the
    consumers' inputs); force deletes anyway and undo restores the consumer links (P07/P08)."""
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    client.post("/api/v1/model/exchanges",
                json={"activity_database": db, "activity_code": b, "input_database": db,
                      "input_code": a, "amount": 3.0}, headers=token)

    # deleting A (consumed by B) without force → 409 delete_blocked
    r = client.post("/api/v1/model/activities/delete", json={"database": db, "code": a}, headers=token)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "delete_blocked"
    # nothing changed
    det = client.get(f"/api/v1/model/activities/{db}/{b}", headers=token).json()
    assert len([e for e in det["exchanges"] if e["type"] == "technosphere"]) == 1

    # force deletes A AND B's input edge (bw2data cascade)
    r = client.post("/api/v1/model/activities/delete",
                    json={"database": db, "code": a, "force": True}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["cascaded_inputs"] == 1
    det = client.get(f"/api/v1/model/activities/{db}/{b}", headers=token).json()
    assert [e for e in det["exchanges"] if e["type"] == "technosphere"] == []

    # undo restores A INCLUDING B's consumer edge (previously lost forever)
    client.post("/api/v1/model/undo", headers=token)
    det = client.get(f"/api/v1/model/activities/{db}/{b}", headers=token).json()
    tech = [e for e in det["exchanges"] if e["type"] == "technosphere"]
    assert len(tech) == 1
    assert tech[0]["input"]["code"] == a
    assert tech[0]["amount"] == 3.0


def test_delete_activity_and_undo(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    # B consumes A (so the deleted activity has an exchange to restore)
    client.post("/api/v1/model/exchanges",
                json={"activity_database": db, "activity_code": b, "input_database": db,
                      "input_code": a, "amount": 3.0}, headers=token)

    assert len(client.get(f"/api/v1/model/activities/{db}", headers=token).json()) == 2

    r = client.post("/api/v1/model/activities/delete",
                    json={"database": db, "code": b}, headers=token)
    assert r.status_code == 200, r.text
    codes = {x["code"] for x in client.get(f"/api/v1/model/activities/{db}", headers=token).json()}
    assert b not in codes and a in codes

    # undo restores B with its exchange to A
    client.post("/api/v1/model/undo", headers=token)
    det = client.get(f"/api/v1/model/activities/{db}/{b}", headers=token).json()
    assert det["activity"]["name"] == "B"
    tech = [e for e in det["exchanges"] if e["type"] == "technosphere"]
    assert len(tech) == 1
    assert tech[0]["input"]["code"] == a
    assert tech[0]["amount"] == 3.0


def test_a_model_still_supplying_the_library_is_not_deleted(client, token, project):
    """A process moved to My processes keeps its input from the model it came
    from; deleting that model left the library dataset with an input into nothing. The delete is now
    refused with the consumer named — and goes through once nothing outside draws on the model."""
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.library import LIBRARY_DB

    assert client.post("/api/v1/databases/foreground", json={"name": "Source"}, headers=token).status_code == 200

    def create(name: str) -> str:
        r = client.post("/api/v1/model/activities", json={"database": "Source", "name": name, "unit": "kg"}, headers=token)
        assert r.status_code == 200, r.text
        return r.json()["activity"]["code"]

    supplier, candidate = create("Supplier"), create("Library candidate")
    r = client.post("/api/v1/model/exchanges", json={
        "activity_database": "Source", "activity_code": candidate,
        "input_database": "Source", "input_code": supplier, "amount": 7,
    }, headers=token)
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/model/activities/to-library", json={"database": "Source", "code": candidate}, headers=token)
    assert r.status_code == 200, r.text

    r = client.post("/api/v1/databases/foreground/delete", json={"database": "Source"}, headers=token)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "model_in_use"
    assert "Library candidate" in r.json()["error"]["message"]
    assert "Source" in get_bd().databases
    # The library dataset still has its input, intact.
    lib = get_bd().Database(LIBRARY_DB)
    moved = next(a for a in lib if a["name"] == "Library candidate")
    assert [e.input.key for e in moved.technosphere()] == [("Source", supplier)]

    # A model nobody outside draws on deletes as before.
    assert client.post("/api/v1/databases/foreground", json={"name": "Alone"}, headers=token).status_code == 200
    r = client.post("/api/v1/databases/foreground/delete", json={"database": "Alone"}, headers=token)
    assert r.status_code == 200, r.text


def test_delete_blocked_names_every_consumer_with_its_model(client, token, project):
    """The refusal carries the consumers as data — once each, by name and model — so the canvas can word
    its confirm dialog without codes and without missing a consumer in another model, which the forced
    cascade reaches too. The message and hint, which the assistant reads, stay as they were."""
    db = _fg(client, token)
    other = _fg(client, token)
    a = _create(client, token, db, "Steel sheet")
    b = _create(client, token, db, "Bottle")
    c = _create(client, token, other, "Can")
    for consumer_db, consumer in ((db, b), (db, b), (other, c)):  # B takes A twice: still one consumer
        client.post("/api/v1/model/exchanges",
                    json={"activity_database": consumer_db, "activity_code": consumer, "input_database": db,
                          "input_code": a, "amount": 1.0}, headers=token)

    r = client.post("/api/v1/model/activities/delete", json={"database": db, "code": a}, headers=token)
    assert r.status_code == 409, r.text
    error = r.json()["error"]
    assert sorted(error["details"]["consumers"], key=lambda x: x["name"]) == [
        {"database": db, "code": b, "name": "Bottle"},
        {"database": other, "code": c, "name": "Can"},
    ]
    assert error["message"].startswith(f"'{a}' is consumed by 3 exchange(s)")
    assert "pass force=true" in error["hint"]


def test_other_errors_carry_no_details(client, token, project):
    db = _fg(client, token)
    r = client.post("/api/v1/model/activities/delete", json={"database": db, "code": "nope"}, headers=token)
    assert r.status_code >= 400
    assert "details" not in r.json()["error"]
