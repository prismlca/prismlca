"""Why two results differ: the split of the difference onto the changes (engine/difference*.py), on the model of
``difference_model`` — every shape the split has to get right.

Every split is held to the difference of two calculations made apart from it — each on a fresh bw2calc LCA,
never the cache the split reads — to 1e-9 of the larger score.
"""
from __future__ import annotations

import pytest
from difference_model import (
    CH4,
    DB,
    GWP,
    add_scenario,
    build_model,
    copy_model,
    edit_copy,
    fresh_score,
)

from prism_lca.engine import difference, lca, param_window, scenarios
from prism_lca.engine import difference_terms as terms
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.difference_pairing import COPIED_FROM
from prism_lca.engine.scenarios import ScenarioStore

RTOL = 1e-9


@pytest.fixture(autouse=True)
def _clean():
    yield
    param_window.reset_for_tests()


def _split(database: str, code: str, method: tuple, scenario: str | None = None, *, against: dict | None = None,
           amount: float = 1.0) -> terms.Split:
    """The split at full precision, read the way ``difference.explain`` reads it."""
    store = ScenarioStore()
    act = get_bd().get_node(database=database, code=code)
    ref_db, ref_code, ref_scenario, ref_amount, pairing = difference._reference(act, amount, against or {})
    with lca._LCA_LOCK:
        ref = difference._read(store, ref_db, ref_code, ref_scenario, [method], ref_amount, reference=True)
        sub = difference._read(store, database, code, scenario, [method], amount, reference=False)
    moved = terms.move(ref, sub, terms.place(ref, sub, pairing.nodes if pairing else None))
    return terms.split(ref, sub, moved, method)


def _held_to(part: terms.Split, before: float, after: float) -> None:
    """The split adds up to the difference of two calculations made apart from it."""
    scale = max(abs(before), abs(after))
    assert abs(part.reference - before) <= RTOL * scale
    assert abs(part.subject - after) <= RTOL * scale
    assert abs(part.explained - (after - before)) <= RTOL * scale, (part.explained, after - before)
    assert part.exact


SCENARIOS = {
    "yield": {"yield_part": 0.8},  # a production amount
    "loop": {"r_share": 0.6},  # the loop through recycle
    "credit": {"credit_kwh": 0.9},  # a substitution
    "leak": {"leak": 0.01},  # an emission
    "replaced": {"d": 1.0},  # replaces the formula `2 * kwh_part`
    "formula": {"kwh_part": "n_parts * 1.5"},  # a formula override, moving `d` with it
    "steel": {"steel_kg": 0.9, "steel_extra": 0.0},  # two of three exchanges on one pair
    "all": {"yield_part": 1.25, "r_share": 0.1, "credit_kwh": 0.0, "leak": 0.0, "d": 9.0, "n_parts": 3.0},
}


@pytest.mark.parametrize("name", sorted(SCENARIOS))
@pytest.mark.parametrize("method", [GWP, CH4])
def test_a_scenario_split_adds_up_to_two_calculations_made_apart(client, token, project, name, method):
    build_model(client, token)
    sid = add_scenario(client, token, name, SCENARIOS[name])
    before = fresh_score(DB, "product", method)
    with scenarios.applied(ScenarioStore(), DB, sid):
        after = fresh_score(DB, "product", method)
    if method == GWP:  # some variants move only CO2, and the methane indicator stays put — split to nothing
        assert after != before
    _held_to(_split(DB, "product", method, sid), before, after)


def test_a_treatment_scored_with_the_demand_turned_round_splits_too(client, token, project):
    build_model(client, token)
    sid = add_scenario(client, token, "burn", {"burn_co2": 3.5})
    before = fresh_score(DB, "waste", GWP, amount=2.0)
    with scenarios.applied(ScenarioStore(), DB, sid):
        after = fresh_score(DB, "waste", GWP, amount=2.0)
    part = _split(DB, "waste", GWP, sid, amount=2.0)
    _held_to(part, before, after)
    assert after - before == pytest.approx(2.0 * 1.0)  # two kg treated, one more kg of CO2 each


