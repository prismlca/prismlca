"""The refusal for scenario ids that name no scenario (engine/scenario_lookup.py), on plain data."""
from __future__ import annotations

import pytest

from prism_lca.engine import scenario_lookup as sl
from prism_lca.errors import PrismError

DB = "m"


def _data(n: int, db: str = DB) -> dict[str, dict]:
    return {f"{i:032x}": {"id": f"{i:032x}", "name": f"Variant {i}", "database": db} for i in range(1, n + 1)}


def _refusal(data, ids, database=DB) -> PrismError:
    with pytest.raises(PrismError) as e:
        sl.require(data, ids, database)
    return e.value


def test_an_invented_id_gets_no_suggestion_only_the_list():
    err = _refusal(_data(3), ["eco-80-rpet"])
    assert "Closest" not in err.message and "is the name" not in err.message
    assert err.hint.startswith("Scenarios of 'm' (all 3): ") and "'Variant 2' = " in err.hint


def test_every_missing_id_is_named_in_one_refusal():
    data = _data(2)
    err = _refusal(data, ["nope-a", next(iter(data)), "nope-b"])
    assert err.message.startswith("Scenarios 'nope-a', 'nope-b' do not exist")


def test_a_long_list_is_cut_and_counted_and_other_models_stay_out():
    data = {**_data(15), **{"f" * 32: {"id": "f" * 32, "name": "Elsewhere", "database": "other"}}}
    err = _refusal(data, ["x"])
    assert err.hint.startswith("Scenarios of 'm' (first 12 of 15): ") and "; the rest via list_scenarios." in err.hint
    assert "Elsewhere" not in err.hint


def test_a_model_without_scenarios_is_told_how_to_make_one():
    err = _refusal({}, ["x"])
    assert err.hint == "'m' has no scenarios yet. Create one with edit_scenario."


def test_found_ids_come_back_in_the_order_asked():
    data = _data(3)
    ids = list(data)[::-1]
    assert [s["id"] for s in sl.require(data, ids, DB)] == ids


def test_without_a_model_it_suggests_but_lists_nothing():
    data = {**_data(2), **{"f" * 32: {"id": "f" * 32, "name": "Elsewhere", "database": "other"}}}
    err = _refusal(data, ["f" * 30 + "00"], database=None)
    assert f"Closest id to '{'f' * 30 + '00'}': '{'f' * 32}' ('Elsewhere')" in err.message
    assert err.hint == "list_scenarios lists the scenarios of a model with their ids."
