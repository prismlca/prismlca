"""The note on a compared scenario that barely moved the result (engine/scenario_reach.py).

The ordinary reason comes first — the chain from the override to the exchange it reaches, and that exchange's
share of the baseline result — and a request to bind only where something says a binding is missing.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd

METHOD = ["test", "gwp"]
DB = "fg"


def _seed(bd) -> None:
    """bottle: 2 kWh electricity (0.5 kg CO2 each), (mass + water_kg) × dist / 1000 tkm by truck (0.001 kg CO2
    each), 3.5 kg tap water typed as a plain number, 0.1 kg CO2 of its own. `spare` uses the truck too, but
    nothing consumes `spare`."""
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )

    def supplier(code, name, unit, co2):
        return {
            "name": name, "unit": unit, "reference product": name,
            "exchanges": [
                {"input": ("fg", code), "amount": 1, "type": "production"},
                {"input": ("biosphere", "co2"), "amount": co2, "type": "biosphere"},
            ],
        }

    bd.Database("fg").write(
        {
            ("fg", "elec"): supplier("elec", "electricity", "kWh", 0.5),
            ("fg", "truck"): supplier("truck", "transport, lorry", "tkm", 0.001),
            ("fg", "water"): supplier("water", "tap water", "kg", 0.001),
            ("fg", "bottle"): {
                "name": "bottle", "unit": "unit", "reference product": "bottle",
                "exchanges": [
                    {"input": ("fg", "bottle"), "amount": 1, "type": "production", "prism_uid": "p"},
                    {"input": ("fg", "elec"), "amount": 0.0, "type": "technosphere", "prism_uid": "e"},
                    {"input": ("fg", "truck"), "amount": 0.0, "type": "technosphere", "prism_uid": "t"},
                    {"input": ("fg", "water"), "amount": 3.5, "type": "technosphere", "prism_uid": "w"},
                    {"input": ("biosphere", "co2"), "amount": 0.1, "type": "biosphere"},
                ],
            },
            ("fg", "spare"): {
                "name": "spare part", "unit": "unit", "reference product": "spare part",
                "exchanges": [
                    {"input": ("fg", "spare"), "amount": 1, "type": "production"},
                    {"input": ("fg", "truck"), "amount": 0.0, "type": "technosphere", "prism_uid": "s"},
                ],
            },
        }
    )
    bd.databases["fg"]["prism_read_only"] = False
    bd.databases.flush()
    bd.Method(("test", "gwp")).write([(("biosphere", "co2"), 1.0)])


def _param(client, token, name, **body) -> None:
    r = client.post("/api/v1/params", json={"database": DB, "name": name, **body}, headers=token)
    assert r.status_code == 200, r.text


def _formula(client, token, code, uid, formula) -> None:
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": DB, "activity_code": code, "uid": uid, "formula": formula},
        headers=token,
    )
    assert r.status_code == 200, r.text


def _model(client, token) -> None:
    _seed(get_bd())
    _param(client, token, "kwh", amount=2.0)
    _param(client, token, "mass", amount=20.0)
    _param(client, token, "water_kg", amount=3.5)
    _param(client, token, "dist", amount=300.0)
    _param(client, token, "unused", amount=1.0)
    _param(client, token, "spare_tkm", amount=5.0)
    _param(client, token, "tkm", formula="(mass + water_kg) * dist / 1000")
    _formula(client, token, "bottle", "e", "kwh")
    _formula(client, token, "bottle", "t", "tkm")
    _formula(client, token, "spare", "s", "spare_tkm")


def _note(client, token, overrides: dict) -> str:
    r = client.post("/api/v1/scenarios", json={"database": DB, "name": "variant", "overrides": overrides}, headers=token)
    assert r.status_code == 200, r.text
    sid = r.json()["scenario"]["id"]
    r = client.post(
        "/api/v1/scenarios/compare",
        json={"database": DB, "code": "bottle", "method": METHOD, "scenario_ids": [sid]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    row = next(x for x in r.json()["results"] if x["scenario"] == "variant")
    assert abs(row["delta_pct"]) < 1.0
    return row["note"]


def test_a_bound_chain_on_a_small_part_says_so_and_asks_for_nothing(client, token, project):
    """The ordinary case: the distance reaches the truck through `tkm`, and the truck is half a percent of the
    result. The note used to answer that with "if it is still a typed constant, bind it" — read, twice in
    one run, as a fault in a correctly bound model."""
    _model(client, token)
    note = _note(client, token, {"dist": 100.0})
    assert note.startswith(
        "Δ below 1 % — 'dist' reaches 1 exchange: 'transport, lorry' in 'bottle' through tkm, 0.63 % of the "
        "baseline result."
    )
    assert note.endswith("A small part of the result, so a small Δ is the expected outcome.")
    assert "bind" not in note and "set_formula" not in note


def test_a_typed_constant_carrying_a_moved_parameters_value_is_named_with_the_request_to_bind(
    client, token, project
):
    """The case the note exists for (V332): the water exchange is typed as 3.5, the value of `water_kg`, so
    the variant moves only the transport that happens to use it. Named with the exchange, not as a maybe."""
    _model(client, token)
    note = _note(client, token, {"water_kg": 4.0})
    assert "'water_kg' reaches 1 exchange: 'transport, lorry' in 'bottle' through tkm" in note
    assert (
        "But 'tap water' in 'bottle' is typed as 3.5, the value of 'water_kg', and does not follow it: if they "
        'are one quantity, bind it (edit_exchange action="set_formula") and compare again.'
    ) in note
    assert "expected outcome" not in note


def test_a_parameter_reaching_no_exchange_is_still_asked_to_be_bound(client, token, project):
    _model(client, token)
    note = _note(client, token, {"unused": 2.0})
    assert note == (
        "Δ below 1 % — no exchange formula references 'unused', directly or through other parameters; this "
        'variant cannot move the result. Bind the quantity to the parameter (edit_exchange action="set_formula") '
        "and compare again, or drop the scenario."
    )


def test_overrides_that_reach_only_a_process_outside_the_supply_chain_say_so(client, token, project):
    _model(client, token)
    note = _note(client, token, {"spare_tkm": 6.0})
    assert "'spare_tkm' reaches 1 exchange: 'transport, lorry' in 'spare part', 0 % of the baseline result." in note
    assert note.endswith(
        "None of them is in the supply chain of the scored activity, so this variant cannot move its result: "
        "score the activity that uses them, or link their process into it."
    )


def test_a_dead_override_beside_a_live_one_is_named_and_a_large_share_draws_no_conclusion(client, token, project):
    """`kwh` drives 90 % of the result; nudged by 0.5 % it moves the result by less than 1 %. The note gives
    the share and leaves the reading to the caller — and names the override that reaches nothing."""
    _model(client, token)
    note = _note(client, token, {"kwh": 2.01, "unused": 2.0})
    assert note == (
        "Δ below 1 % — 'kwh' reaches 1 exchange: 'electricity' in 'bottle', 90 % of the baseline result. "
        "'unused' reaches none."
    )


def test_a_chain_through_a_parameter_the_scenario_also_overrides_is_not_followed(client, token, project):
    """With `tkm` fixed by the same scenario, `dist` reaches nothing through it while the scenario is applied."""
    _model(client, token)
    note = _note(client, token, {"dist": 301.0, "tkm": 6.85})
    assert note.startswith("Δ below 1 % — 'tkm' reaches 1 exchange: 'transport, lorry' in 'bottle', ")
    assert "'dist' reaches none." in note


def test_a_formula_override_that_reads_another_override_carries_the_chain_through(client, token, project):
    """`tkm` overridden by a formula over `dist` is still fed by `dist` while the scenario is applied — the
    chain follows the formulas as they stand in the scenario, not the baseline's."""
    _model(client, token)
    note = _note(client, token, {"dist": 301.0, "tkm": "dist * 0.0235"})
    assert note.startswith(
        "Δ below 1 % — 'dist', 'tkm' reach 1 exchange: 'transport, lorry' in 'bottle' through tkm, "
    )
    assert "reaches none" not in note


