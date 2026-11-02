"""Value rules on a parameter — Excel's data validation, enforced on every path that writes a value."""
from __future__ import annotations

import io

import pytest

from prism_lca.engine import param_rules
from prism_lca.errors import PrismError


def _model(client, token, name="pr-db"):
    client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    return name


def _set(client, token, db, **kw):
    return client.post("/api/v1/params", json={"database": db, **kw}, headers=token)


# --------------------------------------------------------------------------- the rule itself
def test_a_rule_that_accepts_nothing_is_refused_when_it_is_written():
    """A range whose minimum is above its maximum accepts no value at all.

    Refused when the rule is set rather than when the next value is: a parameter that cannot be given a
    value is a worse state than one with no rule, and the person who could fix it is the one setting it.
    """
    with pytest.raises(PrismError):
        param_rules.check_rule({"kind": "range", "min": 1, "max": 0})
    with pytest.raises(PrismError):
        param_rules.check_rule({"kind": "range"})  # neither end
    with pytest.raises(PrismError):
        param_rules.check_rule({"kind": "list", "values": []})
    with pytest.raises(PrismError):
        param_rules.check_rule({"kind": "between", "min": 0})

    # A list may arrive as the semicolon-separated string the field is typed in, comma decimals and all.
    assert param_rules.check_rule({"kind": "list", "values": "0,25; 0.5 ;0.75;0.5"}) == {
        "kind": "list",
        "values": [0.25, 0.5, 0.75],  # deduplicated, in the order they were written
    }
    # One open end is the "at least" / "at most" rule, and says so.
    assert param_rules.describe({"kind": "range", "min": 0}) == "at least 0"
    assert param_rules.describe({"kind": "range", "max": 1}) == "at most 1"
    assert param_rules.describe({"kind": "range", "min": 0, "max": 1}) == "between 0 and 1"
    assert param_rules.describe({}) == "any number"


def test_a_value_is_measured_against_its_rule():
    assert param_rules.violates({"kind": "positive"}, 0) is not None  # positive means > 0
    assert param_rules.violates({"kind": "positive"}, 0.1) is None
    assert param_rules.violates({"kind": "negative"}, -0.1) is None
    assert param_rules.violates({"kind": "negative"}, 0) is not None
    assert param_rules.violates({"kind": "range", "min": 0, "max": 1}, 1) is None  # inclusive
    assert param_rules.violates({"kind": "range", "min": 0, "max": 1}, 1.0001) is not None
    assert param_rules.violates({"kind": "list", "values": [0.25, 0.5]}, 0.5) is None
    assert param_rules.violates({"kind": "list", "values": [0.25, 0.5]}, 0.3) is not None
    # No value yet is not a violation — a parameter has to be creatable before it has one.
    assert param_rules.violates({"kind": "positive"}, None) is None
    # Floats do not compare exactly: a 0…1 range has to accept the 1 a formula returns as 0.999…
    assert param_rules.violates({"kind": "range", "min": 0, "max": 1}, 0.9999999999999999) is None
    assert param_rules.violates({"kind": "list", "values": [0.1]}, 0.1 + 2e-17) is None


# --------------------------------------------------------------------------- the write paths
def test_a_refused_value_never_reaches_the_parameter(client, token, project):
    db = _model(client, token)
    assert _set(client, token, db, name="rate", amount=0.5,
                rule={"kind": "range", "min": 0, "max": 1}).status_code == 200

    bad = _set(client, token, db, name="rate", amount=1.4)
    assert bad.status_code == 400
    assert "1.4" in bad.json()["error"]["message"]
    # And the old value is still there — a refused write changes nothing.
    rate = next(p for p in client.get(f"/api/v1/params?database={db}", headers=token).json() if p["name"] == "rate")
    assert rate["amount"] == 0.5
    assert rate["rule"] == {"kind": "range", "min": 0.0, "max": 1.0}

    # A rule the value already there would break is refused too, naming both.
    assert _set(client, token, db, name="rate", rule={"kind": "negative"}).status_code == 400
    # Clearing the rule is an empty object, and then anything goes again.
    assert _set(client, token, db, name="rate", rule={}).status_code == 200
    assert _set(client, token, db, name="rate", amount=1.4).status_code == 200


