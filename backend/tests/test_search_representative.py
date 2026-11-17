"""Which regional variant shows a collapsed search hit (search/collapse.py), and where the outside rows are shown.

Invented datasets and regions only. The unit tests drive the collapse with hand-built rows; the API test goes
through a real (hashing) index, as the assistant's search does.
"""
from __future__ import annotations

import uuid

from prism_lca.engine.bootstrap import get_bd
from prism_lca.search.collapse import collapse_hits, order_variants, region_key, representative
from prism_lca.search.facets import Filters
from prism_lca.search.geography import geo_rank, preference
from prism_lca.search.left_out import report


def _variants(*geos: str) -> list[dict]:
    return [{"code": f"c-{g}", "geography": g, "database": "bg"} for g in geos]


# --- the preference --------------------------------------------------------------------------------------------


def test_one_target_orders_like_the_ranking_chain():
    geos = ["RoW", "GLO", "FR", "Europe without Switzerland", "RER", "DE"]
    key = preference(["DE"])
    assert sorted(geos, key=key) == sorted(geos, key=lambda g: geo_rank(g, "DE"))


def test_several_targets_come_first_in_the_order_named_then_their_regions():
    geos = ["RoW", "GLO", "US", "Europe without Switzerland", "RER", "DE", "BE"]
    assert sorted(geos, key=preference(["BE", "DE"])) == [
        "BE", "DE", "RER", "Europe without Switzerland", "GLO", "RoW", "US",
    ]


def test_a_region_in_no_chain_sorts_behind_every_chain():
    """A short chain must not let an unrelated region overtake a long chain's tail: RoW is the last proxy of
    DE's chain and still precedes US, which no target's chain holds."""
    key = preference(["XK", "DE"])
    assert key("RoW") < key("US")
    assert key("AE") == key("US")


# --- the representative ----------------------------------------------------------------------------------------


def test_the_study_region_represents_the_hit_not_the_best_scored_variant():
    """The medium-voltage electricity market: US-NPCC scored best, AE and AL were listed beside it, and the model
    found the German market only in a market group's supplier list."""
    variants = _variants("US-NPCC", "AE", "AL", "DE", "FR")
    rep = representative(variants, "c-US-NPCC", region_key(["DE"]))
    assert rep["geography"] == "DE"
    # Without the country, the country's region; then the global proxies.
    rep = representative(_variants("US-NPCC", "RoW", "RER", "AL"), "c-US-NPCC", region_key(["DE"]))
    assert rep["geography"] == "RER"


def test_without_a_study_region_the_global_and_european_aggregates_represent_the_hit():
    assert representative(_variants("BR", "RoW", "RER", "GLO"), "c-BR", region_key())["geography"] == "GLO"
    assert representative(_variants("BR", "RoW", "Europe without Switzerland"), "c-BR", region_key())[
        "geography"
    ] == "Europe without Switzerland"


def test_the_best_scored_variant_stays_when_no_variant_suits():
    """No preferred region among the variants: the hit keeps the representative it always had."""
    variants = _variants("US-NPCC", "AE", "AL")
    assert representative(variants, "c-US-NPCC", region_key())["geography"] == "US-NPCC"
    assert representative(variants, "c-AL", region_key(["DE"]))["geography"] == "AL"
    assert representative([], "c-x", region_key()) is None


def test_the_representative_leads_the_list_and_the_rest_follow_the_preference():
    variants = _variants("PL", "RoW", "DE", "GLO", "BE", "RER")
    order = order_variants(variants, "c-DE", region_key(["BE", "DE"]))
    assert [v["geography"] for v in order] == ["DE", "BE", "RER", "GLO", "RoW", "PL"]


# --- the collapse ----------------------------------------------------------------------------------------------


class _Index:
    """What `collapse_hits` reads of an index: its rows."""

    def __init__(self, meta: list[dict]) -> None:
        self.meta = meta


def _row(code: str, geo: str, name: str = "market for electricity, medium voltage", score: float = 0.7) -> dict:
    return {
        "code": code, "name": name, "product": "electricity, medium voltage", "atype": "M", "unit": "kilowatt hour",
        "geo": geo, "database": "bg", "score": score, "dense": score,
    }


