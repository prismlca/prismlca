from __future__ import annotations

import pytest

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.tags import TagStore

METHOD = ["t", "gwp"]


def _flows_seed(bd) -> None:
    bd.Database("bio").write(
        {
            ("bio", "co2"): {"name": "CO2 fossil", "type": "emission", "categories": ("air",), "unit": "kg"},
            ("bio", "ch4"): {"name": "Methane", "type": "emission", "categories": ("air",), "unit": "kg"},
        }
    )
    bd.Database("fg").write(
        {
            ("fg", "b"): {
                "name": "bottle", "unit": "unit",
                "exchanges": [
                    {"input": ("fg", "b"), "amount": 1, "type": "production"},
                    {"input": ("bio", "co2"), "amount": 2.0, "type": "biosphere"},
                    {"input": ("bio", "ch4"), "amount": 0.1, "type": "biosphere"},
                ],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("bio", "co2"), 1.0), (("bio", "ch4"), 28.0)])


def _chain_seed(bd) -> None:
    bd.Database("bio").write(
        {("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("fg").write(
        {
            ("fg", "elec"): {
                "name": "electricity", "location": "DE", "unit": "kWh",
                "exchanges": [
                    {"input": ("fg", "elec"), "amount": 1, "type": "production"},
                    {"input": ("bio", "co2"), "amount": 0.5, "type": "biosphere"},
                ],
            },
            ("fg", "bottle"): {
                "name": "bottle", "location": "RER", "unit": "unit",
                "exchanges": [
                    {"input": ("fg", "bottle"), "amount": 1, "type": "production"},
                    {"input": ("fg", "elec"), "amount": 2, "type": "technosphere"},
                    {"input": ("bio", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    bd.Method(("t", "gwp")).write([(("bio", "co2"), 1.0)])


def test_elementary_flows(client, token, project):
    _flows_seed(get_bd())
    r = client.post("/api/v1/calc/elementary-flows", json={"database": "fg", "code": "b", "method": METHOD}, headers=token)
    assert r.status_code == 200, r.text
    d = r.json()
    assert abs(d["total"] - 4.8) < 1e-6
    flows = {f["flow"]: f["impact"] for f in d["flows"]}
    assert abs(flows["Methane"] - 2.8) < 1e-6
    assert abs(flows["CO2 fossil"] - 2.0) < 1e-6


def test_contribution_direct_and_geo(client, token, project):
    _chain_seed(get_bd())
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fg", "code": "bottle", "method": METHOD, "aggregate_by": "geo"},
        headers=token,
    )
    d = r.json()
    assert abs(d["meta"]["total"] - 1.1) < 1e-6
    assert abs(d["meta"]["direct"] - 0.1) < 1e-6
    assert abs(d["meta"]["upstream"] - 1.0) < 1e-6
    groups = {g["key"]: g["impact"] for g in d["aggregation"]["groups"]}
    assert abs(groups["RER"] - 0.1) < 1e-6
    assert abs(groups["DE"] - 1.0) < 1e-6


def test_tag_aggregation(client, token, project):
    _chain_seed(get_bd())
    ts = TagStore()
    ts.add("fg", "bottle", "stage", "converting")
    ts.add("fg", "elec", "stage", "energy")
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fg", "code": "bottle", "method": METHOD, "aggregate_by": "tag:stage"},
        headers=token,
    )
    groups = {g["key"]: g["impact"] for g in r.json()["aggregation"]["groups"]}
    assert abs(groups["converting"] - 0.1) < 1e-6
    assert abs(groups["energy"] - 1.0) < 1e-6


def test_the_flows_list_is_capped_but_says_how_many_there_are(client, token, project):
    """The panel shows the largest few; the total above it is the whole score.

    Those two facts together are a trap: 25 rows out of 1 800 do not add up to the number over them, and
    nothing would say so unless the response carries the count. `top_n <= 0` lifts the cap — what the Excel
    export asks for, because a spreadsheet is where the long tail is usable.
    """
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    gases = {f"g{i}": {"name": f"gas {i}", "type": "emission", "categories": ("air",), "unit": "kg"} for i in range(8)}
    bd.Database("bio").write({("bio", k): v for k, v in gases.items()})
    bd.Database("fg").write(
        {
            ("fg", "b"): {
                "name": "thing", "location": "GLO", "unit": "kg",
                "exchanges": [{"input": ("fg", "b"), "amount": 1, "type": "production"}]
                + [{"input": ("bio", k), "amount": 1.0 + i, "type": "biosphere"} for i, k in enumerate(gases)],
            }
        }
    )
    bd.Method(("t", "gwp")).write([(("bio", k), 1.0) for k in gases])

    body = {"database": "fg", "code": "b", "method": ["t", "gwp"]}
    capped = client.post("/api/v1/calc/elementary-flows", json={**body, "top_n": 3}, headers=token).json()
    assert len(capped["flows"]) == 3
    assert capped["count"] == 8  # the honest part: how many exist, not how many came back
    # Largest first, so a cap keeps the ones that matter.
    assert [f["flow"] for f in capped["flows"]] == ["gas 7", "gas 6", "gas 5"]

    every = client.post("/api/v1/calc/elementary-flows", json={**body, "top_n": 0}, headers=token).json()
    assert len(every["flows"]) == 8 == every["count"]
    assert every["total"] == capped["total"]  # the total was always the whole score
    assert sum(f["impact"] for f in every["flows"]) == pytest.approx(every["total"], rel=1e-6)
