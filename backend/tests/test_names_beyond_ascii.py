"""A parameter name is whatever the formula interpreter takes as one — letters of any script.

A model written in German names its distances `strecke_werk_händler_km`. The interpreter computed with such
a name all along, while everything that *reads* formulas for names knew ASCII letters only and saw
`strecke_werk_h` and `ndler_km`: the parameter was listed as used by nothing, the health check reported it as
unused although it carried the transport, the unit check left it out, and a sensitivity run took a formula
over it for a plain number. These tests hold each reader to the interpreter's reading.
"""
from __future__ import annotations

import uuid

from prism_lca.engine import param_references, sensitivity
from prism_lca.engine.health import _dimension_note, frozen_parameter_figures

NEAR, FAR = "strecke_händler_kunde_km", "strecke_werk_händler_km"


def _model_with_a_transport(client, token) -> tuple[str, str, str]:
    """A process whose one input is `masse_kg / 1000 * (FAR + NEAR)`; returns (database, process, exchange uid)."""
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200

    def create(name: str) -> str:
        made = client.post("/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"},
                           headers=token)
        return made.json()["activity"]["code"]

    shelf, lorry = create("shelf"), create("lorry")
    uid = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": shelf, "input_database": db, "input_code": lorry,
              "amount": 1.0},
        headers=token,
    ).json()["exchange"]["uid"]
    assert client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [
            {"name": "masse_kg", "amount": 13.8, "unit": "kg"},
            {"name": FAR, "amount": 600, "unit": "km"},
            {"name": NEAR, "amount": 100, "unit": "km"},
            {"name": "übrig", "amount": 1},
        ]},
        headers=token,
    ).status_code == 200
    return db, shelf, uid


def _set_formula(client, token, db, code, uid, formula) -> dict:
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": code, "uid": uid, "formula": formula},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_a_parameter_with_an_umlaut_in_an_exchange_formula_counts_as_used(client, token, project):
    db, shelf, uid = _model_with_a_transport(client, token)
    written = _set_formula(client, token, db, shelf, uid, f"masse_kg / 1000 * ({FAR} + {NEAR})")
    # The interpreter always took the names; this is what it made of them.
    assert abs(written["exchange"]["amount"] - 9.66) < 1e-9

    rows = {p["name"]: p for p in client.get(
        "/api/v1/params", params={"database": db, "with_usage": True}, headers=token
    ).json()}
    assert rows[FAR]["used_by_count"] == 1 and rows[NEAR]["used_by_count"] == 1
    assert [u["uid"] for u in rows[FAR]["used_by"]] == [uid]

    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    unused = [f["parameter"] for f in findings if f["code"] == "unused_parameter"]
    # The counter-case stays a finding: a name with an umlaut that no formula reads is still unused.
    assert unused == ["übrig"]


def test_the_unit_check_names_the_units_of_such_parameters(client, token, project):
    db, shelf, uid = _model_with_a_transport(client, token)
    written = _set_formula(client, token, db, shelf, uid, f"masse_kg / 1000 * ({FAR} + {NEAR})")
    assert written["exchange"]["dimension_check"]["parameter_units"] == {"masse_kg": "kg", FAR: "km", NEAR: "km"}


def test_a_chain_through_such_a_parameter_reaches_the_exchange(client, token, project):
    db, shelf, uid = _model_with_a_transport(client, token)
    assert client.post(
        "/api/v1/params/bulk",
        json={"database": db, "parameters": [{"name": "strecke_gesamt", "formula": f"{FAR} + {NEAR}"}]},
        headers=token,
    ).status_code == 200
    _set_formula(client, token, db, shelf, uid, "masse_kg / 1000 * strecke_gesamt")

    rows = {p["name"]: p for p in client.get(
        "/api/v1/params", params={"database": db, "with_usage": True}, headers=token
    ).json()}
    assert [u["name"] for u in rows[FAR]["used_by_parameters"]] == ["strecke_gesamt"]
    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    assert [f["parameter"] for f in findings if f["code"] == "unused_parameter"] == ["übrig"]


def test_a_formula_that_does_not_parse_keeps_such_a_name_whole():
    # Read as words, because the text is no expression — and the word is the whole name, not its ASCII head.
    assert param_references.names_in(f"{FAR} *") == {FAR}
    assert param_references.names_in("2 * größe;") == {"größe"}


def test_names_are_still_told_from_numbers_and_from_each_other():
    # The counter-case to "any letter": digits do not start a name, and an operator still ends one.
    assert param_references.names_in("3 * maß)") == {"maß"}
    assert param_references.names_in("2maß +") == {"maß"}
    assert param_references.names_in("a+b*c (") == {"a", "b", "c"}


def test_a_name_is_read_in_the_form_the_interpreter_compares():
    # "e" followed by a combining acute is the composed letter to Python; read letter by letter it would be the
    # parameter "cafe", and a model that has both would see the use booked on the wrong one.
    assert param_references.all_names_in("cafe\u0301 * 2") == {"caf\u00e9"}
    assert param_references.all_names_in("cafe\u0301 *") == {"caf\u00e9"}  # and when it does not parse
    # The interpreter's own names stay in this reading; names_in is the one that drops them.
    assert param_references.all_names_in("sqrt(größe) * pi") == {"sqrt", "größe", "pi"}
    assert param_references.names_in("sqrt(größe) * pi") == {"größe"}


def test_the_exponent_of_a_number_is_not_a_parameter(client, token, project):
    db, shelf, uid = _model_with_a_transport(client, token)
    assert client.post(
        "/api/v1/params", json={"database": db, "name": "e3", "amount": 2.0}, headers=token
    ).status_code == 200
    _set_formula(client, token, db, shelf, uid, f"masse_kg / 1e3 * {FAR}")
    rows = {p["name"]: p for p in client.get(
        "/api/v1/params", params={"database": db, "with_usage": True}, headers=token
    ).json()}
    # "1e3" is a number: the parameter that happens to be called e3 is used by nothing here.
    assert rows["e3"]["used_by_count"] == 0 and rows[FAR]["used_by_count"] == 1


def test_a_formula_over_such_a_parameter_is_derived_for_a_sensitivity_run():
    assert sensitivity._derived(f"{FAR} * 2", {FAR}) is True
    # A formula of numbers alone stays an input, and a name that only shares its ASCII head is not the parameter.
    assert sensitivity._derived("2.5 / 1000", {FAR}) is False
    assert sensitivity._derived("strecke_werk_h * 2", {FAR}) is False


def test_the_bare_parameter_unit_note_reads_such_a_name():
    note = _dimension_note({"formula": "masse_böden"}, "cubic meter", {"masse_böden": "kg"})
    assert note is not None and "masse_böden" in note


def test_a_stale_figure_beside_such_a_parameter_is_found():
    text = "Fachböden: 7,1 kg HDF (parameter masse_böden)"
    assert frozen_parameter_figures(text, {"masse_böden": 6.0}, {"masse_böden": "kg"}) == [
        ("masse_böden", "7,1 kg", 6.0)
    ]
    # In step with the parameter, the note says nothing.
    assert frozen_parameter_figures(text, {"masse_böden": 7.1}, {"masse_böden": "kg"}) == []
