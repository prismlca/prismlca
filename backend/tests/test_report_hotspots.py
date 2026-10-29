"""The hotspot list ranks datasets, not positions in the tree.

A contribution tree has one node per *path*, so the same background dataset appears once for every
branch that reaches it. Ranking those nodes gives a list that looks like a ranking of processes and
is not one.

Found in the 2026-08-17 Solarleuchte run, where the pack buys the same NiMH cells twice — once built
into the lamps, once as the replacement set — and every rare-earth market underneath them arrives
through both branches. Three things went wrong at once, all of them printed:

* the report named solar-grade silicon "the largest individual process … only 3.8 %" when the real
  leader was dysprosium oxide at 4.9 %, split across ranks 5 and 6;
* the *second* largest contributor, the medium-voltage electricity market at 4.75 %, was missing from
  the report altogether, because each of its pieces fell below the top-ten cut-off;
* the writing model saw the same name twice and explained it in the prose — "the market for dysprosium
  oxide, which appears twice in the hotspot list because it enters through more than one supply path"
  — which a reader takes for a modelling statement rather than a tool artefact.
"""
from __future__ import annotations

from prism_lca.engine.report_hotspots import hotspots


def _node(name: str, direct: float, code: str | None = None, children: list | None = None) -> dict:
    return {
        "n": name,
        "c": code or name[:6],
        "db": "ecoinvent-3.12-cutoff",
        "g": "GLO",
        "u": "kilogram",
        "dir": direct,
        "ch": children or [],
    }


def _tree(total: float, branches: list[dict]) -> dict:
    return {"meta": {"total": total, "unit": "kg CO2-Eq"}, "tree": _node("functional unit", 0.0, "fu", branches)}


def test_one_dataset_reached_twice_is_one_hotspot():
    """The pack buys the same cells twice; the burden is one dataset's, not two half-datasets'."""
    contribution = _tree(
        10.0,
        [
            _node("assembly", 0.0, "asm", [_node("market for dysprosium oxide", 0.25, "dy")]),
            _node("use phase", 0.0, "use", [_node("market for dysprosium oxide", 0.25, "dy")]),
            _node("market for silicon, solar grade", 0.38, "si"),
        ],
    )
    out = hotspots(contribution)
    names = [h["name"] for h in out]
    assert names.count("market for dysprosium oxide") == 1, names
    assert names[0] == "market for dysprosium oxide", "0.25 + 0.25 leads 0.38 — this is the ranking bug"
    assert out[0]["direct"] == 0.5
    assert round(out[0]["share_percent"], 1) == 5.0


def test_a_dataset_split_below_the_cut_off_still_reaches_the_list():
    """Four pieces of 0.3 are a bigger contributor than one piece of 0.5, and used to be invisible."""
    contribution = _tree(
        100.0,
        [_node("market group for electricity", 0.3, "el") for _ in range(4)]
        + [_node(f"filler {i}", 0.5, f"f{i}") for i in range(10)],
    )
    out = hotspots(contribution, limit=5)
    assert out[0]["name"] == "market group for electricity"
    assert out[0]["direct"] == 1.2


def test_datasets_that_only_share_a_name_stay_apart():
    """Same product, different geography: two markets named alike are two datasets."""
    contribution = _tree(
        10.0,
        [
            _node("market group for electricity, medium voltage", 0.4, "de"),
            _node("market group for electricity, medium voltage", 0.3, "cn"),
        ],
    )
    out = hotspots(contribution)
    assert [h["code"] for h in out] == ["de", "cn"]
    assert [h["direct"] for h in out] == [0.4, 0.3]


def test_the_details_come_from_the_branch_that_carries_most_of_it():
    """"Why does this dominate" is answered by the heavier branch's attributed inputs."""
    heavy = _node("market for mischmetal", 0.9, "mm", [_node("cerium", 0.8, "ce", [])])
    light = _node("market for mischmetal", 0.1, "mm", [_node("lanthanum", 0.05, "la", [])])
    out = hotspots(_tree(10.0, [light, heavy]), detail=5)
    assert out[0]["direct"] == 1.0
    assert [i["name"] for i in out[0].get("inputs", [])] == ["cerium"]


def test_a_zero_contributor_is_not_a_hotspot():
    out = hotspots(_tree(10.0, [_node("nothing", 0.0, "z"), _node("something", 1.0, "s")]))
    assert [h["name"] for h in out] == ["something"]


def test_no_tree_no_hotspots():
    assert hotspots(None) == []
    assert hotspots({"meta": {"total": 1.0}}) == []