def test_one_bound_emission_is_named_with_its_formula_and_carries_the_whole_difference(client, token, project):
    build_model(client, token)
    sid = add_scenario(client, token, "leaky", {"leak": 0.012})
    r = client.post("/api/v1/calc/difference",
                    json={"database": DB, "code": "product", "method": list(GWP), "scenario": sid}, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reference"]["code"] == "product" and "scenario" not in body["reference"]
    (result,) = body["results"]
    assert result["subject"]["scenario"] == "leaky"
    (block,) = result["indicators"]
    assert block["exact"] is True
    (change,) = block["changes"]
    assert change["process"] == "part" and change["exchange"] == "CH4 (air)"
    assert change["kind"] == "elementary flow" and change["formula"] == "leak"
    assert (change["before"], change["after"]) == (0.002, 0.012)
    assert change["share_pct"] == 100.0
    # 4 parts per product run, the product running 1/(1 − 0.25·0.01) times through the recycling loop,
    # 28 per kg of methane, 0.01 kg more of it per part
    runs = 4 / (1 - 0.25 * 0.01)
    assert block["delta"] == pytest.approx(runs * 28 * 0.01)
    assert change["runs"] == pytest.approx(runs, rel=1e-5)  # six significant figures in the answer


def test_exchanges_summed_on_one_pair_are_one_change_with_the_sum_before_and_after(client, token, project):
    build_model(client, token)
    sid = add_scenario(client, token, "steel", {"steel_kg": 0.9})
    r = client.post("/api/v1/calc/difference",
                    json={"database": DB, "code": "product", "method": list(GWP), "scenario": sid}, headers=token)
    (block,) = r.json()["results"][0]["indicators"]
    (change,) = block["changes"]
    assert change["exchange"] == "steel" and change["kind"] == "input" and "location" not in change
    assert (change["before"], change["after"]) == (pytest.approx(0.8), pytest.approx(1.2))
    assert "formula" not in change  # three exchanges hold the pair: no one formula is its own


def test_a_credit_is_named_as_one_with_its_amount_as_the_exchange_states_it(client, token, project):
    build_model(client, token)
    sid = add_scenario(client, token, "credit", {"credit_kwh": 0.9})
    r = client.post("/api/v1/calc/difference",
                    json={"database": DB, "code": "product", "method": list(GWP), "scenario": sid}, headers=token)
    (block,) = r.json()["results"][0]["indicators"]
    (change,) = block["changes"]
    assert change["kind"] == "credit" and change["exchange"] == "power"
    assert (change["before"], change["after"]) == (pytest.approx(0.3), pytest.approx(0.9))
    assert change["contribution"] < 0  # more avoided power, a lower result


def test_several_scenarios_and_indicators_in_one_request(client, token, project):
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.004})
    b = add_scenario(client, token, "b", {"n_parts": 5.0, "r_share": 0.3})
    r = client.post("/api/v1/calc/difference", json={
        "database": DB, "code": "product", "methods": [list(GWP), list(CH4), ["no", "such"]],
        "scenarios": [a, b], "partial": True, "top_n": 1,
    }, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["subject"]["scenario"] for x in body["results"]] == ["a", "b"]
    assert [len(x["indicators"]) for x in body["results"]] == [2, 2]
    assert body["not_computed"][0]["method"] == ["no", "such"]
    gwp_b = body["results"][1]["indicators"][0]
    assert len(gwp_b["changes"]) == 1 and gwp_b["more"]["count"] == 1
    total = sum(c["contribution"] for c in gwp_b["changes"]) + gwp_b["more"]["contribution"]
    assert total == pytest.approx(gwp_b["delta"], rel=1e-5)


