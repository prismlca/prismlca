"""The shaping rule of the health check: material in primary forms against the forming steps in its process.

Every case runs on an invented background whose datasets carry nothing but a CPC class and their own inputs. The
names are neutral or deliberately misleading, so a test only passes when the rule reads the classification and
the structure, never a word in a name.
"""
from __future__ import annotations

import uuid

import pytest

from prism_lca.engine.bootstrap import get_bd

BG = "bg-forming"

#: CPC classes in the "code: name" form a background carries them. The names are our own short labels; the rule
#: decides by the code alone.
STEEL_PRIMARY = "41121: crude steel (test label)"
STEEL_FLAT = "4121: flat steel (test label)"
STEEL_SERVICE = "88601: steel service (test label)"
STEEL_CASTING = "89310: steel casting (test label)"
PRESSING = "89330: metal pressing (test label)"
NONFERROUS_SERVICE = "88602: non-ferrous service (test label)"
ALUMINIUM = "41431: aluminium (test label)"
COPPER = "41413: copper (test label)"
COPPER_WIRE = "41513: copper wire (test label)"
PE = "34710: polymer A (test label)"
PP = "34790: polymer B (test label)"
PS = "34720: polymer C (test label)"
FILM = "36330: plastic film (test label)"
PLASTIC_SERVICE = "89200: plastic service (test label)"


def _ds(code: str, cpc: str | None, inputs: dict[str, float] | None = None, production: float = 1.0,
        name: str | None = None, product: str | None = None, unit: str = "kilogram") -> tuple:
    data = {
        "name": name or f"dataset {code}",
        "reference product": product or name or f"product {code}",
        "unit": unit,
        "location": "GLO",
        "exchanges": [{"input": (BG, code), "type": "production", "amount": production}]
        + [{"input": (BG, src), "type": "technosphere", "amount": amt} for src, amt in (inputs or {}).items()],
    }
    if cpc:
        data["classifications"] = [("ISIC rev.4 ecoinvent", "2410:Manufacture"), ("CPC", cpc)]
    return (BG, code), data


@pytest.fixture
def background(project):
    """The invented background. Codes say what a dataset is; names say nothing, or the wrong thing."""
    rows = [
        _ds("crude", STEEL_PRIMARY, name="steel sheet, hot rolled, finished"),  # a misleading name
        _ds("crude_market", STEEL_PRIMARY, {"crude": 1.0}, name="market for item 7", product="steel sheet, hot rolled, finished"),
        _ds("hot", STEEL_SERVICE, {"crude": 0.05}, name="step A"),
        _ds("cold", STEEL_SERVICE, name="step B"),
        _ds("press", PRESSING, name="step C"),
        _ds("rolled", STEEL_FLAT, {"crude": 2.04, "hot": 2.0}, production=2.0, name="item 1"),
        _ds("lostwax", STEEL_CASTING, {"crude": 1.9}, name="item 2"),
        _ds("ingot", ALUMINIUM, name="item 3"),
        _ds("wrought", NONFERROUS_SERVICE, {"ingot": 1.0}, name="item 4"),
        _ds("alscrap", "39363: aluminium scrap (test label)", name="item 9"),
        _ds("remelted", NONFERROUS_SERVICE, {"alscrap": 1.01}, name="item 10"),
        _ds("alloy", ALUMINIUM, {"wrought": 1.0}, name="item 11"),  # a primary class made from the misclassified one
        _ds("cathode", COPPER, name="item 5"),
        _ds("cuwire", COPPER_WIRE, name="item 6"),
        _ds("pe", PE, name="granulate X"),
        _ds("pp", PP, name="granulate Y"),
        _ds("mould", PLASTIC_SERVICE, name="step D"),
        _ds("filmstep", PLASTIC_SERVICE, name="step E"),
        _ds("film", FILM, {"pe": 1.02, "filmstep": 1.0}, name="item 8"),
        _ds("foamstep", PLASTIC_SERVICE, name="step F"),
        _ds("foam", PS, {"foamstep": 1.0}, name="granulate Z"),  # a primary class over a shaped product
        _ds("waste_pp", PP, production=-1.0, name="treatment 1"),  # a treatment: consumed, never bought
        _ds("plain", None, name="item without classification"),  # what a BAFU dataset looks like here
        _ds("power", "17100: power (test label)", unit="kilowatt hour", name="power"),
    ]
    get_bd().Database(BG).write(dict(rows))
    return BG


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _process(client, token, db, name, inputs: dict[str, float]) -> str:
    code = client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "unit"}, headers=token
    ).json()["activity"]["code"]
    for src, amount in inputs.items():
        r = client.post(
            "/api/v1/model/exchanges",
            json={"activity_database": db, "activity_code": code, "input_database": BG, "input_code": src,
                  "amount": amount},
            headers=token,
        )
        assert r.status_code == 200, r.text
    return code


