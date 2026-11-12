"""A parameter that formulas or scenarios still name is not deleted, a model that already lost one says so,
and a write that fails on the missing name says which formula carries it (V499).

The run that found it deleted a share three end-of-life parameters and two scenarios were built on. The
deletion went through, and from then on every parameter write was refused with "The following variables
aren't defined: eol_thermal_share", including writes that never touched those parameters, while the health
check reported nothing.
"""
from __future__ import annotations

import uuid

from prism_lca.engine.bootstrap import get_bd


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def _param(client, token, db, name, **body):
    return client.post("/api/v1/params", json={"database": db, "name": name, **body}, headers=token)


def _bulk(client, token, db, items):
    return client.post("/api/v1/params/bulk", json={"database": db, "parameters": items}, headers=token)


def _delete(client, token, db, name):
    return client.post("/api/v1/params/delete", json={"database": db, "name": name}, headers=token)


def _params(client, token, db) -> dict[str, dict]:
    return {p["name"]: p for p in client.get("/api/v1/params", params={"database": db}, headers=token).json()}


def _health(client, token, db) -> list[dict]:
    return client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]


def _eol_model(client, token) -> str:
    """A share and two parameters computed from it — the shape of the run that found this."""
    db = _fg(client, token)
    assert _bulk(client, token, db, [
        {"name": "thermal_share", "amount": 0.6},
        {"name": "eol_incineration", "formula": "0.8 * thermal_share"},
        {"name": "eol_landfill", "formula": "0.8 * (1 - thermal_share)"},
        {"name": "mass", "amount": 0.4},
    ]).status_code == 200
    return db


def test_a_parameter_a_formula_still_uses_is_not_deleted(client, token, project):
    db = _eol_model(client, token)
    r = _delete(client, token, db, "thermal_share")
    assert r.status_code == 400, r.text
    error = r.json()["error"]
    assert error["code"] == "param_in_use"
    assert "parameter 'eol_incineration'" in error["message"] and "parameter 'eol_landfill'" in error["message"]
    # The way out is in the answer: rewrite the users and delete beside them, in one call.
    assert '"action": "delete"' in error["hint"]
    assert "thermal_share" in _params(client, token, db)

    # A parameter nothing names is deleted as before.
    assert _delete(client, token, db, "mass").status_code == 200
    assert "mass" not in _params(client, token, db)


def test_exchange_formulas_and_scenarios_count_as_users(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "Bottle production"), _create(client, token, db, "Granulate")
    uid = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b, "amount": 0},
        headers=token,
    ).json()["exchange"]["uid"]
    assert _param(client, token, db, "mass", amount=0.4).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 2"},
        headers=token,
    ).status_code == 200
    r = _delete(client, token, db, "mass")
    assert r.status_code == 400, r.text
    assert "the amount of 'Granulate' in 'Bottle production'" in r.json()["error"]["message"]
    assert "edit_exchange" in r.json()["error"]["hint"]

    assert _param(client, token, db, "share", amount=0.5).status_code == 200
    r = client.post("/api/v1/scenarios", json={"database": db, "name": "High", "overrides": {"share": 0.9}},
                    headers=token)
    assert r.status_code == 200, r.text
    r = _delete(client, token, db, "share")
    assert r.status_code == 400, r.text
    assert "scenario 'High'" in r.json()["error"]["message"]
    assert "edit_scenario" in r.json()["error"]["hint"]


def test_rewriting_the_users_and_deleting_in_one_batch_works_and_undoes_as_one(client, token, project):
    db = _eol_model(client, token)
    r = _bulk(client, token, db, [
        {"name": "eol_incineration", "amount": 0.5, "formula": ""},
        {"name": "eol_landfill", "formula": "0.8 - eol_incineration"},
        {"name": "thermal_share", "action": "delete"},
    ])
    assert r.status_code == 200, r.text
    ps = _params(client, token, db)
    assert "thermal_share" not in ps
    assert ps["eol_incineration"]["amount"] == 0.5 and not ps["eol_incineration"].get("formula")
    assert abs(ps["eol_landfill"]["amount"] - 0.3) < 1e-9

    # Not rewritten is not deleted: the whole call is refused and nothing of it is written.
    r = _bulk(client, token, db, [
        {"name": "mass", "amount": 0.5},
        {"name": "eol_incineration", "action": "delete"},
    ])
    assert r.status_code == 400 and r.json()["error"]["code"] == "param_in_use", r.text
    assert "parameter 'eol_landfill'" in r.json()["error"]["message"]
    assert _params(client, token, db)["mass"]["amount"] == 0.4

    # One step back puts the deleted parameter and the old formulas back together.
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    ps = _params(client, token, db)
    assert ps["thermal_share"]["amount"] == 0.6
    assert ps["eol_incineration"]["formula"] == "0.8 * thermal_share"
    assert abs(ps["eol_landfill"]["amount"] - 0.32) < 1e-9