def test_a_formula_that_computes_out_of_range_is_undone(client, token, project):
    """The one value that cannot be checked before it exists.

    A formula's result is only known after the recalculation, so the check happens there — and a violation
    is *undone*, not merely reported: leaving it would mean a parameter that breaks its own rule, with every
    exchange that reads it already carrying the number.
    """
    db = _model(client, token, "pr-formula")
    _set(client, token, db, name="mass", amount=2)
    assert _set(client, token, db, name="share", amount=0.5, rule={"kind": "range", "min": 0, "max": 1}).status_code == 200

    bad = _set(client, token, db, name="share", formula="mass * 2")  # = 4
    assert bad.status_code == 400
    assert "4" in bad.json()["error"]["message"]
    share = next(p for p in client.get(f"/api/v1/params?database={db}", headers=token).json() if p["name"] == "share")
    assert share["amount"] == 0.5 and not share["formula"]  # rolled back, formula not kept

    # A formula that lands inside the rule is accepted and keeps its formula.
    assert _set(client, token, db, name="share", formula="mass / 4").status_code == 200
    share = next(p for p in client.get(f"/api/v1/params?database={db}", headers=token).json() if p["name"] == "share")
    assert share["amount"] == 0.5 and share["formula"] == "mass / 4"


def test_a_scenario_cannot_override_past_the_rule(client, token, project):
    db = _model(client, token, "pr-scen")
    _set(client, token, db, name="rate", amount=0.5, rule={"kind": "range", "min": 0, "max": 1})

    created = client.post("/api/v1/scenarios", json={"database": db, "name": "High"}, headers=token)
    sid = created.json()["scenario"]["id"]
    ok = client.post("/api/v1/scenarios/value",
                     json={"id": sid, "param": "rate", "value": 0.9}, headers=token)
    assert ok.status_code == 200
    bad = client.post("/api/v1/scenarios/value",
                      json={"id": sid, "param": "rate", "value": 2}, headers=token)
    assert bad.status_code == 400 and "High" in bad.json()["error"]["message"]
    # The scenario keeps the value it had.
    listed = client.get(f"/api/v1/scenarios?database={db}", headers=token).json()
    assert listed[0]["overrides"] == {"rate": 0.9}
    # Creating one with a bad override is refused as well — nothing half-written.
    assert client.post("/api/v1/scenarios",
                       json={"database": db, "name": "Bad", "overrides": {"rate": 3}}, headers=token).status_code == 400


def test_a_workbook_cell_that_breaks_a_rule_stops_the_import(client, token, project):
    """The path where nobody is watching: a value typed into a spreadsheet by someone else.

    All-or-nothing, and before anything is written — half a workbook applied is worse than a refused one.
    """
    from openpyxl import Workbook

    db = _model(client, token, "pr-xlsx")
    _set(client, token, db, name="rate", amount=0.5, rule={"kind": "list", "values": [0.25, 0.5, 0.75]})

    def upload(value):
        wb = Workbook()
        ws = wb.active
        ws.append(["parameter", "S1"])
        ws.append(["rate", value])
        buf = io.BytesIO()
        wb.save(buf)
        import base64

        return client.post(
            "/api/v1/scenarios/import",
            json={"database": db, "xlsx_base64": base64.b64encode(buf.getvalue()).decode()},
            headers=token,
        )

    bad = upload(0.3)
    assert bad.status_code == 400
    body = bad.json()["error"]["message"]
    assert "rate" in body and "S1" in body
    assert client.get(f"/api/v1/scenarios?database={db}", headers=token).json() == []  # nothing written
    assert upload(0.75).status_code == 200


def test_a_parameter_written_before_rules_existed_has_none(client, token, project):
    """No rule is the state every existing parameter is in, and it has to keep accepting anything."""
    db = _model(client, token, "pr-old")
    _set(client, token, db, name="free", amount=1)
    row = next(p for p in client.get(f"/api/v1/params?database={db}", headers=token).json() if p["name"] == "free")
    assert row["rule"] == {}
    assert _set(client, token, db, name="free", amount=-999).status_code == 200


# --------------------------------------------------------------------------- rules from the assistant
def _ai(client, token, db, **kw):
    return client.post("/api/v1/params", json={"database": db, "source": "ai", **kw}, headers=token)


def _rule_of(client, token, db, name):
    return next(p for p in client.get(f"/api/v1/params?database={db}", headers=token).json()
                if p["name"] == name)["rule"]


def test_the_assistant_gives_a_new_parameter_the_rule_its_meaning_fixes(client, token, project):
    db = _model(client, token, "pr-ai")
    assert _ai(client, token, db, name="share", amount=0.85, rule={"kind": "range", "min": 0, "max": 1}).status_code == 200
    assert _ai(client, token, db, name="km", amount=120, rule={"kind": "positive"}).status_code == 200
    assert _ai(client, token, db, name="heat_pump", amount=1, rule={"kind": "list", "values": [1, 0]}).status_code == 200
    assert _rule_of(client, token, db, "share") == {"kind": "range", "min": 0.0, "max": 1.0}
    assert _rule_of(client, token, db, "heat_pump") == {"kind": "list", "values": [1.0, 0.0]}