def test_a_collapsed_hit_keeps_its_place_and_score_and_shows_the_preferred_region():
    elec = [_row(f"e-{g}", g, score=0.71 if g == "US-NPCC" else 0.70) for g in ("US-NPCC", "AE", "AL", "DE")]
    other = _row("w", "GLO", name="market for wind turbine", score=0.65)
    indices = {"bg": _Index([*elec, other])}
    ranked = [elec[0], other, *elec[1:]]

    groups = collapse_hits(ranked, indices, 10, variants_cap=3, prefer=["DE"])
    assert [g["name"] for g in groups] == ["market for electricity, medium voltage", "market for wind turbine"]
    hit = groups[0]
    assert (hit["code"], hit["geo"]) == ("e-DE", "DE")
    assert hit["score"] == 0.71  # the group's place and score are its best variant's
    assert [v["geography"] for v in hit["variants"]] == ["DE", "AE", "AL"]
    assert hit["variants_total"] == 4

    # Nothing preferred and no aggregate among the regions: as before, the best-scored variant.
    assert collapse_hits(ranked, indices, 10, variants_cap=3)[0]["geo"] == "US-NPCC"


def test_a_region_filter_shows_the_first_named_region():
    elec = [_row(f"e-{g}", g) for g in ("RER", "DE", "FR")]
    groups = collapse_hits(elec, {"bg": _Index(elec)}, 10, geos={"DE", "RER"}, prefer=["DE", "RER"])
    assert groups[0]["geo"] == "DE"
    assert [v["geography"] for v in groups[0]["variants"]] == ["DE", "RER"]


# --- through the API -------------------------------------------------------------------------------------------


def test_the_search_shows_a_folded_market_in_the_preferred_region(client, token, project):
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    regions = ["AE", "AL", "BE", "DE", "FR", "US-NPCC"]
    bd.Database(db).write(
        {
            (db, f"elec_{geo}"): {
                "name": "market for electricity, medium voltage",
                "reference product": "electricity, medium voltage",
                "location": geo,
                "unit": "kWh",
                "exchanges": [{"input": (db, f"elec_{geo}"), "amount": 1.0, "type": "production"}],
            }
            for geo in regions
        }
    )
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    def first(**extra) -> dict:
        body = {"query": "electricity medium voltage", "database": db, "limit": 3, "variants_cap": 3, **extra}
        return client.post("/api/v1/search/activities", json=body, headers=token).json()["hits"][0]

    hit = first(prefer_geographies=["DE"])
    assert hit["geography"] == "DE" and hit["code"] == "elec_DE"
    assert hit["variants"][0]["geography"] == "DE" and hit["variants_total"] == len(regions)
    # The study names two countries: the first one named shows the hit, the second leads the rest.
    assert [v["geography"] for v in first(prefer_geographies=["BE", "DE"])["variants"]][:2] == ["BE", "DE"]
    # A region asked for outranks the study's.
    assert first(geographies=["FR"], prefer_geographies=["DE"])["geography"] == "FR"


# --- the rows outside the region -------------------------------------------------------------------------------


def test_an_outside_row_is_shown_in_its_variant_nearest_the_region():
    """The tap-water market of a German study came back as "market for tap water [BR]" although the same market
    exists in "Europe without Switzerland", the second proxy of a German search."""

    def row(code: str, geo: str, dense: float) -> dict:
        return {
            "code": code, "name": "market for tap water", "product": "tap water", "geo": geo, "unit": "kilogram",
            "atype": "M", "database": "bg", "dense": dense, "fused": dense,
        }

    pool = [row("w-BR", "BR", 0.68), row("w-PE", "PE", 0.66), row("w-E", "Europe without Switzerland", 0.60)]
    vmap = {("market for tap water", "tap water", "M", "kilogram"): [
        {"code": r["code"], "geography": r["geo"]} for r in pool
    ]}
    out = report(
        pool, [], filters=Filters.of(geographies=["DE"]), geographies=["DE"],
        activity=lambda r: (r.get("name"), r.get("product"), r.get("atype"), r.get("unit")),
        variants=lambda db: vmap, wider=lambda f: [r for r in pool if f.passes(r)],
    )
    [shown] = out["outside_region"]
    assert (shown["code"], shown["geography"]) == ("w-E", "Europe without Switzerland")
    assert shown["score"] == 0.68  # the activity's best, as the row was ranked by