def test_a_batch_may_only_delete_and_names_a_missing_parameter(client, token, project):
    db = _eol_model(client, token)
    r = _bulk(client, token, db, [{"name": "mass", "action": "delete"}])
    assert r.status_code == 200, r.text
    assert "mass" not in _params(client, token, db)
    r = _bulk(client, token, db, [{"name": "masss", "action": "delete"}])
    assert r.status_code == 404 and "'masss'" in r.json()["error"]["message"], r.text


def test_undoing_a_single_deletion_brings_the_parameter_back(client, token, project):
    db = _eol_model(client, token)
    assert _delete(client, token, db, "mass").status_code == 200
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    assert _params(client, token, db)["mass"]["amount"] == 0.4


def _break(db: str, name: str) -> None:
    """A model saved before the refusal existed: the parameter is gone, its users are not."""
    from prism_lca.engine import params

    params.delete_param(db, name)  # the engine call, below the command's check


def test_a_model_that_already_lost_a_parameter_is_reported_and_its_writes_name_the_carrier(
    client, token, project
):
    db = _eol_model(client, token)
    assert client.post("/api/v1/scenarios", json={"database": db, "name": "High", "overrides": {"thermal_share": 0.9}},
                       headers=token).status_code == 200
    _break(db, "thermal_share")

    findings = _health(client, token, db)
    errors = [f for f in findings if f["code"] == "formula_names_missing_parameter"]
    assert all(f["severity"] == "error" for f in errors)
    assert sorted(f["message"].split(" uses ")[0] for f in errors) == [
        "The formula of parameter 'eol_incineration'",
        "The formula of parameter 'eol_landfill'",
    ]
    warned = [f for f in findings if f["code"] == "scenario_names_missing_parameter"]
    assert len(warned) == 1 and warned[0]["severity"] == "warning"
    assert "Scenario 'High' names 'thermal_share'" in warned[0]["message"]
    assert client.get(f"/api/v1/model/health/{db}", headers=token).json()["ok"] is False

    # An unrelated write fails, as it did in the run, but now names who carries the dead name.
    r = _param(client, token, db, "mass", amount=0.5)
    assert r.status_code == 400, r.text
    message = r.json()["error"]["message"]
    assert "'eol_incineration' (not part of this call) still uses 'thermal_share'" in message, message
    assert "set its formula or value in the same call" in message

    # …and doing what it says works.
    r = _bulk(client, token, db, [
        {"name": "mass", "amount": 0.5},
        {"name": "eol_incineration", "amount": 0.48, "formula": ""},
        {"name": "eol_landfill", "amount": 0.32, "formula": ""},
    ])
    assert r.status_code == 200, r.text
    assert _params(client, token, db)["mass"]["amount"] == 0.5
    assert "formula_names_missing_parameter" not in [f["code"] for f in _health(client, token, db)]


def test_an_exchange_formula_refused_over_a_dead_parameter_formula_names_it(client, token, project):
    """bw2data evaluates the model's parameters before an exchange formula, so in a model that lost one, a new
    exchange formula is refused over a parameter formula it never mentions; the answer names that formula and
    where to repair it."""
    db = _eol_model(client, token)
    a, b = _create(client, token, db, "Bottle production"), _create(client, token, db, "Granulate")
    uid = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b, "amount": 1},
        headers=token,
    ).json()["exchange"]["uid"]
    _break(db, "thermal_share")
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 2"},
        headers=token,
    )
    assert r.status_code == 400, r.text
    message = r.json()["error"]["message"]
    assert "'eol_incineration' (not part of this call) still uses 'thermal_share'" in message, message
    assert "set its formula or value first (edit_parameter)" in message