def _link(client, token, db, consumer, supplier, amount=1.0) -> None:
    client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": consumer, "input_database": db, "input_code": supplier,
              "amount": amount},
        headers=token,
    )


def _shaping(client, token, db) -> list[dict]:
    h = client.get(f"/api/v1/model/health/{db}", headers=token).json()
    assert any(c.startswith("shaping") for c in h["checks_run"])
    return [f for f in h["findings"] if f["code"] in ("missing_forming_step", "double_forming_step")]


def test_material_in_primary_forms_without_a_forming_step_is_reported(client, token, background):
    db = _fg(client, token)
    rim = _process(client, token, db, "rim", {"crude": 1.67, "power": 2.0})
    found = _shaping(client, token, db)
    assert len(found) == 1
    f = found[0]
    assert f["severity"] == "info" and f["code"] == "missing_forming_step"
    assert f["activity"]["code"] == rim
    # The material, its mass, its class and the conditional way out are all in the message.
    assert "1.67 kg" in f["message"] and "CPC 41121" in f["message"] and "steel in primary forms" in f["message"]
    assert "limitations" in f["message"] and "coating, adhesive or binder" in f["message"]


def test_a_misleading_name_does_not_hide_the_class(client, token, background):
    # The crude dataset is NAMED like rolled sheet; only its class and its inputs count.
    db = _fg(client, token)
    _process(client, token, db, "part", {"crude_market": 3.0})
    assert [f["code"] for f in _shaping(client, token, db)] == ["missing_forming_step"]


def test_first_steps_matching_the_material_are_quiet_within_yield(client, token, background):
    db = _fg(client, token)
    _process(client, token, db, "sheet part", {"crude": 5.0, "hot": 5.0, "cold": 5.0, "press": 4.9})
    _process(client, token, db, "moulded part", {"pp": 1.0, "mould": 0.98})
    assert _shaping(client, token, db) == []


def test_rolled_material_with_a_follow_up_rolling_step_is_quiet(client, token, background):
    # Cold rolling after hot rolling is the next step, not the embedded one counted again.
    db = _fg(client, token)
    _process(client, token, db, "cold-rolled part", {"rolled": 5.0, "cold": 5.0, "press": 5.0})
    assert _shaping(client, token, db) == []


def test_crude_metal_worked_only_by_a_later_step_names_the_missing_first_step(client, token, background):
    db = _fg(client, token)
    _process(client, token, db, "tub", {"crude": 11.0, "press": 11.0})
    (f,) = _shaping(client, token, db)
    assert f["code"] == "missing_forming_step"
    assert "worked here only by step C" in f["message"]
    assert "CPC 89330" in f["message"] and "already rolled" in f["message"]
    assert "missing for 11 kg" in f["message"]


def test_one_unshaped_component_is_not_hidden_by_well_covered_material(client, token, background):
    # 9 kg moulded, 1 kg with no step: the gap is exactly 10 % of the material, and one whole input.
    db = _fg(client, token)
    _process(client, token, db, "housing and foil", {"pp": 9.0, "pe": 1.0, "mould": 9.0})
    (f,) = _shaping(client, token, db)
    assert "no forming step for 1 kg" in f["message"]
    assert "The forming steps linked here (step D 9 kg) cover the rest" in f["message"]


def test_a_material_whose_production_holds_its_forming_is_shaped(client, token, background):
    db = _fg(client, token)
    _process(client, token, db, "insulation", {"foam": 2.0})
    _process(client, token, db, "sheet part", {"rolled": 2.0, "press": 2.0})
    _process(client, token, db, "foil", {"film": 0.5})
    assert _shaping(client, token, db) == []


def test_corrected_pouch_with_extrusion_for_its_granulate_is_quiet(client, token, background):
    # Granulate with its own film step and moulding, beside film bought finished: no gap, and the film step
    # is justified by the granulate rather than doubling the extrusion inside the finished film.
    db = _fg(client, token)
    _process(
        client, token, db, "pouch",
        {"pe": 0.0028, "pp": 0.00107, "film": 0.0065, "filmstep": 0.0028, "mould": 0.00107},
    )
    assert _shaping(client, token, db) == []


def test_a_forming_step_already_inside_the_material_is_reported_as_double(client, token, background):
    db = _fg(client, token)
    label = _process(client, token, db, "label", {"film": 0.002, "filmstep": 0.002})
    (f,) = _shaping(client, token, db)
    assert f["code"] == "double_forming_step" and f["activity"]["code"] == label
    assert "item 8" in f["message"] and "1 kg of step E per kg" in f["message"]


def test_doubling_is_not_reported_when_crude_material_justifies_the_step(client, token, background):
    db = _fg(client, token)
    _process(client, token, db, "mixed", {"rolled": 5.0, "crude": 5.0, "hot": 5.0})
    assert _shaping(client, token, db) == []


