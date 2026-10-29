from __future__ import annotations

import uuid

from prism_lca.engine.bootstrap import get_bd


def _seed(bd) -> None:
    """bottle -> 2 kWh elec; elec emits 0.5 kg CO2, bottle 0.1 kg. GWP total = 1.1."""
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission",
                                "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("bg").write(
        {
            ("bg", "elec"): {
                "name": "electricity", "unit": "kWh", "reference product": "electricity",
                "location": "DE",
                "exchanges": [
                    {"input": ("bg", "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            ("bg", "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle",
                "location": "GLO",
                "exchanges": [
                    {"input": ("bg", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("bg", "elec"), "amount": 2, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def test_expand_tier1_with_impact(client, token, project):
    _seed(get_bd())
    r = client.post(
        "/api/v1/model/expand",
        json={"database": "bg", "code": "bottle", "method": ["test", "gwp"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["count"] == 1
    elec = d["inputs"][0]
    assert elec["code"] == "elec"
    assert abs(elec["impact"] - 1.0) < 1e-6      # 2 kWh * 0.5 kg CO2
    assert abs(elec["share"] - (1.0 / 1.1)) < 1e-4


def _lcia(client, token, db, code):
    return client.post(
        "/api/v1/calc/lcia",
        json={"database": db, "code": code, "method": ["test", "gwp"]},
        headers=token,
    ).json()["score"]


def test_localize_path_copies_and_preserves_result(client, token, project):
    _seed(get_bd())
    fg = _fg(client, token)

    r = client.post(
        "/api/v1/model/localize",
        json={"target_database": fg, "path": [["bg", "bottle"], ["bg", "elec"]]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["count"] == 2                                  # N copies = path length
    bottle_copy = next(c for c in res["copies"] if c["from"] == ["bg", "bottle"])
    elec_copy = next(c for c in res["copies"] if c["from"] == ["bg", "elec"])

    # the localized bottle now links to the localized elec (foreground), not bg/elec
    detail = client.get(f"/api/v1/model/activities/{fg}/{bottle_copy['code']}", headers=token).json()
    tech = [e for e in detail["exchanges"] if e["type"] == "technosphere"]
    assert len(tech) == 1
    assert tech[0]["input"]["database"] == fg
    assert tech[0]["input"]["code"] == elec_copy["code"]

    # result is unchanged by localizing (identical copies of the background)
    assert abs(_lcia(client, token, fg, bottle_copy["code"]) - 1.1) < 1e-6

    # undo removes all copies
    client.post("/api/v1/model/undo", headers=token)
    assert client.get(f"/api/v1/model/activities/{fg}", headers=token).json() == []
