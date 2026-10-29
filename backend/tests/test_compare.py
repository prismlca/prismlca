from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd

METHOD = ["t", "gwp"]


def _seed(bd) -> None:
    bd.Database("bio").write(
        {("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("fg").write(
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
                    {"input": ("fg", "elec"), "amount": 2, "type": "technosphere"},
                    {"input": ("bio", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("t", "gwp")).write([(("bio", "co2"), 1.0)])


def test_compare_subjects(client, token, project):
    _seed(get_bd())
    r = client.post(
        "/api/v1/calc/compare",
        json={
            "subjects": [
                {"database": "fg", "code": "bottle", "label": "Bottle"},
                {"database": "fg", "code": "elec", "label": "1 kWh"},
            ],
            "methods": [METHOD],
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    key = d["methods"][0]["key"]
    by_label = {s["label"]: s["scores"][key] for s in d["subjects"]}
    assert abs(by_label["Bottle"] - 1.1) < 1e-6
    assert abs(by_label["1 kWh"] - 0.5) < 1e-6
