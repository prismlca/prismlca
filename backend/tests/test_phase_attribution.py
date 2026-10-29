"""Exact attribution of results to tag values (life-cycle phases).

The breakdown by tag used to be read off the pruned contribution tree: exact in the total, but a cycle in
the foreground, a small subtree under the cutoff or a subtree that nets to zero put impact into the wrong
phase. These tests pin the cases the tree got wrong, and the tags on inputs (exchange keys) that the
breakdown has to honour.
"""
from __future__ import annotations

import pytest

from prism_lca.engine.bootstrap import get_bd

METHOD = ["t", "gwp"]
METHOD_2 = ["t", "double"]
#: Exchange uids as the app writes them (32 hex digits) — only those are read as an input's tag key.
U = {n: f"{i:032x}" for i, n in enumerate(["u-steel", "u-elec", "u-m", "u-w", "u-x"], start=1)}


def _bio(bd) -> None:
    bd.Database("bio").write(
        {("bio", "co2"): {"name": "CO2", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Method(tuple(METHOD)).write([(("bio", "co2"), 1.0)])
    bd.Method(tuple(METHOD_2)).write([(("bio", "co2"), 2.0)])


def _proc(code, name, *, emits=0.0, inputs=(), production=1.0, db="fg"):
    exchanges = [{"input": (db, code), "amount": production, "type": "production"}]
    if emits:
        exchanges.append({"input": ("bio", "co2"), "amount": emits, "type": "biosphere"})
    for inp in inputs:
        src, amount, *rest = inp
        ex = {"input": src, "amount": amount, "type": "technosphere"}
        if rest:
            ex["prism_uid"] = rest[0]
        exchanges.append(ex)
    return {"name": name, "unit": "unit", "exchanges": exchanges}


def _background(bd, data: dict) -> None:
    bd.Database("bg").write(data)
    bd.databases["bg"]["prism_read_only"] = True
    bd.databases.flush()


def _tag(client, token, code, value, group="Phase", db="fg"):
    r = client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": db, "code": code}], "group": group, "value": value},
        headers=token,
    )
    assert r.status_code == 200, r.text


def _tag_input(consumer, uid, value, group="Phase", db="fg"):
    """An input's tag, written straight into the store under the exchange key the API will use."""
    from prism_lca.engine.tags import TagStore

    TagStore().set_tag(db, f"{consumer}#{uid}", group, value)


def _groups(client, token, *, code="R", cutoff=None, max_depth=None) -> dict[str, float]:
    body = {"database": "fg", "code": code, "method": METHOD, "aggregate_by": "tag:Phase"}
    if cutoff is not None:
        body["cutoff"] = cutoff
    if max_depth is not None:
        body["max_depth"] = max_depth
    r = client.post("/api/v1/calc/contribution", json=body, headers=token)
    assert r.status_code == 200, r.text
    return {g["key"]: g["impact"] for g in r.json()["aggregation"]["groups"]}


def _stacked(client, token, *, code="R", methods=(METHOD,), cutoff=None) -> dict[str, dict[str, float]]:
    body = {"subjects": [{"database": "fg", "code": code}], "methods": list(methods), "dimensions": ["tag:Phase"]}
    if cutoff is not None:
        body["cutoff"] = cutoff
    r = client.post("/api/v1/calc/compare-stacked", json=body, headers=token)
    assert r.status_code == 200, r.text
    out = {}
    for m in methods:
        dims = r.json()["subjects"][0]["methods"][" · ".join(m)]["dims"]["tag:Phase"]
        out[" · ".join(m)] = {g["key"]: g["impact"] for g in dims}
    return out


def _close(groups: dict, expected: dict) -> None:
    for key, value in expected.items():
        assert groups.get(key, 0.0) == pytest.approx(value, rel=1e-5, abs=1e-9), (key, groups)
    extra = {k: v for k, v in groups.items() if k not in expected and abs(v) > 1e-9}
    assert not extra, extra


def test_a_cycle_in_the_foreground_is_attributed_exactly(client, token, project):
    """A and B supply each other half a unit and emit one each. One A demanded means 4/3 runs of A and
    2/3 of B; the tree stopped at the repeated A and booked its remainder to A (1.5 / 0.5)."""
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write(
        {
            ("fg", "A"): _proc("A", "A", emits=1.0, inputs=[(("fg", "B"), 0.5)]),
            ("fg", "B"): _proc("B", "B", emits=1.0, inputs=[(("fg", "A"), 0.5)]),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "A"), 1.0)]),
        }
    )
    _tag(client, token, "A", "PA")
    _tag(client, token, "B", "PB")
    expected = {"PA": 4 / 3, "PB": 2 / 3}
    _close(_groups(client, token), expected)
    _close(_stacked(client, token)[" · ".join(METHOD)], expected)


