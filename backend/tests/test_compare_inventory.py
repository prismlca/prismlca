"""The life cycle inventory beside the Results matrix: elementary flows per subject, from the same pass as the
scores, and the sheet it becomes in the Excel export."""
from __future__ import annotations

import base64
import io

from openpyxl import load_workbook

from prism_lca.engine.bootstrap import get_bd

METHOD = ["test", "gwp"]
DB = "fg"


def _seed(bd) -> None:
    """bottle: `kwh` kWh electricity (0.5 kg CO2 + 2 L water each) + 0.1 kg CO2 of its own.
    Inventory per bottle at kwh=2: CO2 1.1 kg, water 4 L; at kwh=1: CO2 0.6 kg, water 2 L."""
    bd.Database("biosphere").write(
        {
            ("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission",
                                   "categories": ("air", "urban air close to ground"), "unit": "kilogram"},
            ("biosphere", "water"): {"name": "Water", "type": "natural resource",
                                     "categories": ("natural resource", "in water"), "unit": "litre"},
            ("biosphere", "lead"): {"name": "Lead", "type": "emission", "categories": ("soil",),
                                    "unit": "kilogram"},
        }
    )
    fg = bd.Database(DB)
    fg.write(
        {
            (DB, "elec"): {
                "name": "electricity", "unit": "kWh", "reference product": "electricity",
                "exchanges": [
                    {"input": (DB, "elec"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 0.5, "type": "biosphere"},
                    {"input": ("biosphere", "water"), "amount": 2.0, "type": "biosphere"},
                ],
            },
            (DB, "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle",
                "exchanges": [
                    {"input": (DB, "bottle"), "amount": 1, "type": "production"},
                    {"input": (DB, "elec"), "amount": 2.0, "type": "technosphere"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
        }
    )
    for e in fg.get("bottle").technosphere():
        e["prism_uid"] = "e"
        e.save()
    bd.databases[DB]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(tuple(METHOD)).write([(("biosphere", "co2"), 1.0)])


def _flow_id(bd, code: str) -> str:
    return str(bd.get_node(database="biosphere", code=code).id)


def _compare(client, token, subjects: list[dict], **extra) -> dict:
    r = client.post(
        "/api/v1/calc/compare", json={"subjects": subjects, "methods": [METHOD], **extra}, headers=token
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_each_subject_carries_its_inventory_and_the_flows_are_named_once(client, token, project):
    bd = get_bd()
    _seed(bd)
    body = _compare(
        client, token,
        [{"database": DB, "code": "bottle", "label": "Bottle"},
         {"database": DB, "code": "elec", "label": "3 kWh", "amount": 3.0}],
        inventory=True,
    )
    co2, water = _flow_id(bd, "co2"), _flow_id(bd, "water")
    by = {s["label"]: s for s in body["subjects"]}
    assert abs(by["Bottle"]["inventory"][co2] - 1.1) < 1e-6
    assert abs(by["Bottle"]["inventory"][water] - 4.0) < 1e-6
    # The amount scales the inventory as it scales the score.
    assert abs(by["3 kWh"]["inventory"][co2] - 1.5) < 1e-6
    assert abs(by["3 kWh"]["inventory"][water] - 6.0) < 1e-6
    # A flow nothing in the system exchanges is not a row of zeros.
    assert _flow_id(bd, "lead") not in by["Bottle"]["inventory"]
    assert _flow_id(bd, "lead") not in body["inventory_flows"]
    assert body["inventory_flows"][co2] == {
        "name": "Carbon dioxide", "categories": ["air", "urban air close to ground"], "unit": "kilogram",
    }
    assert body["inventory_flows"][water]["unit"] == "litre"
    # The score and the inventory describe one calculation: CO2 is the only characterised flow.
    key = body["methods"][0]["key"]
    assert abs(by["Bottle"]["scores"][key] - by["Bottle"]["inventory"][co2]) < 1e-6


def test_a_model_of_one_process_has_an_inventory_too(client, token, project):
    """A 1x1 system: the solver hands its supply back as a scalar, not as a vector of one."""
    bd = get_bd()
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",),
                                "unit": "kilogram"}}
    )
    bd.Database("one").write(
        {("one", "p"): {"name": "bottle", "unit": "unit", "exchanges": [
            {"input": ("one", "p"), "amount": 1, "type": "production"},
            {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
        ]}}
    )
    bd.Method(tuple(METHOD)).write([(("biosphere", "co2"), 1.0)])
    body = _compare(client, token, [{"database": "one", "code": "p"}], inventory=True)
    assert abs(body["subjects"][0]["inventory"][_flow_id(bd, "co2")] - 2.0) < 1e-6


def test_without_the_switch_the_answer_is_as_before(client, token, project):
    _seed(get_bd())
    body = _compare(client, token, [{"database": DB, "code": "bottle", "label": "Bottle"}])
    assert "inventory_flows" not in body
    assert "inventory" not in body["subjects"][0]


def test_a_scenario_subject_gets_its_own_inventory_from_its_one_window(client, token, project, monkeypatch):
    """The scenario's inventory is read inside the window its scores are computed in: the scenario's amounts,
    not the baseline's, and no second apply-and-restore for them."""
    from prism_lca.engine import params as params_engine

    bd = get_bd()
    _seed(bd)
    assert client.post("/api/v1/params", json={"database": DB, "name": "kwh", "amount": 2.0},
                       headers=token).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": DB, "activity_code": "bottle", "uid": "e", "formula": "kwh"},
        headers=token,
    ).status_code == 200
    r = client.post("/api/v1/scenarios", json={"database": DB, "name": "efficient", "overrides": {"kwh": 1.0}},
                    headers=token)
    assert r.status_code == 200, r.text
    sid = r.json()["scenario"]["id"]

    writes: list[int] = []
    real = params_engine.apply_values
    monkeypatch.setattr(params_engine, "apply_values", lambda *a, **k: writes.append(1) or real(*a, **k))
    body = _compare(
        client, token,
        [{"database": DB, "code": "bottle", "label": "Baseline"},
         {"database": DB, "code": "bottle", "label": "efficient", "scenario": sid}],
        inventory=True,
    )
    assert len(writes) == 2  # the scenario's apply + restore, once
    co2, water = _flow_id(bd, "co2"), _flow_id(bd, "water")
    by = {s["label"]: s["inventory"] for s in body["subjects"]}
    assert abs(by["Baseline"][co2] - 1.1) < 1e-6 and abs(by["Baseline"][water] - 4.0) < 1e-6
    assert abs(by["efficient"][co2] - 0.6) < 1e-6 and abs(by["efficient"][water] - 2.0) < 1e-6
    # And the baseline is back afterwards.
    after = _compare(client, token, [{"database": DB, "code": "bottle", "label": "Baseline"}], inventory=True)
    assert abs(after["subjects"][0]["inventory"][water] - 4.0) < 1e-6


def test_the_inventory_costs_no_solve_of_its_own(client, token, project, monkeypatch):
    """Read off the scores' own solve: asking for the inventory does not set the system up once more."""
    from prism_lca.engine import lca

    _seed(get_bd())
    solves: list[int] = []
    real = lca.get_lca
    monkeypatch.setattr(lca, "get_lca", lambda *a, **k: solves.append(1) or real(*a, **k))
    subjects = [{"database": DB, "code": "bottle"}, {"database": DB, "code": "elec"}]
    _compare(client, token, subjects)
    without = len(solves)
    solves.clear()
    _compare(client, token, subjects, inventory=True)
    assert len(solves) == without == 2


def test_the_flows_are_named_under_the_lock_the_amounts_were_read_under(client, token, project, monkeypatch):
    """A workspace switch takes the LCA lock; named after it was released, a flow id could be read in the next
    workspace and the amounts carry its names."""
    from prism_lca.engine import compare_inventory, lca

    _seed(get_bd())
    held: list[bool] = []
    real = compare_inventory.flow_details
    monkeypatch.setattr(compare_inventory, "flow_details",
                        lambda ids: held.append(lca._LCA_LOCK._is_owned()) or real(ids))
    body = _compare(client, token, [{"database": DB, "code": "bottle"}, {"database": DB, "code": "elec"}],
                    inventory=True)
    assert held and all(held)
    assert {f["name"] for f in body["inventory_flows"].values()} == {"Carbon dioxide", "Water"}


def test_the_results_workbook_gains_an_lci_sheet(client, token, project):
    r = client.post(
        "/api/v1/export/compare-matrix",
        json={
            "columns": [{"key": "a", "family": "EF v3.1", "label": "climate change", "unit": "kg CO2-Eq"}],
            "subjects": [{"label": "Baseline", "scores": {"a": 1.1}}, {"label": "efficient", "scores": {"a": 0.6}}],
            "inventory": {
                "subjects": ["Baseline", "efficient"],
                "flows": [
                    {"flow": "Carbon dioxide", "categories": ["air", "urban"], "unit": "kilogram",
                     "amounts": [1.1, 0.6]},
                    {"flow": "Water", "categories": ["natural resource"], "unit": "litre", "amounts": [4.0, 0.0]},
                ],
            },
        },
        headers=token,
    )
    assert r.status_code == 200, r.text
    wb = load_workbook(io.BytesIO(base64.b64decode(r.json()["base64"])))
    assert wb.sheetnames == ["Results", "LCI"]
    ws = wb["LCI"]
    assert [ws.cell(1, j).value for j in range(1, 6)] == ["Flow", "Compartment", "Unit", "Baseline", "efficient"]
    assert [ws.cell(2, j).value for j in range(1, 6)] == ["Carbon dioxide", "air / urban", "kilogram", 1.1, 0.6]
    assert [ws.cell(3, j).value for j in range(4, 6)] == [4.0, 0.0]
    assert ws.freeze_panes == "D2"
    # No merged cells: the sheet sorts and filters as it is.
    assert not ws.merged_cells.ranges


def test_the_results_workbook_without_an_inventory_has_one_sheet(client, token, project):
    r = client.post(
        "/api/v1/export/compare-matrix",
        json={"columns": [{"key": "a", "family": "F", "label": "x", "unit": "kg"}],
              "subjects": [{"label": "Bottle", "scores": {"a": 1.0}}]},
        headers=token,
    )
    assert load_workbook(io.BytesIO(base64.b64decode(r.json()["base64"]))).sheetnames == ["Results"]


def test_the_lci_table_exports_on_its_own(client, token, project):
    r = client.post(
        "/api/v1/export/lci",
        json={"subjects": ["Bottle"],
              "flows": [{"flow": "=Water", "categories": [], "unit": "litre", "amounts": [4.0]}],
              "filename": "my lci"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert r.json()["filename"] == "my_lci.xlsx"
    wb = load_workbook(io.BytesIO(base64.b64decode(r.json()["base64"])))
    assert wb.sheetnames == ["LCI"]
    # Text stays text, even when it reads like a formula.
    assert wb["LCI"].cell(2, 1).value == "=Water"
    assert wb["LCI"].cell(2, 1).data_type == "s"
    assert wb["LCI"].cell(2, 4).value == 4.0
