from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd

METHOD = ["test", "gwp"]


def _seed(bd) -> None:
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    fg = bd.Database("fg")
    fg.write(
        {
            ("fg", "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle",
                "exchanges": [
                    {"input": ("fg", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 1.0, "type": "biosphere"},
                ],
            }
        }
    )
    for e in fg.get("bottle").biosphere():
        e["prism_uid"] = "u"
        e.save()
    bd.databases["fg"]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _set_lognormal(client, token):
    return client.post(
        "/api/v1/model/exchanges/uncertainty",
        json={"activity_database": "fg", "activity_code": "bottle", "uid": "u",
              "distribution": "lognormal", "params": {"median": 1.0, "gsd": 1.5}},
        headers=token,
    )


def _mc(client, token, iterations):
    return client.post(
        "/api/v1/calc/montecarlo",
        json={"database": "fg", "code": "bottle", "method": METHOD, "iterations": iterations},
        headers=token,
    ).json()


def test_montecarlo_with_uncertainty(client, token, project):
    _seed(get_bd())
    r = client.post("/api/v1/calc/lcia", json={"database": "fg", "code": "bottle", "method": METHOD}, headers=token)
    assert abs(r.json()["score"] - 1.0) < 1e-9  # deterministic baseline

    assert _set_lognormal(client, token).status_code == 200
    d = _mc(client, token, 300)
    assert d["iterations"] == 300
    assert d["std"] > 0
    assert 0.6 < d["mean"] < 1.6
    assert d["p5"] < d["p50"] < d["p95"]


def test_montecarlo_deterministic_without_uncertainty(client, token, project):
    _seed(get_bd())
    d = _mc(client, token, 50)
    assert d["std"] == 0.0
    assert abs(d["mean"] - 1.0) < 1e-9


def test_uncertainty_undo(client, token, project):
    _seed(get_bd())
    assert _set_lognormal(client, token).status_code == 200
    assert _mc(client, token, 100)["std"] > 0
    client.post("/api/v1/model/undo", headers=token)
    assert _mc(client, token, 50)["std"] == 0.0