def test_a_tag_below_a_pruned_subtree_still_counts(client, token, project):
    """S is under the cutoff and untagged; T below it is tagged. The tree booked T to the phase above."""
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write(
        {
            ("fg", "T"): _proc("T", "T", emits=1.0),
            ("fg", "S"): _proc("S", "S", inputs=[(("fg", "T"), 1.0)]),
            ("fg", "M"): _proc("M", "M", emits=99.0, inputs=[(("fg", "S"), 1.0)]),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "M"), 1.0)]),
        }
    )
    _tag(client, token, "M", "Production")
    _tag(client, token, "T", "Packaging")
    expected = {"Production": 99.0, "Packaging": 1.0}
    _close(_groups(client, token, cutoff=0.05), expected)
    _close(_stacked(client, token, cutoff=0.05)[" · ".join(METHOD)], expected)
    _close(_groups(client, token, max_depth=1), expected)


def test_a_subtree_that_nets_to_zero_keeps_both_phases(client, token, project):
    """H buys one T1 and sells one T2 back: zero in sum, one unit in each of two phases."""
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write(
        {
            ("fg", "T1"): _proc("T1", "T1", emits=1.0),
            ("fg", "T2"): _proc("T2", "T2", emits=1.0),
            ("fg", "H"): _proc("H", "H", inputs=[(("fg", "T1"), 1.0), (("fg", "T2"), -1.0)]),
            ("fg", "M"): _proc("M", "M", emits=5.0, inputs=[(("fg", "H"), 1.0)]),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "M"), 1.0)]),
        }
    )
    _tag(client, token, "M", "Production")
    _tag(client, token, "T1", "X")
    _tag(client, token, "T2", "Y")
    _close(_groups(client, token), {"Production": 5.0, "X": 1.0, "Y": -1.0})


def test_a_tag_on_a_background_input_moves_exactly_that_input(client, token, project):
    """Steel and electricity both hang on Manufacturing. Only the steel input carries Raw materials; the
    electricity input inherits Production, including the electricity inside the steel's own chain."""
    bd = get_bd()
    _bio(bd)
    _background(
        bd,
        {
            ("bg", "elec"): _proc("elec", "electricity", emits=0.5, db="bg"),
            ("bg", "steel"): _proc("steel", "steel", emits=2.0, inputs=[(("bg", "elec"), 2.0)], db="bg"),
        },
    )
    bd.Database("fg").write(
        {
            ("fg", "M"): _proc(
                "M", "Manufacturing", emits=1.0,
                inputs=[(("bg", "steel"), 1.0, U["u-steel"]), (("bg", "elec"), 4.0, U["u-elec"])],
            ),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "M"), 1.0, U["u-m"])]),
        }
    )
    _tag(client, token, "M", "Production")
    _tag_input("M", U["u-steel"], "Raw materials")
    # steel: 2 + 2·0.5 = 3; Manufacturing: its own 1 + 4·0.5 electricity = 3
    expected = {"Raw materials": 3.0, "Production": 3.0}
    _close(_groups(client, token), expected)
    _close(_stacked(client, token)[" · ".join(METHOD)], expected)


def test_a_tag_on_a_background_dataset_itself_counts_for_nothing(client, token, project):
    """Older stores may hold a tag keyed on an ecoinvent dataset. It must not act in the breakdown."""
    from prism_lca.engine.tags import TagStore

    bd = get_bd()
    _bio(bd)
    _background(bd, {("bg", "elec"): _proc("elec", "electricity", emits=1.0, db="bg")})
    bd.Database("fg").write(
        {
            ("fg", "M"): _proc("M", "M", inputs=[(("bg", "elec"), 1.0, U["u-elec"])]),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "M"), 1.0)]),
        }
    )
    _tag(client, token, "M", "Production")
    TagStore().set_tag("bg", "elec", "Phase", "Use")
    _close(_groups(client, token), {"Production": 1.0})


