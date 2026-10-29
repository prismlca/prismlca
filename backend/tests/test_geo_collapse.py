from __future__ import annotations

import uuid

from prism_lca.engine.bootstrap import get_bd


def _seed(bd, db: str) -> None:
    def act(code, nm, prod, loc):
        return {
            "name": nm, "reference product": prod, "location": loc, "unit": "kg",
            "exchanges": [{"input": (db, code), "amount": 1.0, "type": "production"}],
        }

    bd.Database(db).write(
        {
            (db, "cem_de"): act("cem_de", "cement production", "cement", "DE"),
            (db, "cem_fr"): act("cem_fr", "cement production", "cement", "FR"),
            (db, "cem_glo"): act("cem_glo", "cement production", "cement", "GLO"),
            (db, "steel"): act("steel", "steel production", "steel", "GLO"),
        }
    )


def test_geo_variants_collapse_into_one_result(client, token, project):
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    r = client.post(
        "/api/v1/search/activities",
        json={"query": "cement production", "database": db, "collapse_geo": True, "limit": 10},
        headers=token,
    )
    assert r.status_code == 200, r.text
    hits = r.json()["hits"]
    cement = [h for h in hits if h["name"] == "cement production"]
    # the three geo-variants collapse into exactly ONE result...
    assert len(cement) == 1
    # ...that carries all three geographies to choose from
    geos = {v["geography"] for v in cement[0]["variants"]}
    assert geos == {"DE", "FR", "GLO"}


def test_no_collapse_keeps_each_variant(client, token, project):
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    r = client.post(
        "/api/v1/search/activities",
        json={"query": "cement production", "database": db, "collapse_geo": False, "limit": 10},
        headers=token,
    )
    cement = [h for h in r.json()["hits"] if h["name"] == "cement production"]
    assert len(cement) == 3  # DE, FR, GLO each as its own row
