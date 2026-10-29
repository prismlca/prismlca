from __future__ import annotations

import base64
import io

from openpyxl import load_workbook

from prism_lca.engine.bootstrap import get_bd


def _seed_methods(bd) -> None:
    """Two biosphere flows and two indicators with partly overlapping coverage:
    GWP characterises CO2 + CH4; AP characterises only SO2."""
    bd.Database("biosphere").write({
        ("biosphere", "co2"): {"name": "Carbon dioxide", "categories": ("air",), "unit": "kg"},
        ("biosphere", "ch4"): {"name": "Methane", "categories": ("air",), "unit": "kg"},
        ("biosphere", "so2"): {"name": "Sulfur dioxide", "categories": ("air",), "unit": "kg"},
    })
    bd.Method(("m", "gwp")).write([(("biosphere", "co2"), 1.0), (("biosphere", "ch4"), 28.0)])
    bd.Method(("m", "ap")).write([(("biosphere", "so2"), 1.2)])


def test_characterization_factors_union_and_gaps(client, token, project):
    _seed_methods(get_bd())
    r = client.post(
        "/api/v1/calc/characterization-factors",
        json={"methods": [["m", "gwp"], ["m", "ap"]]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert [m["method"] for m in body["methods"]] == [["m", "gwp"], ["m", "ap"]]

    by_flow = {f["flow"]: f for f in body["flows"]}
    # Union of all three flows is present.
    assert set(by_flow) == {"Carbon dioxide", "Methane", "Sulfur dioxide"}
    # GWP factors present, AP absent (None → greyed cell) for CO2/CH4.
    assert by_flow["Carbon dioxide"]["factors"] == [1.0, None]
    assert by_flow["Methane"]["factors"] == [28.0, None]
    # SO2 only characterised by AP.
    assert by_flow["Sulfur dioxide"]["factors"] == [None, 1.2]


def test_characterization_factors_filter_and_limit(client, token, project):
    """Narrowing lives in the backend so every client (LCIA page, AI tool, future MCP) filters
    identically; total_flows always reports the match count before the cap."""
    _seed_methods(get_bd())
    body = {"methods": [["m", "gwp"], ["m", "ap"]]}

    # Filter on the flow name.
    r = client.post("/api/v1/calc/characterization-factors", json={**body, "flow_query": "methane"}, headers=token)
    assert r.status_code == 200, r.text
    d = r.json()
    assert [f["flow"] for f in d["flows"]] == ["Methane"]
    assert d["total_flows"] == 1

    # Filter on the compartment.
    r2 = client.post("/api/v1/calc/characterization-factors", json={**body, "flow_query": "air"}, headers=token)
    assert len(r2.json()["flows"]) == 3  # all three seeded flows are air emissions

    # Cap the rows, but still report how many matched.
    r3 = client.post("/api/v1/calc/characterization-factors", json={**body, "limit": 2}, headers=token)
    assert len(r3.json()["flows"]) == 2
    assert r3.json()["total_flows"] == 3

    # No filter, no cap → everything (unchanged default for the LCIA page).
    r4 = client.post("/api/v1/calc/characterization-factors", json=body, headers=token)
    assert len(r4.json()["flows"]) == 3 and r4.json()["total_flows"] == 3

    # Unknown term matches nothing rather than erroring.
    r5 = client.post("/api/v1/calc/characterization-factors", json={**body, "flow_query": "zzz"}, headers=token)
    assert r5.json()["flows"] == [] and r5.json()["total_flows"] == 0


def test_characterization_factors_cap_at_four(client, token, project):
    _seed_methods(get_bd())
    five = [["m", "gwp"]] * 5
    r = client.post("/api/v1/calc/characterization-factors", json={"methods": five}, headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "too_many_methods"


def test_lcia_factors_xlsx_export(client, token, project):
    _seed_methods(get_bd())
    cf = client.post(
        "/api/v1/calc/characterization-factors",
        json={"methods": [["m", "gwp"], ["m", "ap"]]},
        headers=token,
    ).json()
    r = client.post(
        "/api/v1/export/lcia-factors",
        json={"methods": cf["methods"], "flows": cf["flows"]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(base64.b64decode(r.json()["base64"])), data_only=True)
    ws = wb.active
    grid = list(ws.iter_rows(values_only=True))
    assert grid[0][0] == "Flow" and grid[0][1] == "Categories" and grid[0][2] == "Unit"
    assert len(grid[0]) == 5  # 3 fixed columns + 2 indicators
    assert len(grid) == 1 + 3  # header + 3 flows
