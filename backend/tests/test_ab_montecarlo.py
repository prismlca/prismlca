from __future__ import annotations

import math

import stats_arrays as sa

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
                    {"input": ("bio", "co2"), "amount": 0.5, "type": "biosphere",
                     "uncertainty type": sa.LognormalUncertainty.id, "loc": math.log(0.5), "scale": 0.3},
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
        }
    )
    for e in fg.get("bottle").technosphere():
        e["prism_uid"] = "e"
        e.save()
    bd.databases["fg"]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("t", "gwp")).write([(("bio", "co2"), 1.0)])


def test_ab_paired_montecarlo(client, token, project):
    _seed(get_bd())
    # bottle uses `kwh` kWh of (uncertain) electricity
    client.post("/api/v1/params", json={"database": "fg", "name": "kwh", "amount": 2.0}, headers=token)
    client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": "fg", "activity_code": "bottle", "uid": "e", "formula": "kwh"},
        headers=token,
    )
    sid = client.post(
        "/api/v1/scenarios", json={"database": "fg", "name": "eff", "overrides": {"kwh": 1.0}}, headers=token
    ).json()["scenario"]["id"]

    r = client.post(
        "/api/v1/calc/montecarlo/compare",
        json={
            "a": {"database": "fg", "code": "bottle", "label": "base (2 kWh)"},
            "b": {"database": "fg", "code": "bottle", "scenario": sid, "label": "eff (1 kWh)"},
            "method": METHOD,
            "iterations": 200,
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    # B uses less of the same (correlated) electricity -> B is lower in every paired run
    assert d["mean_a"] > d["mean_b"]
    assert d["mean_diff"] > 0
    assert d["p_b_lt_a"] == 1.0
    # A deterministic pair of scores passes the three lines above; only the spread proves that the
    # uncertain electricity was sampled at all, and the count that every iteration ran.
    assert d["iterations"] == 200
    assert d["std_diff"] > 0