def test_a_dead_name_in_an_exchange_formula_is_reported_on_the_exchange(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "Bottle production"), _create(client, token, db, "Granulate")
    uid = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b, "amount": 0},
        headers=token,
    ).json()["exchange"]["uid"]
    assert _param(client, token, db, "mass", amount=0.4).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 2"},
        headers=token,
    ).status_code == 200
    _break(db, "mass")

    errors = [f for f in _health(client, token, db) if f["code"] == "formula_names_missing_parameter"]
    assert len(errors) == 1 and errors[0]["severity"] == "error"
    assert errors[0]["activity"]["code"] == a and errors[0]["uid"] == uid
    assert "the amount of 'Granulate' in 'Bottle production' uses 'mass'" in errors[0]["message"]

    r = _param(client, token, db, "share", amount=0.5)
    assert r.status_code == 400, r.text
    assert "the amount of 'Granulate' in 'Bottle production' still uses 'mass'" in r.json()["error"]["message"]
    assert "edit_exchange" in r.json()["error"]["message"]
    # Creating the parameter again is one way out, and the model is whole again.
    assert _param(client, token, db, "mass", amount=0.4).status_code == 200
    assert "formula_names_missing_parameter" not in [f["code"] for f in _health(client, token, db)]


def test_a_misspelt_name_in_the_call_is_named_as_such(client, token, project):
    db = _eol_model(client, token)
    r = _param(client, token, db, "eol_recycling", formula="1 - eol_incineraton")
    assert r.status_code == 400, r.text
    message = r.json()["error"]["message"]
    assert "the formula sent for 'eol_recycling' uses 'eol_incineraton'" in message, message
    assert "check the spelling" in message


def test_a_healthy_model_has_no_dead_reference(client, token, project):
    db = _eol_model(client, token)
    codes = [f["code"] for f in _health(client, token, db)]
    assert "formula_names_missing_parameter" not in codes and "scenario_names_missing_parameter" not in codes
    # Functions and constants of the formula language are no parameters.
    assert _param(client, token, db, "capped", formula="min(1, max(0, thermal_share * pi / 3))").status_code == 200
    assert "formula_names_missing_parameter" not in [f["code"] for f in _health(client, token, db)]
    assert get_bd()  # the project is still usable


def test_a_batch_deletion_in_a_model_with_a_dead_exchange_formula_is_refused_before_anything_is_stored(
    client, token, project
):
    """The batch's rows are stored before bw2data evaluates the exchange formulas. In a model that already lost
    a parameter an exchange formula names, deleting anything else in a batch was stored, then the call failed
    on the exchange — reported as refused, with nothing to undo. It is refused before the write instead."""
    db = _fg(client, token)
    a, b = _create(client, token, db, "Bottle production"), _create(client, token, db, "Granulate")
    uid = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b, "amount": 0},
        headers=token,
    ).json()["exchange"]["uid"]
    assert _bulk(client, token, db, [{"name": "mass", "amount": 0.4}, {"name": "spare", "amount": 1.0}]
                 ).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 2"},
        headers=token,
    ).status_code == 200
    _break(db, "mass")

    r = _bulk(client, token, db, [{"name": "spare", "action": "delete"}])
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "param_dead_reference"
    assert "the amount of 'Granulate' in 'Bottle production' still uses 'mass'" in r.json()["error"]["message"]
    assert "spare" in _params(client, token, db)


def test_a_formula_asteval_accepts_is_read_like_asteval(client, token, project):
    """asteval parses a formula as a module, so "mass * 2;" is a valid formula; read as an expression it named
    nothing, and the parameter it names could be deleted."""
    from prism_lca.engine.param_references import names_in

    assert names_in("mass * 2;") == {"mass"}
    assert names_in("min(1, share) * pi") == {"share"}
    # A formula that does not parse keeps its words rather than reading as naming nothing.
    assert names_in("mass * (2") == {"mass"}

    db = _fg(client, token)
    assert _bulk(client, token, db, [{"name": "mass", "amount": 0.4}, {"name": "twice", "formula": "mass * 2;"}]
                 ).status_code == 200
    r = _delete(client, token, db, "mass")
    assert r.status_code == 400 and "parameter 'twice'" in r.json()["error"]["message"], r.text


def test_a_name_with_spaces_around_it_is_deleted_and_undone_by_its_real_name(client, token, project):
    db = _eol_model(client, token)
    assert _param(client, token, db, "mass", amount=0.4, unit="kg").status_code == 200
    assert _bulk(client, token, db, [{"name": " mass ", "action": "delete"}]).status_code == 200
    assert "mass" not in _params(client, token, db)
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    restored = _params(client, token, db)["mass"]
    assert restored["amount"] == 0.4 and restored["unit"] == "kg"
