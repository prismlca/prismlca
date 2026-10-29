from __future__ import annotations

import uuid

from prism_lca.engine import model as M


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def test_view_empty_properties(client, token, project):
    db = _fg(client, token)
    code = _create(client, token, db, "A")
    r = client.get(f"/api/v1/model/activities/{db}/{code}/properties", headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["read_only"] is False
    assert body["properties"] == {}


def test_set_properties_consistency_and_undo(client, token, project, monkeypatch):
    # No ecoinvent in tests → seed the vocabulary directly.
    monkeypatch.setattr(M, "_VOCAB", {"properties": {"dry mass": "kg", "price": "EUR2005"}, "units": ["kg", "EUR2005"]})
    db = _fg(client, token)
    code = _create(client, token, db, "A")

    # A known property with the right unit is accepted.
    ok = client.post(
        "/api/v1/model/properties",
        json={"database": db, "code": code, "properties": {"dry mass": {"amount": 2.5, "unit": "kg"}}},
        headers=token,
    )
    assert ok.status_code == 200, ok.text
    got = client.get(f"/api/v1/model/activities/{db}/{code}/properties", headers=token).json()
    assert got["properties"]["dry mass"]["amount"] == 2.5

    # Wrong unit for a known property is rejected.
    bad_unit = client.post(
        "/api/v1/model/properties",
        json={"database": db, "code": code, "properties": {"dry mass": {"amount": 1, "unit": "g"}}},
        headers=token,
    )
    assert bad_unit.status_code >= 400

    # An unknown property is rejected.
    unknown = client.post(
        "/api/v1/model/properties",
        json={"database": db, "code": code, "properties": {"made up": {"amount": 1, "unit": "kg"}}},
        headers=token,
    )
    assert unknown.status_code >= 400

    # Undo reverts to the previous (empty) properties.
    client.post("/api/v1/model/undo", headers=token)
    reverted = client.get(f"/api/v1/model/activities/{db}/{code}/properties", headers=token).json()
    assert reverted["properties"] == {}


def test_properties_read_only_background(client, token, project, monkeypatch):
    # A read-only database cannot be edited even with a valid vocabulary entry.
    monkeypatch.setattr(M, "_VOCAB", {"properties": {"dry mass": "kg"}, "units": ["kg"]})
    from prism_lca.engine.guardrails import set_read_only

    db = _fg(client, token)
    code = _create(client, token, db, "A")
    set_read_only(db, True)
    r = client.post(
        "/api/v1/model/properties",
        json={"database": db, "code": code, "properties": {"dry mass": {"amount": 1, "unit": "kg"}}},
        headers=token,
    )
    assert r.status_code >= 400


def _link(client, token, db, code, input_code, amount=2.0) -> None:
    r = client.post(
        "/api/v1/model/exchanges",
        json={
            "activity_database": db,
            "activity_code": code,
            "input_database": db,
            "input_code": input_code,
            "amount": amount,
        },
        headers=token,
    )
    assert r.status_code == 200, r.text


def test_input_properties(client, token, project):
    """``?input=`` reads the properties stored on one of the activity's INPUT exchanges — what ecoinvent
    carries on every technosphere exchange, and what only the production one exposed before."""
    db = _fg(client, token)
    boiler = _create(client, token, db, "Boiler")
    gas = _create(client, token, db, "Natural gas")
    _link(client, token, db, boiler, gas)
    # Seed the exchange's properties the way an ecospold import leaves them.
    act = M.get_activity(db, boiler)
    ex = next(e for e in act.technosphere())
    ex["properties"] = {"heating value, net": {"amount": 36.0, "unit": "MJ"}}
    ex.save()

    r = client.get(f"/api/v1/model/activities/{db}/{boiler}/properties", params={"input": "natural gas"}, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["input"]["name"] == "Natural gas" and body["input"]["code"] == gas
    assert body["amount"] == 2.0
    assert body["properties"]["heating value, net"]["amount"] == 36.0
    # A substring works when it is unambiguous; the code works too.
    assert client.get(f"/api/v1/model/activities/{db}/{boiler}/properties", params={"input": "gas"}, headers=token).status_code == 200
    assert client.get(f"/api/v1/model/activities/{db}/{boiler}/properties", params={"input": gas}, headers=token).status_code == 200
    # Nothing matches: the answer names the inputs that exist.
    miss = client.get(f"/api/v1/model/activities/{db}/{boiler}/properties", params={"input": "coal"}, headers=token)
    assert miss.status_code == 404, miss.text
    assert "Natural gas" in miss.text
    # Without ``input`` the reference product is read, as before.
    plain = client.get(f"/api/v1/model/activities/{db}/{boiler}/properties", headers=token).json()
    assert "input" not in plain and plain["properties"] == {}


def test_activity_detail_review_fields(client, token, project):
    """``?detail=review`` adds production volume and the uncertainty distribution per exchange and the
    dataset's documentation fields; the plain read is unchanged."""
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    _link(client, token, db, a, b, 1.5)
    act = M.get_activity(db, a)
    act["included_activities_start"] = "From the gate of the supplier."
    act["synonyms"] = ["alpha"]
    act["authors"] = {"data entry": {"name": "Someone", "email": "x@example.org"}}
    act.save()
    ex = next(e for e in act.technosphere())
    ex["production volume"] = 5000.0
    ex["uncertainty type"] = 2
    ex["loc"] = 0.405
    ex["scale"] = 0.2
    ex.save()

    plain = client.get(f"/api/v1/model/activities/{db}/{a}", headers=token).json()
    tech = next(e for e in plain["exchanges"] if e["type"] == "technosphere")
    assert "production_volume" not in tech and "review" not in plain["activity"]

    r = client.get(f"/api/v1/model/activities/{db}/{a}", params={"detail": "review"}, headers=token)
    assert r.status_code == 200, r.text
    d = r.json()
    tech = next(e for e in d["exchanges"] if e["type"] == "technosphere")
    assert tech["production_volume"] == 5000.0
    assert tech["uncertainty"] == {"type": "lognormal", "loc": 0.405, "scale": 0.2}
    review = d["activity"]["review"]
    assert review["included_activities_start"] == "From the gate of the supplier."
    assert review["synonyms"] == ["alpha"]
    # Personal data never travels, whichever detail level is asked for.
    assert "authors" not in review and "example.org" not in r.text


def test_properties_of_an_input_fall_back_to_the_input_dataset(client, token, project):
    """A foreground link carries no properties; the dataset behind it does (on its reference
    product). Asked through `input`, the answer used to be `{}` while the direct lookup had a full
    table."""
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    bg = "bg-" + uuid.uuid4().hex[:6]
    bd.Database(bg).write({
        (bg, "steel"): {
            "name": "market for steel", "unit": "kg", "reference product": "steel", "location": "GLO",
            "exchanges": [{
                "input": (bg, "steel"), "amount": 1, "type": "production",
                "properties": {"dry mass": {"amount": 1.0, "unit": "kg"}, "price": {"amount": 2.5, "unit": "EUR2005"}},
            }],
        },
    })
    db = _fg(client, token)
    code = _create(client, token, db, "Body")
    assert client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": code, "input_database": bg, "input_code": "steel", "amount": 0.25},
        headers=token,
    ).status_code == 200
    r = client.get(f"/api/v1/model/activities/{db}/{code}/properties", params={"input": "steel"}, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["input"]["code"] == "steel"
    assert body["properties"]["dry mass"]["amount"] == 1.0
    assert body["properties_from"] == "input's reference product"