def test_the_assistant_sets_no_list_but_the_switch(client, token, project):
    db = _model(client, token, "pr-ai-list")
    r = _ai(client, token, db, name="fill", amount=0.5, rule={"kind": "list", "values": [0.25, 0.5, 0.75]})
    assert r.status_code == 400 and r.json()["error"]["code"] == "param_rule_list_not_yours"
    assert all(p["name"] != "fill" for p in client.get(f"/api/v1/params?database={db}", headers=token).json())


def test_the_assistant_leaves_an_existing_rule_alone(client, token, project):
    db = _model(client, token, "pr-ai-old")
    _set(client, token, db, name="rate", amount=0.5, rule={"kind": "range", "min": 0, "max": 1})
    _set(client, token, db, name="free", amount=0.05)
    for name, rule in (("rate", {"kind": "positive"}), ("rate", {}), ("free", {"kind": "range", "min": 0, "max": 1})):
        r = _ai(client, token, db, name=name, amount=0.4, rule=rule)
        assert r.status_code == 400 and r.json()["error"]["code"] == "param_rule_not_yours", (name, rule)
    assert _rule_of(client, token, db, "free") == {}
    # Spelled with spaces the writers strip, it is still the existing parameter.
    for name in (" rate ", "rate "):
        r = _ai(client, token, db, name=name, amount=0.4, rule={})
        assert r.status_code == 400 and r.json()["error"]["code"] == "param_rule_not_yours", name
    bulk = client.post("/api/v1/params/bulk", json={"database": db, "source": "ai", "parameters": [
        {"name": " rate", "amount": 0.4, "rule": {"kind": "positive"}}]}, headers=token)
    assert bulk.status_code == 400 and bulk.json()["error"]["code"] == "param_rule_not_yours"
    assert _rule_of(client, token, db, "rate") == {"kind": "range", "min": 0.0, "max": 1.0}
    # The same rule sent again with an update (a batch repeated after a refusal) is no change, and passes.
    assert _ai(client, token, db, name="rate", amount=0.4, rule={"kind": "range", "min": 0, "max": 1}).status_code == 200
    # And without a rule the assistant updates values as before.
    assert _ai(client, token, db, name="free", amount=0.07).status_code == 200


def test_a_batch_with_one_rule_the_assistant_may_not_set_writes_nothing(client, token, project):
    db = _model(client, token, "pr-ai-bulk")
    r = client.post("/api/v1/params/bulk", json={"database": db, "source": "ai", "parameters": [
        {"name": "share", "amount": 0.85, "rule": {"kind": "range", "min": 0, "max": 1}},
        {"name": "fill", "amount": 0.5, "rule": {"kind": "list", "values": [0.25, 0.5]}},
    ]}, headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "param_rule_list_not_yours"
    assert client.get(f"/api/v1/params?database={db}", headers=token).json() == []


def test_the_modeller_still_sets_any_rule(client, token, project):
    db = _model(client, token, "pr-user")
    assert _set(client, token, db, name="fill", amount=0.5,
                rule={"kind": "list", "values": [0.25, 0.5, 0.75]}).status_code == 200
    assert _set(client, token, db, name="fill", rule={"kind": "range", "min": 0, "max": 1}).status_code == 200


def test_the_health_check_asks_about_a_share_without_a_rule(client, token, project):
    db = _model(client, token, "pr-health")
    _set(client, token, db, name="return_rate", amount=0.97)
    _set(client, token, db, name="loss", amount=0.05, unit="-")
    _set(client, token, db, name="ruled", amount=0.5, rule={"kind": "range", "min": 0, "max": 1})
    _set(client, token, db, name="mass_kg", amount=0.35, unit="kg")
    _set(client, token, db, name="switch", amount=1)
    _set(client, token, db, name="half", formula="return_rate / 2")
    findings = client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
    hits = [f for f in findings if f["code"] == "share_without_rule"]
    assert len(hits) == 1 and hits[0]["severity"] == "info"
    assert hits[0]["parameters"] == ["loss", "return_rate"] or hits[0]["parameters"] == ["return_rate", "loss"]
    assert "return_rate (0.97)" in hits[0]["message"] and "Parameters page" in hits[0]["message"]