def test_a_treatment_input_keeps_its_sign_and_its_phase(client, token, project):
    """A waste treatment has a negative reference flow; its consumer books a negative input."""
    bd = get_bd()
    _bio(bd)
    _background(bd, {("bg", "w"): _proc("w", "waste treatment", emits=1.0, production=-1.0, db="bg")})
    bd.Database("fg").write(
        {
            ("fg", "M"): _proc("M", "M", emits=2.0, inputs=[(("bg", "w"), -0.5, U["u-w"])]),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "M"), 1.0)]),
        }
    )
    _tag(client, token, "M", "Production")
    _tag_input("M", U["u-w"], "End of life")
    _close(_groups(client, token), {"Production": 2.0, "End of life": 0.5})


def test_every_method_sums_to_its_own_score(client, token, project):
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write(
        {
            ("fg", "A"): _proc("A", "A", emits=1.0, inputs=[(("fg", "B"), 0.5)]),
            ("fg", "B"): _proc("B", "B", emits=1.0, inputs=[(("fg", "A"), 0.5)]),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "A"), 1.0)]),
        }
    )
    _tag(client, token, "A", "PA")
    _tag(client, token, "B", "PB")
    out = _stacked(client, token, methods=(METHOD, METHOD_2))
    _close(out[" · ".join(METHOD)], {"PA": 4 / 3, "PB": 2 / 3})
    _close(out[" · ".join(METHOD_2)], {"PA": 8 / 3, "PB": 4 / 3})


def test_the_flows_of_one_phase_add_up_to_that_phase(client, token, project):
    bd = get_bd()
    _bio(bd)
    _background(
        bd,
        {
            ("bg", "elec"): _proc("elec", "electricity", emits=0.5, db="bg"),
            ("bg", "steel"): _proc("steel", "steel", emits=2.0, inputs=[(("bg", "elec"), 2.0)], db="bg"),
        },
    )
    bd.Database("fg").write(
        {
            ("fg", "M"): _proc(
                "M", "Manufacturing", emits=1.0,
                inputs=[(("bg", "steel"), 1.0, U["u-steel"]), (("bg", "elec"), 4.0, U["u-elec"])],
            ),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "M"), 1.0, U["u-m"])]),
        }
    )
    _tag(client, token, "M", "Production")
    _tag_input("M", U["u-steel"], "Raw materials")
    r = client.post(
        "/api/v1/calc/elementary-flows",
        json={"database": "fg", "code": "R", "method": METHOD,
              "phase": {"dimension": "Phase", "value": "Raw materials"}},
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == pytest.approx(3.0)
    everything = client.post(
        "/api/v1/calc/elementary-flows",
        json={"database": "fg", "code": "R", "method": METHOD, "top_n": 0,
              "phase": {"dimension": "Phase", "value": "Raw materials"}},
        headers=token,
    ).json()
    assert sum(f["impact"] for f in everything["flows"]) == pytest.approx(3.0)


def test_production_amounts_other_than_one_scale_runs_not_products(client, token, project):
    """M makes 2 units per run and needs 3 units of T, which makes 3 per run: one R needs half a run of M
    and half a run of T."""
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write(
        {
            ("fg", "T"): _proc("T", "T", emits=6.0, production=3.0),
            ("fg", "M"): _proc("M", "M", emits=4.0, production=2.0, inputs=[(("fg", "T"), 3.0)]),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "M"), 1.0)]),
        }
    )
    _tag(client, token, "M", "Production")
    _tag(client, token, "T", "Raw materials")
    _close(_groups(client, token), {"Production": 2.0, "Raw materials": 3.0})


def test_self_consumption_is_a_loop_like_any_other(client, token, project):
    """M uses a tenth of its own output: 1/0.9 runs for one unit delivered."""
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write(
        {
            ("fg", "M"): _proc("M", "M", emits=0.9, inputs=[(("fg", "M"), 0.1)]),
            ("fg", "R"): _proc("R", "R", emits=1.0, inputs=[(("fg", "M"), 1.0)]),
        }
    )
    _tag(client, token, "M", "Production")
    _close(_groups(client, token), {"Production": 1.0, "(untagged)": 1.0})


