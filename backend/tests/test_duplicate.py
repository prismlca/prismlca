from __future__ import annotations

import uuid


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def test_duplicate_activity(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "Widget")
    b = _create(client, token, db, "Part")
    # a consumes b
    client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b, "amount": 3.0},
        headers=token,
    )
    r = client.post("/api/v1/model/activities/duplicate", json={"database": db, "code": a}, headers=token)
    assert r.status_code == 200, r.text
    dup = r.json()["activity"]
    assert dup["name"] == "Widget (copy)"
    assert dup["code"] != a
    # duplicate keeps the input to b
    det = client.get(f"/api/v1/model/activities/{db}/{dup['code']}", headers=token).json()
    inputs = [e for e in det["exchanges"] if e["type"] == "technosphere"]
    assert len(inputs) == 1 and inputs[0]["input"]["code"] == b
    # undo removes the copy
    client.post("/api/v1/model/undo", headers=token)
    assert client.get(f"/api/v1/model/activities/{db}/{dup['code']}", headers=token).status_code >= 400


def test_duplicate_model_remaps_internal_links(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b, "amount": 2.0},
        headers=token,
    )
    new = "copy-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/databases/foreground/duplicate", json={"source": db, "name": new}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["node_count"] == 2 and r.json()["read_only"] is False

    acts = client.get(f"/api/v1/model/activities/{new}", headers=token).json()
    names = {x["name"] for x in acts}
    assert names == {"A", "B"}
    new_a = next(x for x in acts if x["name"] == "A")["code"]
    new_b = next(x for x in acts if x["name"] == "B")["code"]
    det = client.get(f"/api/v1/model/activities/{new}/{new_a}", headers=token).json()
    tech = [e for e in det["exchanges"] if e["type"] == "technosphere"]
    # the internal A→B link must point at the COPY of B in the new db, not the original
    assert len(tech) == 1
    assert tech[0]["input"]["database"] == new
    assert tech[0]["input"]["code"] == new_b


def test_duplicate_model_copies_fields_tags_and_study(client, token, project):
    """A model duplicate is a FULL copy: activity comment/ISO doc, tags, and the
    study metadata (goal & scope) must survive, not just names and exchanges."""
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    client.post(
        "/api/v1/model/activities/fields",
        json={"database": db, "code": a, "comment": "hand-collected data",
              "doc": {"data_source": "plant survey 2025"}},
        headers=token,
    )
    client.post(
        "/api/v1/model/tags",
        json={"database": db, "code": a, "dimension": "Phase", "value": "Production"},
        headers=token,
    )
    client.post("/api/v1/study", json={"database": db, "goal": "test goal"}, headers=token)

    new = "copy-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/databases/foreground/duplicate", json={"source": db, "name": new}, headers=token)
    assert r.status_code == 200, r.text

    from prism_lca.engine.bootstrap import get_bd

    new_a = client.get(f"/api/v1/model/activities/{new}", headers=token).json()[0]["code"]
    meta = client.get(f"/api/v1/model/activities/{new}/{new_a}/metadata", headers=token).json()
    assert meta["comment"] == "hand-collected data"
    copy = get_bd().get_node(database=new, code=new_a)
    assert (copy.get("prism_doc") or {}).get("data_source") == "plant survey 2025"
    tags = client.get(f"/api/v1/model/tags/{new}/{new_a}", headers=token).json()
    assert {"dimension": "Phase", "value": "Production"} in tags
    study = client.get(f"/api/v1/study?database={new}", headers=token).json()
    assert study.get("goal") == "test goal"


def test_duplicate_keeps_formula_and_uncertainty(client, token, project):
    """Copies must carry the FULL exchange — formula and uncertainty distribution included
    (P11: they were silently dropped before, changing Monte-Carlo results on copies)."""
    from prism_lca.engine.bootstrap import get_bd

    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    uid = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db,
              "input_code": b, "amount": 2.0},
        headers=token,
    ).json()["exchange"]["uid"]
    r = client.post(
        "/api/v1/model/exchanges/uncertainty",
        json={"activity_database": db, "activity_code": a, "uid": uid,
              "distribution": "lognormal", "params": {"median": 2.0, "gsd": 1.2}},
        headers=token,
    )
    assert r.status_code == 200, r.text

    dup = client.post(
        "/api/v1/model/activities/duplicate", json={"database": db, "code": a}, headers=token
    ).json()["activity"]
    copy_code = dup["code"]

    bd = get_bd()
    copy = bd.get_node(database=db, code=copy_code)
    tech = [e for e in copy.exchanges() if e.get("type") == "technosphere"]
    assert len(tech) == 1
    assert tech[0].get("uncertainty type") is not None  # distribution survived the copy
    # undo of a remove also restores the distribution
    ex_uid = tech[0].get("prism_uid")
    client.post(
        "/api/v1/model/exchanges/remove",
        json={"activity_database": db, "activity_code": copy_code, "uid": ex_uid},
        headers=token,
    )
    client.post("/api/v1/model/undo", headers=token)
    copy = bd.get_node(database=db, code=copy_code)
    tech = [e for e in copy.exchanges() if e.get("type") == "technosphere"]
    assert len(tech) == 1 and tech[0].get("uncertainty type") is not None