def test_the_same_result_twice_is_refused_and_so_is_another_process_of_the_model(client, token, project):
    build_model(client, token)
    r = client.post("/api/v1/calc/difference",
                    json={"database": DB, "code": "product", "method": list(GWP)}, headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "difference_same"
    sid = add_scenario(client, token, "x", {"leak": 0.01})
    r = client.post("/api/v1/calc/difference", json={
        "database": DB, "code": "product", "method": list(GWP), "scenario": sid,
        "against": {"code": "part"},
    }, headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "difference_unpaired"


def test_a_scenario_against_another_scenario(client, token, project):
    build_model(client, token)
    a = add_scenario(client, token, "a", {"leak": 0.004, "n_parts": 5.0})
    b = add_scenario(client, token, "b", {"leak": 0.02})
    with scenarios.applied(ScenarioStore(), DB, a):
        before = fresh_score(DB, "product", GWP)
    with scenarios.applied(ScenarioStore(), DB, b):
        after = fresh_score(DB, "product", GWP)
    _held_to(_split(DB, "product", GWP, b, against={"scenario": a}), before, after)


# --- a copy against its original --------------------------------------------------------------------- #

def test_a_copy_against_its_original_adds_up_and_names_what_is_new_and_gone(client, token, project):
    build_model(client, token)
    codes = copy_model(client, token)
    edit_copy(client, token, codes)
    before = fresh_score(DB, "product", GWP)
    after = fresh_score("fx copy", codes["product"], GWP)
    _held_to(_split("fx copy", codes["product"], GWP, against={"database": DB}), before, after)

    r = client.post("/api/v1/calc/difference", json={
        "database": "fx copy", "code": codes["product"], "method": list(GWP), "against": {"database": DB},
    }, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reference"] == {"database": DB, "code": "product", "name": "product", "amount": 1.0}
    assert body["pairing"] == {"paired": 3, "only_in_subject": ["paint"], "only_in_reference": ["recycle"]}
    (block,) = body["results"][0]["indicators"]
    assert block["exact"] is True
    named = {(c["process"], c.get("exchange")): c for c in block["changes"]}
    assert named[("paint", "CO2 (air)")]["contribution"] == pytest.approx(0.2 * 3.0)
    assert named[("product", "steel")]["before"] == pytest.approx(0.8)
    assert named[("product", "steel")]["after"] == pytest.approx(1.0)
    assert named[("product", "recycle")]["after"] == 0.0


def test_a_copy_without_the_record_is_paired_by_name(client, token, project):
    build_model(client, token)
    codes = copy_model(client, token)
    for act in get_bd().Database("fx copy"):
        del act[COPIED_FROM]
        act.save()
    edit_copy(client, token, codes)
    part = _split("fx copy", codes["product"], GWP, against={"database": DB})
    _held_to(part, fresh_score(DB, "product", GWP), fresh_score("fx copy", codes["product"], GWP))
    r = client.post("/api/v1/calc/difference", json={
        "database": "fx copy", "code": codes["product"], "method": list(GWP), "against": {"database": DB},
    }, headers=token)
    assert r.json()["pairing"] == {"paired": 3, "paired_by_name": 3, "only_in_subject": ["paint"],
                                   "only_in_reference": ["recycle"]}


def test_the_original_against_its_copy_reads_the_record_the_other_way_round(client, token, project):
    build_model(client, token)
    codes = copy_model(client, token)
    edit_copy(client, token, codes)
    r = client.post("/api/v1/calc/difference", json={
        "database": DB, "code": "product", "method": list(GWP), "against": {"database": "fx copy"},
    }, headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reference"]["code"] == codes["product"]
    assert body["pairing"]["paired"] == 3 and "paired_by_name" not in body["pairing"]
    _held_to(_split(DB, "product", GWP, against={"database": "fx copy"}),
             fresh_score("fx copy", codes["product"], GWP), fresh_score(DB, "product", GWP))


def test_a_scenario_of_the_copy_against_the_original(client, token, project):
    build_model(client, token)
    codes = copy_model(client, token)
    sid = add_scenario(client, token, "lean", {"n_parts": 2.0, "leak": 0.05}, database="fx copy")
    before = fresh_score(DB, "product", GWP)
    with scenarios.applied(ScenarioStore(), "fx copy", sid):
        after = fresh_score("fx copy", codes["product"], GWP)
    _held_to(_split("fx copy", codes["product"], GWP, sid, against={"database": DB}), before, after)
    # A change on an input from another process of the copy is named by the copy's own exchange, formula and all —
    # not by the original's process that stands on the same place.
    r = client.post("/api/v1/calc/difference", json={
        "database": "fx copy", "code": codes["product"], "method": list(GWP), "scenario": sid,
        "against": {"database": DB},
    }, headers=token)
    (block,) = r.json()["results"][0]["indicators"]
    parts = next(c for c in block["changes"] if c["exchange"] == "part")
    assert parts["kind"] == "input" and parts["formula"] == "n_parts" and parts["location"] == "GLO"
    assert (parts["before"], parts["after"]) == (4.0, 2.0)


def test_a_process_without_counterpart_needs_its_reference_named(client, token, project):
    build_model(client, token)
    codes = copy_model(client, token)
    edit_copy(client, token, codes)
    paint = next(a for a in get_bd().Database("fx copy") if a.get("name") == "paint").key[1]
    r = client.post("/api/v1/calc/difference", json={
        "database": "fx copy", "code": paint, "method": list(GWP), "against": {"database": DB},
    }, headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "difference_unpaired"


@pytest.mark.parametrize("original_first", [True, False])
def test_a_place_is_named_by_the_subjects_process_whichever_row_comes_first(original_first):
    """In a copy's system the original's processes stand beside the copy's; the place a pair shares is named by
    the copy's process, so its own exchange (formula, kind) is the one read — in either order of the rows."""
    import numpy as np
    from scipy.sparse import identity

    ids = [1, 2, 3, 4, 5] if original_first else [1, 4, 5, 2, 3]  # 1 background, 2/3 original, 4/5 copy
    index = {node: i for i, node in enumerate(ids)}

    def side() -> terms.Side:
        eye = identity(5, format="csc")
        return terms.Side(technosphere=eye, biosphere=eye[:1, :], supply=np.ones(5), demand={},
                          activity=dict(index), product=dict(index), flow={9: 0})

    placing = terms.place(side(), side(), {4: 2, 5: 3})
    assert placing.row_node[index[2]] == 4 and placing.row_node[index[3]] == 5
    assert placing.col_node[index[2]] == 4 and placing.col[index[2]] == -1  # the original's own column set aside


def test_a_flow_only_the_copy_emits_and_a_credit_it_dropped_are_named_as_what_they_are(client, token, project):
    """A copy that emits a flow nothing in the original emits: the original's inventory has no row for it, and its
    impact used to fall into "not explained". A credit the copy deleted is found on the original's side, so it is
    named a credit, with the amount it had."""
    build_model(client, token)
    codes = copy_model(client, token)
    name = "fx copy"
    r = client.post("/api/v1/model/exchanges", json={
        "activity_database": name, "activity_code": codes["product"], "input_database": "bio", "input_code": "n2o",
        "amount": 0.01, "type": "biosphere"}, headers=token)
    assert r.status_code == 200, r.text
    product = get_bd().get_node(database=name, code=codes["product"])
    credit = next(ex for ex in product.exchanges() if ex.get("type") == "substitution")
    r = client.post("/api/v1/model/exchanges/remove", json={
        "activity_database": name, "activity_code": codes["product"], "uid": credit["prism_uid"]}, headers=token)
    assert r.status_code == 200, r.text
    before, after = fresh_score(DB, "product", GWP), fresh_score(name, codes["product"], GWP)
    _held_to(_split(name, codes["product"], GWP, against={"database": DB}), before, after)

    r = client.post("/api/v1/calc/difference", json={
        "database": name, "code": codes["product"], "method": list(GWP), "against": {"database": DB},
    }, headers=token)
    (block,) = r.json()["results"][0]["indicators"]
    assert block["exact"] is True
    named = {c["exchange"]: c for c in block["changes"]}
    runs = 1 / (1 - 0.25 * 0.01)
    assert named["N2O (air)"]["kind"] == "elementary flow"
    assert named["N2O (air)"]["contribution"] == pytest.approx(runs * 0.01 * 273.0, rel=1e-5)
    assert named["power"]["kind"] == "credit"
    assert (named["power"]["before"], named["power"]["after"]) == (pytest.approx(0.3), 0.0)
    assert named["power"]["contribution"] > 0  # the avoided power no longer avoided: a higher result