def test_a_treatment_as_the_root_keeps_its_sign(client, token, project):
    bd = get_bd()
    _bio(bd)
    bd.Database("fg").write(
        {
            ("fg", "T"): _proc("T", "T", emits=2.0),
            ("fg", "W"): _proc("W", "W", emits=1.0, production=-1.0, inputs=[(("fg", "T"), 1.0)]),
        }
    )
    _tag(client, token, "T", "Transport")
    _close(_groups(client, token, code="W"), {"(untagged)": 1.0, "Transport": 2.0})


def test_a_substitution_credits_the_phase_it_belongs_to(client, token, project):
    bd = get_bd()
    _bio(bd)
    _background(bd, {("bg", "grid"): _proc("grid", "grid electricity", emits=0.5, db="bg")})
    data = {
        ("fg", "E"): _proc("E", "EoL"),
        ("fg", "R"): _proc("R", "R", emits=3.0, inputs=[(("fg", "E"), 1.0)]),
    }
    data[("fg", "E")]["exchanges"].append({"input": ("bg", "grid"), "amount": 2.0, "type": "substitution"})
    bd.Database("fg").write(data)
    _tag(client, token, "E", "End of life")
    _close(_groups(client, token), {"(untagged)": 3.0, "End of life": -1.0})


def test_a_process_with_two_products_is_refused_loudly(client, token, project):
    bd = get_bd()
    _bio(bd)
    data = {
        ("fg", "B"): _proc("B", "by-product"),
        ("fg", "M"): _proc("M", "M", emits=1.0),
        ("fg", "R"): _proc("R", "R", inputs=[(("fg", "M"), 1.0)]),
    }
    data[("fg", "M")]["exchanges"].append({"input": ("fg", "B"), "amount": 0.5, "type": "production"})
    bd.Database("fg").write(data)
    _tag(client, token, "M", "Production")
    r = client.post(
        "/api/v1/calc/contribution",
        json={"database": "fg", "code": "R", "method": METHOD, "aggregate_by": "tag:Phase"},
        headers=token,
    )
    assert r.status_code == 422, r.text
    assert "phase_split_multi_output" in r.text
    # Without a tag breakdown the tree still answers.
    plain = client.post("/api/v1/calc/contribution", json={"database": "fg", "code": "R", "method": METHOD},
                        headers=token)
    assert plain.status_code == 200, plain.text


def test_an_undetermined_loop_is_refused_not_guessed():
    """R consumes the library process L twice (two inputs, two phases); L consumes as much of itself as it
    makes and one R. The ordinary matrix is invertible, the split by phase is not unique."""
    import numpy as np

    from prism_lca.engine.phase_attribution import _solve
    from prism_lca.errors import PrismError

    # States: R, (L, red), (L, blue). L's self-loop has coefficient 1 in both of its states.
    system = np.eye(3)
    system[1, 0] -= 0.5
    system[2, 0] -= 0.5
    system[1, 1] -= 1.0
    system[2, 2] -= 1.0
    system[0, 1] -= 1.0
    system[0, 2] -= 1.0
    with pytest.raises(PrismError) as exc:
        _solve(system, np.array([1.0, 0.0, 0.0]))
    assert exc.value.code == "phase_split_singular"


def test_the_tree_meta_carries_the_exact_impact_of_every_input(client, token, project):
    """A canvas box sums its inputs; the share comes from the solve, not from what the pruned tree shows."""
    bd = get_bd()
    _bio(bd)
    _background(
        bd,
        {
            ("bg", "elec"): _proc("elec", "electricity", emits=0.5, db="bg"),
            ("bg", "steel"): _proc("steel", "steel", emits=2.0, inputs=[(("bg", "elec"), 2.0)], db="bg"),
        },
    )
    bd.Database("fg").write(
        {
            ("fg", "M"): _proc(
                "M", "Manufacturing", emits=1.0,
                inputs=[(("bg", "steel"), 1.0, U["u-steel"]), (("bg", "elec"), 4.0, U["u-elec"])],
            ),
            ("fg", "R"): _proc("R", "R", inputs=[(("fg", "M"), 2.0, U["u-m"])]),
        }
    )
    r = client.post("/api/v1/calc/contribution",
                    json={"database": "fg", "code": "R", "method": METHOD, "cutoff": 0.9}, headers=token)
    assert r.status_code == 200, r.text
    inputs = r.json()["meta"]["inputs"]
    assert inputs[U["u-steel"]] == pytest.approx(6.0)
    assert inputs[U["u-elec"]] == pytest.approx(4.0)
    assert U["u-m"] not in inputs  # a link inside the model is not a box of its own