def test_a_parameter_bound_to_a_production_amount_is_reached_and_given_no_share(client, token, project):
    """A formula on the reference amount is a binding too; it scales everything the process does, so no share
    of the result is named for it — and no conclusion drawn."""
    _model(client, token)
    _param(client, token, "yield_units", amount=1.0)
    _formula(client, token, "bottle", "p", "yield_units")
    note = _note(client, token, {"yield_units": 1.005})
    assert note == "Δ below 1 % — 'yield_units' reaches 1 exchange: the production amount of 'bottle'."


def test_an_exchange_on_a_loop_through_the_model_is_given_no_share(client, token, project):
    """Electricity consuming a tenth of itself: runs × amount × cumulative impact counts the loop again on
    every pass and would print a share far above what the exchange contributes. (The bottle's 0.1 kg of CO2
    equals `losses`; an emission is not matched as a typed constant to bind.)"""
    _model(client, token)
    elec = get_bd().get_node(database=DB, code="elec")
    elec.new_exchange(input=elec, amount=0.0, type="technosphere", prism_uid="l").save()
    _param(client, token, "losses", amount=0.1)
    _formula(client, token, "elec", "l", "losses")
    note = _note(client, token, {"losses": 0.1001})
    assert note == "Δ below 1 % — 'losses' reaches 1 exchange: 'electricity' in 'electricity'."
