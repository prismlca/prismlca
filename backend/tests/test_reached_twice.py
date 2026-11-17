"""A process that takes one input directly and, with the same amount, through a step beneath it."""
from __future__ import annotations

from prism_lca.engine.reached_twice import Flows, _below, flows_of, reached_twice, touched_by

DB = "M"


def _flows(links: dict[str, dict[str, float]], output: dict[str, float] | None = None) -> Flows:
    return Flows(
        links={
            (DB, c): {(DB, p): [(f"{c}>{p}", a)] for p, a in provs.items()} for c, provs in links.items()
        },
        output={(DB, k): v for k, v in (output or {}).items()},
    )


def _found(flows: Flows) -> list[tuple[str, str, str]]:
    return [(t.upper[1], t.through[1], t.provider[1]) for t in reached_twice(flows)]


# The wheelbarrow run: the four assemblies hung under Vertrieb, then Endmontage put in between and the
# direct links left standing.
T3 = {
    "fu": {"vertrieb": 1, "eol": 1},
    "vertrieb": {"tray": 1, "frame": 1, "endmontage": 1},
    "endmontage": {"tray": 1, "frame": 1},
    "tray": {},
    "frame": {},
    "eol": {},
}


def test_a_step_put_in_between_with_the_direct_links_left_is_found():
    found = reached_twice(_flows(T3))
    assert [(t.upper[1], t.through[1], t.provider[1]) for t in found] == [
        ("vertrieb", "endmontage", "frame"),
        ("vertrieb", "endmontage", "tray"),
    ]
    tray = found[1]
    assert tray.uids == ("vertrieb>tray",) and tray.amount == 1
    assert tray.through_uids == ("endmontage>tray",)
    assert [k[1] for k in tray.route] == ["vertrieb", "endmontage"]


def test_the_route_is_scaled_down_the_chain():
    """Two wheels per barrow, one tyre per wheel: the leftover link of 2 tyres is the route's 2."""
    flows = _flows({"barrow": {"wheel": 2, "tyre": 2}, "wheel": {"tyre": 1}, "tyre": {}})
    assert _found(flows) == [("barrow", "wheel", "tyre")]


def test_the_step_s_own_output_scales_the_route():
    """The wheel process makes 2 wheels per run: one run per barrow, 1 tyre per wheel = 2 tyres."""
    flows = _flows(
        {"barrow": {"wheel": 2, "tyre": 2}, "wheel": {"tyre": 2}, "tyre": {}}, output={"wheel": 2}
    )
    assert _found(flows) == [("barrow", "wheel", "tyre")]


def test_a_deeper_route_counts_too():
    flows = _flows({"top": {"a": 1, "part": 3}, "a": {"b": 1}, "b": {"part": 3}, "part": {}})
    found = reached_twice(flows)
    assert [(t.upper[1], t.through[1], t.provider[1]) for t in found] == [("top", "b", "part")]
    assert [k[1] for k in found[0].route] == ["top", "a", "b"]


def test_a_part_used_at_two_levels_with_other_amounts_is_left_alone():
    """Screws in the final assembly and in the wheel beneath it: a real use at each level."""
    flows = _flows({"assembly": {"wheel": 1, "screws": 8}, "wheel": {"screws": 4}, "screws": {}})
    assert _found(flows) == []


def test_two_steps_sharing_a_part_side_by_side_are_left_alone():
    """A recipe in manufacturing and in use: neither consumer reaches the other."""
    flows = _flows({"fu": {"make": 1, "use": 1}, "make": {"recipe": 1}, "use": {"recipe": 1}, "recipe": {}})
    assert _found(flows) == []


def test_an_amount_typed_rounded_is_still_the_same_quantity():
    flows = _flows({"top": {"mid": 3, "part": 0.3333}, "mid": {"part": 1 / 9}, "part": {}})
    assert _found(flows) == [("top", "mid", "part")]


def test_two_direct_links_that_add_up_to_the_route_are_named_together():
    """Removing only one of two halves would leave half a part too much — and no warning to say so."""
    flows = Flows(
        links={
            (DB, "top"): {(DB, "mid"): [("m", 1.0)], (DB, "part"): [("p1", 0.5), ("p2", 0.5)]},
            (DB, "mid"): {(DB, "part"): [("mp", 1.0)]},
            (DB, "part"): {},
        },
        output={},
    )
    assert [t.uids for t in reached_twice(flows)] == [("p1", "p2")]


def test_a_link_cancelled_by_a_credit_beside_it_is_no_second_unit():
    """+1 and -1 to the part net to nothing: the part arrives once, through the step."""
    flows = Flows(
        links={
            (DB, "top"): {(DB, "mid"): [("m", 1.0)], (DB, "part"): [("plus", 1.0), ("minus", -1.0)]},
            (DB, "mid"): {(DB, "part"): [("mp", 1.0)]},
            (DB, "part"): {},
        },
        output={},
    )
    assert reached_twice(flows) == []


def _ex(kind: str, code: str, amount: float, uid: str = "") -> dict:
    return {"type": kind, "input": (DB, code), "amount": amount, "prism_uid": uid or None}


def test_a_step_eating_its_own_product_runs_more_often():
    """The step uses half of what it makes, so it runs twice per unit handed on: the route brings 2 parts."""
    def model(direct: float) -> list:
        return [
            ((DB, "top"), [_ex("production", "top", 1), _ex("technosphere", "mid", 1),
                           _ex("technosphere", "part", direct, "d")]),
            ((DB, "mid"), [_ex("production", "mid", 1), _ex("technosphere", "mid", 0.5),
                           _ex("technosphere", "part", 1, "t")]),
            ((DB, "part"), [_ex("production", "part", 1)]),
        ]

    assert reached_twice(flows_of(DB, model(1))) == []
    assert [t.uids for t in reached_twice(flows_of(DB, model(2)))] == [("d",)]


def test_a_zero_or_a_loop_reports_nothing():
    assert _found(_flows({"top": {"mid": 1, "part": 0}, "mid": {"part": 0}, "part": {}})) == []
    assert _found(_flows({"top": {"mid": 1, "part": 1}, "mid": {"part": 1, "top": 1}, "part": {}})) == []


def test_which_links_lie_on_a_double():
    flows = _flows(T3)
    below = _below(flows)
    tray = next(t for t in reached_twice(flows) if t.provider[1] == "tray")
    on = {
        (a, b)
        for a, provs in T3.items()
        for b in provs
        if touched_by(tray, ((DB, a), (DB, b)), flows, below)
    }
    assert on == {("vertrieb", "tray"), ("vertrieb", "endmontage"), ("endmontage", "tray")}
