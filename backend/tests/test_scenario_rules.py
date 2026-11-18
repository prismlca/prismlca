"""What a scenario does to parameters it does not set, and when a value equal to the baseline is refused.

Seen in test runs: "Steel 100 % recycling" set the recycling share to 1, and the landfill remainder
``1 - recycling - incineration`` came out at -0.15 % under a rule of 0 to 1 — a credit nobody asked for,
accepted without a word. A complete set of shares with one share at its current value was refused whole as
"would return the baseline result", which was not true. And a temperature rise of 0 under a "positive" rule
was refused without the way out, so a cold-water wash was modelled at 0.1 K.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd

DB = "sr"
SHARE = {"kind": "range", "min": 0, "max": 1}


def _model(client, token, rec: float = 0.7, inc: float = 0.15) -> None:
    bd = get_bd()
    bd.Database(DB).write(
        {(DB, "p"): {"name": "p", "unit": "kilogram", "reference product": "p",
                     "exchanges": [{"input": (DB, "p"), "amount": 1, "type": "production"}]}}
    )
    bd.databases[DB]["prism_read_only"] = False
    bd.databases.flush()
    for body in (
        {"name": "share_rec", "amount": rec, "rule": SHARE},
        {"name": "share_inc", "amount": inc, "rule": SHARE},
        {"name": "share_land", "formula": "1 - share_rec - share_inc", "rule": SHARE},
        {"name": "delta_t_k", "amount": 25.0, "rule": {"kind": "positive"}},
    ):
        r = client.post("/api/v1/params", json={"database": DB, **body}, headers=token)
        assert r.status_code == 200, r.text


def _create(client, token, overrides: dict, name: str = "variant"):
    return client.post("/api/v1/scenarios", json={"database": DB, "name": name, "overrides": overrides}, headers=token)


def test_a_scenario_that_drives_a_remainder_below_its_rule_is_refused(client, token, project):
    _model(client, token)
    r = _create(client, token, {"share_rec": 1.0})
    assert r.status_code == 400, r.text
    err = r.json()["error"]
    assert err["code"] == "scenario_breaks_dependent_rule"
    assert "'share_land'" in err["message"] and "1 - share_rec - share_inc" in err["message"]
    assert "'share_inc'" in err["hint"]  # the input that can bring the remainder back
    # Setting the other share in the same scenario is the way out, and it is accepted.
    assert _create(client, token, {"share_rec": 1.0, "share_inc": 0.0}).status_code == 200


def test_a_remainder_that_stays_within_its_rule_passes(client, token, project):
    _model(client, token)
    r = _create(client, token, {"share_rec": 0.8})
    assert r.status_code == 200, r.text
    assert "warnings" not in r.json()


def test_a_rule_the_baseline_already_breaks_does_not_block_a_scenario(client, token, project):
    _model(client, token)
    # Written through the parameter itself, the remainder is not checked: the baseline breaks its rule.
    r = client.post("/api/v1/params", json={"database": DB, "name": "share_rec", "amount": 0.9}, headers=token)
    assert r.status_code == 200, r.text
    assert _create(client, token, {"share_rec": 0.95}).status_code == 200


def test_one_value_set_into_a_scenario_warns_instead_of_refusing(client, token, project):
    _model(client, token)
    sid = _create(client, token, {"share_inc": 0.2}).json()["scenario"]["id"]
    r = client.post("/api/v1/scenarios/value", json={"id": sid, "param": "share_rec", "value": 1.0}, headers=token)
    assert r.status_code == 200, r.text
    warnings = r.json()["warnings"]
    assert len(warnings) == 1 and "'share_land'" in warnings[0] and "'share_inc'" not in warnings[0]


def test_a_value_equal_to_the_baseline_beside_others_is_kept_and_named(client, token, project):
    _model(client, token)
    r = _create(client, token, {"share_rec": 0.7, "share_inc": 0.1})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["redundant_overrides"] == ["share_rec"]
    assert body["scenario"]["overrides"] == {"share_rec": 0.7, "share_inc": 0.1}
    # Only baseline values: the baseline under another name, still refused.
    r = _create(client, token, {"share_rec": 0.7}, name="same")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "scenario_override_is_baseline"


def test_a_baseline_value_set_into_a_scenario_that_differs_is_kept(client, token, project):
    _model(client, token)
    sid = _create(client, token, {"share_inc": 0.1}).json()["scenario"]["id"]
    r = client.post("/api/v1/scenarios/value", json={"id": sid, "param": "share_rec", "value": 0.7}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["redundant_overrides"] == ["share_rec"]


def test_zero_under_a_positive_rule_names_the_way_out(client, token, project):
    _model(client, token)
    r = _create(client, token, {"delta_t_k": 0})
    assert r.status_code == 400
    err = r.json()["error"]
    assert err["code"] == "param_value_refused"
    assert "range from 0" in err["hint"] and "Parameters page" in err["hint"]
    # A negative number is simply wrong for it: no such advice.
    r = _create(client, token, {"delta_t_k": -3}, name="neg")
    assert "range from 0" not in r.json()["error"]["hint"]