def test_contradictory_classes_are_judged_by_what_the_dataset_consumes(client, token, background):
    db = _fg(client, token)
    # A "service" class over a dataset that draws its own metal 1:1 is material in primary forms…
    cap = _process(client, token, db, "cap", {"wrought": 0.0025})
    # …and so is one that draws its metal as scrap.
    lid = _process(client, token, db, "lid", {"remelted": 0.004})
    # …one that draws much more than it delivers has lost metal to shaping: a cast part.
    _process(client, token, db, "cast part", {"lostwax": 0.4})
    # A product class over a dataset that draws none of its material is a forming step of unknown kind.
    _process(client, token, db, "cable", {"cathode": 1.0, "cuwire": 1.0})
    found = {f["activity"]["code"]: f["message"] for f in _shaping(client, token, db)}
    assert set(found) == {cap, lid}
    assert "2.5 g" in found[cap] and "classified CPC 88602 as a service" in found[cap]


def test_dormant_exchanges_and_treatments_count_for_nothing(client, token, background):
    db = _fg(client, token)
    _process(client, token, db, "switch off", {"crude": 0.0, "pp": 0.0})
    _process(client, token, db, "disposal", {"waste_pp": 1.0})
    dormant_step = _process(client, token, db, "dormant step", {"crude": 2.0, "hot": 0.0})
    (f,) = _shaping(client, token, db)
    assert f["activity"]["code"] == dormant_step


def test_forming_in_a_downstream_process_leaves_the_suppliers_unassessed(client, token, background):
    db = _fg(client, token)
    materials = _process(client, token, db, "materials", {"crude": 3.0})
    store = _process(client, token, db, "storage", {})
    forming = _process(client, token, db, "forming", {"hot": 3.0, "power": 1.0})
    _link(client, token, db, store, materials)
    _link(client, token, db, forming, store)
    assert _shaping(client, token, db) == []
    # A process off that path is still judged.
    other = _process(client, token, db, "elsewhere", {"crude": 1.0})
    assert [f["activity"]["code"] for f in _shaping(client, token, db)] == [other]


def test_unclassified_datasets_leave_their_process_unassessed_in_a_mixed_model(client, token, background):
    db = _fg(client, token)
    _process(client, token, db, "mixed sources", {"crude": 2.0, "plain": 2.0})
    judged = _process(client, token, db, "classified only", {"pp": 0.5})
    assert [f["activity"]["code"] for f in _shaping(client, token, db)] == [judged]


def test_end_of_life_processes_are_not_assessed(client, token, background):
    db = _fg(client, token)
    eol = _process(client, token, db, "disposal of the pack", {"pe": 0.5})
    for body in (
        ("/api/v1/model/tag-groups", {"database": db, "name": "Life-cycle phase"}),
        ("/api/v1/model/tag-groups/values", {"database": db, "group": "Life-cycle phase", "value": "End-of-life"}),
        ("/api/v1/model/tags/set", {"keys": [{"database": db, "code": eol}], "group": "Life-cycle phase",
                                    "value": "End-of-life"}),
    ):
        client.post(body[0], json=body[1], headers=token)
    assert _shaping(client, token, db) == []


def test_a_model_without_background_inputs_runs_the_check_quietly(client, token, background):
    db = _fg(client, token)
    a = _process(client, token, db, "a", {})
    b = _process(client, token, db, "b", {})
    _link(client, token, db, a, b)
    assert _shaping(client, token, db) == []


def test_masses_read_in_the_unit_that_fits():
    from prism_lca.engine.health_forming import _kg

    assert _kg(0.9995) == "1 kg" and _kg(0.048) == "48 g" and _kg(1.67) == "1.67 kg" and _kg(2500) == "2,500 kg"


def test_a_material_made_from_a_misclassified_one_is_not_read_as_shaped(client, token, background):
    # The alloy's producer consumes the wrought alloy, whose service class is wrong: that is buying metal, not
    # forming it, so the alloy is still in primary forms.
    db = _fg(client, token)
    housing = _process(client, token, db, "housing", {"alloy": 2.1})
    assert [f["activity"]["code"] for f in _shaping(client, token, db)] == [housing]


def test_a_forming_step_working_material_from_upstream_is_not_reported_as_double(client, token, background):
    # 3 kg of crude steel arrive from a supplier process; the rolling here works them, beside 1 kg bought rolled.
    db = _fg(client, token)
    materials = _process(client, token, db, "materials", {"crude": 3.0})
    rolling = _process(client, token, db, "rolling", {"rolled": 1.0, "hot": 3.0})
    _link(client, token, db, rolling, materials, 3.0)
    assert _shaping(client, token, db) == []


def test_a_dormant_link_to_a_forming_process_does_not_silence_the_supplier(client, token, background):
    db = _fg(client, token)
    materials = _process(client, token, db, "materials", {"crude": 2.0})
    rolling = _process(client, token, db, "rolling", {"hot": 2.0})
    _link(client, token, db, rolling, materials, 0.0)
    assert [f["activity"]["code"] for f in _shaping(client, token, db)] == [materials]
