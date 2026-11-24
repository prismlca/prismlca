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


# A scanned vocabulary is "empty" without properties and CPC classes, and an empty one is rescanned.
_PROPS = {"dry mass": "kilogram"}


def test_unit_vocabulary_endpoint(client, token, project, monkeypatch):
    units = ["cubic meter", "kilogram", "unit"]
    monkeypatch.setattr(M, "_VOCAB", {"properties": _PROPS, "units": units, "cpc": {}})
    r = client.get("/api/v1/model/unit-vocabulary", headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["units"] == ["cubic meter", "kilogram", "unit"]


def test_unit_vocabulary_offers_unit_when_no_background_dataset_uses_it(client, token, project, monkeypatch):
    # A background without a dataset counted in pieces (a BAFU-only workspace): the New process dialog
    # prefills "unit", and a strict unit field rejects whatever its list lacks.
    scanned = ["kilogram", "megajoule", "ton kilometer"]
    monkeypatch.setattr(M, "_VOCAB", {"properties": _PROPS, "units": list(scanned), "cpc": {}})
    r = client.get("/api/v1/model/unit-vocabulary", headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["units"] == ["kilogram", "megajoule", "ton kilometer", "unit"]
    assert M._VOCAB["units"] == scanned  # the cached scan stays as scanned


def test_flows_endpoint_returns_list(client, token, project):
    # No biosphere in the test project → an empty (but well-formed) list.
    r = client.get("/api/v1/model/flows", params={"direction": "output", "query": "carbon"}, headers=token)
    assert r.status_code == 200, r.text
    assert isinstance(r.json()["flows"], list)


def test_add_product_flow_creates_and_links(client, token, project, monkeypatch):
    # Emulate the "new product flow" path: create a foreground product, link it as a technosphere input.
    db = _fg(client, token)
    host = _create(client, token, db, "Host")
    product = _create(client, token, db, "MyMaterial")
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": host, "input_database": db,
              "input_code": product, "amount": 3.0, "type": "technosphere"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    det = client.get(f"/api/v1/model/activities/{db}/{host}", headers=token).json()
    tech = [e for e in det["exchanges"] if e["type"] == "technosphere"]
    assert any(e["input"]["name"] == "MyMaterial" and e["amount"] == 3.0 for e in tech)
