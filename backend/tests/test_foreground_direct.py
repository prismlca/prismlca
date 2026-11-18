"""The model's own emissions in the contribution tree's meta (``foreground_direct``).

The figure used to be summed over the nodes the tree opened, so it missed every process of the model the tree
did not: past the depth limit, below the cutoff, a loop's second round. It is read off the solved system now;
these tests pin exactly those cases, and that the inputs from outside the model and the model's own emissions
together make up the score.
"""
from __future__ import annotations

import pytest

from prism_lca.engine.bootstrap import get_bd

METHOD = ["t", "gwp"]
#: Exchange uids as the app writes them (32 hex digits).
U_ELEC = f"{1:032x}"
U_STEEL = f"{2:032x}"


def _bio(bd) -> None:
    bd.Database("bio").write(
        {("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Method(tuple(METHOD)).write([(("bio", "co2"), 1.0)])


def _proc(code, *, emits=0.0, inputs=(), production=1.0, db="fg"):
    exchanges = [{"input": (db, code), "amount": production, "type": "production"}]
    if emits:
        exchanges.append({"input": ("bio", "co2"), "amount": emits, "type": "biosphere"})
    for src, amount, *uid in inputs:
        ex = {"input": src, "amount": amount, "type": "technosphere"}
        if uid:
            ex["prism_uid"] = uid[0]
        exchanges.append(ex)
    return {"name": code, "unit": "unit", "exchanges": exchanges}


def _background(bd) -> None:
    """Electricity emits 0.5 per kWh; steel 2 itself plus 2 kWh."""
    bd.Database("bg").write(
        {
            ("bg", "elec"): _proc("elec", emits=0.5, db="bg"),
            ("bg", "steel"): _proc("steel", emits=2.0, inputs=[(("bg", "elec"), 2.0)], db="bg"),
        }
    )
    bd.databases["bg"]["prism_read_only"] = True
    bd.databases.flush()


def _meta(client, token, *, code="R", **options) -> dict:
    body = {"database": "fg", "code": code, "method": METHOD, **options}
    r = client.post("/api/v1/calc/contribution", json=body, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["meta"]


def test_processes_past_the_depth_limit_count(client, token, project):
    """M3 sits three steps below the root; a tree of depth 1 never opens it, but its 2 are the model's."""
    bd = get_bd()
    _bio(bd)
    _background(bd)
    bd.Database("fg").write(
        {
            ("fg", "M3"): _proc("M3", emits=2.0, inputs=[(("bg", "elec"), 1.0, U_ELEC)]),
            ("fg", "M2"): _proc("M2", inputs=[(("fg", "M3"), 1.0)]),
            ("fg", "M1"): _proc("M1", emits=1.0, inputs=[(("fg", "M2"), 1.0)]),
            ("fg", "R"): _proc("R", inputs=[(("fg", "M1"), 1.0)]),
        }
    )
    meta = _meta(client, token, max_depth=1)
    assert meta["total"] == pytest.approx(3.5)
    assert meta["foreground_direct"] == pytest.approx(3.0)


def test_processes_below_the_cutoff_count(client, token, project):
    """S carries 1 % of the score, under a 5 % cutoff: the tree does not open it, its emission still counts."""
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write(
        {
            ("fg", "M"): _proc("M", emits=99.0),
            ("fg", "S"): _proc("S", emits=1.0),
            ("fg", "R"): _proc("R", inputs=[(("fg", "M"), 1.0), (("fg", "S"), 1.0)]),
        }
    )
    meta = _meta(client, token, cutoff=0.05)
    assert meta["foreground_direct"] == pytest.approx(100.0)


def test_every_round_of_a_loop_counts(client, token, project):
    """A and B supply each other half a unit: one A demanded runs A 4/3 and B 2/3 times. The tree stopped at
    the repeated A and counted 1 + 0.5."""
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write(
        {
            ("fg", "A"): _proc("A", emits=1.0, inputs=[(("fg", "B"), 0.5)]),
            ("fg", "B"): _proc("B", emits=1.0, inputs=[(("fg", "A"), 0.5)]),
            ("fg", "R"): _proc("R", inputs=[(("fg", "A"), 1.0)]),
        }
    )
    meta = _meta(client, token)
    assert meta["total"] == pytest.approx(2.0)
    assert meta["foreground_direct"] == pytest.approx(2.0)


def test_background_emissions_are_not_the_models(client, token, project):
    """The model buys steel and emits nothing itself: zero, however much the steel carries."""
    bd = get_bd()
    _bio(bd)
    _background(bd)
    bd.Database("fg").write({("fg", "R"): _proc("R", inputs=[(("bg", "steel"), 1.0, U_STEEL)])})
    meta = _meta(client, token)
    assert meta["total"] == pytest.approx(3.0)
    assert meta["foreground_direct"] == pytest.approx(0.0, abs=1e-12)


def test_a_treatment_root_and_the_amount_scale_with_the_score(client, token, project):
    """A treatment (production −1) emitting 2 per run: treating 3 units emits 6, the sign the score has."""
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write({("fg", "W"): _proc("W", emits=2.0, production=-1.0)})
    meta = _meta(client, token, code="W", amount=3.0)
    assert meta["total"] == pytest.approx(6.0)
    assert meta["foreground_direct"] == pytest.approx(6.0)


def test_inputs_and_own_emissions_make_up_the_score(client, token, project):
    """Where no chain leaves the model and comes back, each input from outside it (by uid) plus what the model
    emits itself is the total, also where the tree is cut short and the model runs a process twice in a loop.
    Two exact figures from two computations, so this checks one against the other."""
    bd = get_bd()
    _bio(bd)
    _background(bd)
    bd.Database("fg").write(
        {
            ("fg", "A"): _proc("A", emits=1.0, inputs=[(("fg", "B"), 0.5), (("bg", "elec"), 4.0, U_ELEC)]),
            ("fg", "B"): _proc("B", emits=0.3, inputs=[(("fg", "A"), 0.25), (("bg", "steel"), 1.0, U_STEEL)]),
            ("fg", "R"): _proc("R", emits=0.2, inputs=[(("fg", "A"), 2.0)]),
        }
    )
    meta = _meta(client, token, max_depth=2, cutoff=0.2)
    assert set(meta["inputs"]) == {U_ELEC, U_STEEL}
    # Each figure is rounded to six significant digits on its own, so the sum agrees to that.
    assert sum(meta["inputs"].values()) + meta["foreground_direct"] == pytest.approx(meta["total"], rel=1e-5)


def test_a_chain_back_into_the_model_counts_once(client, token, project):
    """R buys from another model, whose process P buys S from R's model. S's 1 is R's model's own emission and
    P's 0.5 is not: what arises outside the model is the total minus the model's own, exactly."""
    bd = get_bd()
    _bio(bd)
    s = {("fg", "S"): _proc("S", emits=1.0)}
    bd.Database("fg").write(s)  # each database links into the other: S first, then P, then R
    bd.Database("other").write({("other", "P"): _proc("P", emits=0.5, inputs=[(("fg", "S"), 1.0)], db="other")})
    bd.Database("fg").write({**s, ("fg", "R"): _proc("R", inputs=[(("other", "P"), 1.0, U_ELEC)])})
    bd.Database("other").process()  # the rewrite gave S a new id; P's matrix entry has to follow it
    meta = _meta(client, token)
    assert meta["total"] == pytest.approx(1.5)
    assert meta["foreground_direct"] == pytest.approx(1.0)
