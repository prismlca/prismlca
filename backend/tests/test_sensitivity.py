from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd

METHOD = ["t", "gwp"]


def _seed(bd) -> None:
    bd.Database("bio").write(
        {("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    fg = bd.Database("fg")
    fg.write(
        {
            ("fg", "elec"): {
                "name": "electricity", "unit": "kWh",
                "exchanges": [
                    {"input": ("fg", "elec"), "amount": 1, "type": "production"},
                    {"input": ("bio", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            ("fg", "bottle"): {
                "name": "bottle", "unit": "unit",
                "exchanges": [
                    {"input": ("fg", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("fg", "elec"), "amount": 0.0, "type": "technosphere"},
                    {"input": ("bio", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
            ("fg", "alt"): {
                "name": "alt bottle", "unit": "unit",
                "exchanges": [
                    {"input": ("fg", "alt"), "amount": 1, "type": "production"},
                    {"input": ("bio", "co2"), "amount": 0.6, "type": "biosphere"},
                ],
            },
        }
    )
    for e in fg.get("bottle").technosphere():
        e["prism_uid"] = "e"
        e.save()
    bd.databases["fg"]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("t", "gwp")).write([(("bio", "co2"), 1.0)])


def _setup_param(client, token):
    # bottle exchange amount = kwh; bottle score = 0.1 + kwh * 0.5
    client.post("/api/v1/params", json={"database": "fg", "name": "kwh", "amount": 2.0}, headers=token)
    client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": "fg", "activity_code": "bottle", "uid": "e", "formula": "kwh"},
        headers=token,
    )


def test_tornado(client, token, project):
    _seed(get_bd())
    _setup_param(client, token)
    r = client.post(
        "/api/v1/calc/sensitivity/tornado",
        json={"database": "fg", "code": "bottle", "method": METHOD, "delta": 0.5},
        headers=token,
    )
    assert r.status_code == 200, r.text
    e = next(x for x in r.json()["entries"] if x["param"] == "kwh")
    assert abs(e["low"] - 0.6) < 1e-6  # kwh=1 -> 0.1 + 0.5
    assert abs(e["high"] - 1.6) < 1e-6  # kwh=3 -> 0.1 + 1.5


def test_sweep(client, token, project):
    _seed(get_bd())
    _setup_param(client, token)
    r = client.post(
        "/api/v1/calc/sensitivity/sweep",
        json={"database": "fg", "code": "bottle", "method": METHOD, "param": "kwh", "values": [1, 2, 3]},
        headers=token,
    )
    scores = {p["value"]: p["score"] for p in r.json()["points"]}
    assert abs(scores[1.0] - 0.6) < 1e-6
    assert abs(scores[2.0] - 1.1) < 1e-6
    assert abs(scores[3.0] - 1.6) < 1e-6


def test_breakeven(client, token, project):
    _seed(get_bd())
    _setup_param(client, token)
    r = client.post(
        "/api/v1/calc/sensitivity/breakeven",
        json={"database": "fg", "code_a": "bottle", "code_b": "alt", "method": METHOD,
              "param": "kwh", "lo": 0.0, "hi": 5.0},
        headers=token,
    )
    d = r.json()
    assert d["found"] is True
    assert abs(d["value"] - 1.0) < 1e-3  # bottle(0.1+0.5k) == alt(0.6) -> k=1
