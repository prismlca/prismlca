"""What an assistant's search answer leaves out (search/left_out.py): `more` and `outside_region`.

Invented datasets throughout — no licensed names. The unit tests drive `report` with hand-set scores, because
the cases are defined by scores (all region hits weak, a region hit a little below an outside one, a tie); the
API tests check the wiring through a real (hashing) index.
"""
from __future__ import annotations

import json
import uuid

from prism_lca.engine.bootstrap import get_bd
from prism_lca.search.facets import NO_FILTERS, Filters, _named_but_hidden
from prism_lca.search.left_out import OUTSIDE_SHOWN, Elsewhere, region_label, report


def _activity(row: dict) -> tuple:
    return row.get("name"), row.get("product"), row.get("atype"), row.get("unit")


def _row(code: str, name: str, geo: str, dense: float, fused: float | None = None, atype: str = "M") -> dict:
    return {
        "code": code, "name": name, "product": name.removeprefix("market for "), "geo": geo, "unit": "kilogram",
        "atype": atype, "database": "bg", "dense": dense, "fused": dense if fused is None else fused,
    }


def _run(pool: list[dict], shown: list[dict], geographies=None, filters: Filters | None = None, wider=None,
         extra_variants: list[dict] = (), corpus: list[dict] | None = None, pool_size: int = 60) -> dict:
    """`report` over a pool whose variant map is built from the corpus (the pool plus `extra_variants` unless
    given). The default second pass does what the real one does: the corpus through the pass's filter, the best
    `pool_size` rows by fused score."""
    rows = [*pool, *extra_variants] if corpus is None else corpus
    vmap: dict[tuple, list[dict]] = {}
    for r in rows:
        vmap.setdefault(_activity(r), []).append({"code": r["code"], "geography": r["geo"]})

    def search_again(f) -> list[dict]:
        return sorted((r for r in rows if f.passes(r)), key=lambda r: -r["fused"])[:pool_size]

    return report(
        pool, shown, filters=filters or Filters.of(geographies=geographies), geographies=geographies,
        activity=_activity, variants=lambda db: vmap, wider=wider or search_again,
    )


# --- the four measured failures, rebuilt ----------------------------------------------------------------


def test_weak_region_hits_and_a_clearly_better_dataset_outside():
    """Run 01: four regional markets with nothing to do with the query, all weak; the material at 0.62 in GLO."""
    region = [_row(f"r{i}", f"market for unrelated thing {i}", "RER", 0.40 - i / 100) for i in range(4)]
    target = _row("las", "market for gizmo sulfonate, linear, petrochemical", "GLO", 0.62)
    out = _run([*region, target, _row("n", "market for gizmo, linear", "GLO", 0.55)], region, ["RER"])
    assert [r["code"] for r in out["outside_region"]] == ["las", "n"]
    assert out["outside_region"][0] == {
        "name": "market for gizmo sulfonate, linear, petrochemical", "geography": "GLO", "code": "las",
        "database": "bg", "product": "gizmo sulfonate, linear, petrochemical", "unit": "kilogram", "score": 0.62,
    }
    assert out["outside_region_note"] == "2 best outside RER; more may exist."
    assert "more" not in out  # nothing similar left in the pool once the two are listed


def test_region_hits_that_are_not_weak_still_get_the_outside_rows():
    """Run 06: two regional neighbours at 0.53/0.51 — not weak, so no warning fired — and the material at 0.56."""
    region = [_row("na2so4", "market for widget sulfate", "RER", 0.53), _row("na2so3", "market for widget sulfite", "RER", 0.51)]
    out = _run([*region, _row("as", "market for alkyl widget", "GLO", 0.56)], region, ["RER"])
    assert [r["code"] for r in out["outside_region"]] == ["as"]
    assert out["outside_region_note"] == "The best outside RER; more may exist."


def test_an_outside_row_a_little_below_the_region_hits_is_listed_too():
    """Run 09: the outside dataset is listed whatever its score — whether it matters is the reader's call."""
    region = [_row("r", "market for widget ether paste", "RER", 0.50)]
    out = _run([*region, _row("o", "market for widget paste", "GLO", 0.48)], region, ["RER"])
    assert [r["code"] for r in out["outside_region"]] == ["o"]


def test_a_hard_region_filter_gets_its_outside_rows_from_a_second_pass():
    """Run 11: three regions are a real filter, so the pool held nothing outside them."""
    shown = [_row("u", "treatment of waste gadget, unsanitary landfill", "GLO", 0.66, atype="P"),
             _row("rec", "treatment of waste gadget, recycling", "RER", 0.69, atype="P")]
    seen: list = []

    def wider(f):
        seen.append(f)
        return [_row("ch", "treatment of waste gadget, sanitary landfill", "CH", 0.69, 0.05, "P"),
                _row("row", "treatment of waste gadget, sanitary landfill", "RoW", 0.70, 0.04, "P")]

    regions = ["RER", "GLO", "Europe without Switzerland"]
    out = _run(shown, shown, regions, wider=wider)
    # One activity in two regions is one row: its best-ranked variant.
    assert [r["code"] for r in out["outside_region"]] == ["ch"]
    assert out["outside_region_note"] == "The best outside RER/GLO/Europe without Switzerland; more may exist."
    # The second pass lifts only the geography, and keeps the requested regions out.
    (f,) = seen
    assert isinstance(f, Elsewhere) and f.regions == frozenset(regions)
    assert not f.passes({"geo": "GLO", "atype": "P"}) and f.passes({"geo": "CH", "atype": "P"})


def test_the_second_pass_keeps_the_type_filter():
    f = Filters.of(activity_types=["M"], geographies=["DE", "RER"])
    seen: list = []
    _run([], [], ["DE", "RER"], filters=f, wider=lambda g: seen.append(g) or [])
    assert not seen[0].passes({"geo": "CH", "atype": "P"}) and seen[0].passes({"geo": "CH", "atype": "M"})


def test_one_region_searches_again_only_when_the_pool_held_too_few_outside():
    calls: list = []
    two = [_row("a", "market for a", "GLO", 0.5), _row("b", "market for b", "CH", 0.5)]
    _run(two, [], ["RER"], wider=lambda f: calls.append(f) or [])
    _run(two, [], None, wider=lambda f: calls.append(f) or [])
    assert calls == []
    _run(two[:1], [], ["RER"], wider=lambda f: calls.append(f) or [])
    assert len(calls) == 1


def test_regional_twins_of_shown_activities_cannot_crowd_the_outside_rows_out():
    """Three shown markets with sixty regions each outrank everything else; a pass cut before they were thrown
    out held nothing but them, and the two activities that only exist outside never surfaced."""
    shown = [_row(f"s{j}_rer", f"market for shown {j}", "RER", 0.7) for j in range(3)]
    twins = [_row(f"s{j}_{i}", f"market for shown {j}", f"X{i}", 0.7, fused=0.05) for j in range(3) for i in range(60)]
    only_out = [_row("o1", "market for only outside 1", "CH", 0.6, fused=0.01),
                _row("o2", "market for only outside 2", "RoW", 0.55, fused=0.009)]
    corpus = [*shown, *twins, *only_out]
    for regions in (["RER"], ["RER", "DE"]):  # one region (pool of twins), and a hard filter (second pass)
        pool = [*shown, *twins[:57]] if len(regions) == 1 else shown
        out = _run(pool, shown, regions, corpus=corpus, pool_size=60)
        assert [r["code"] for r in out["outside_region"]] == ["o1", "o2"], regions


# --- which rows qualify -----------------------------------------------------------------------------------


def test_the_outside_rows_follow_the_ranking_without_the_region_and_ties_are_stable():
    region = [_row("r", "market for r", "RER", 0.45)]
    # Ranked by the fused score times the type boost, not by the displayed similarity…
    a = _row("a", "market for a", "GLO", 0.50, fused=0.030)
    b = _row("b", "market for b", "GLO", 0.70, fused=0.020)
    # …and a tie is broken by the code, so the same search twice gives the same rows.
    c = _row("c", "market for c", "GLO", 0.60, fused=0.030)
    out = _run([*region, b, c, a], region, ["RER"])
    assert [r["code"] for r in out["outside_region"]] == ["a", "c"]
    assert len(out["outside_region"]) == OUTSIDE_SHOWN


def test_a_region_activity_the_limit_cut_is_never_offered_as_outside():
    """It exists in the region; its GLO twin is not "outside RER" — it is a region hit beyond the limit."""
    shown = [_row("s", "market for shown", "RER", 0.6)]
    twin_glo = _row("t_glo", "market for twin", "GLO", 0.9)
    out = _run([*shown, twin_glo, _row("o", "market for other", "GLO", 0.5)], shown, ["RER"],
               extra_variants=[_row("t_rer", "market for twin", "RER", 0.0)])
    assert [r["code"] for r in out["outside_region"]] == ["o"]
    assert out["more"] == "1+ similar in RER"


def test_rows_of_a_shown_activity_are_left_out_even_when_every_region_is_its_own_row():
    """collapse_geo=false: the list shows one region of an activity; its other regions are not new hits."""
    shown = [_row("a_rer", "market for a", "RER", 0.6)]
    pool = [*shown, _row("a_glo", "market for a", "GLO", 0.7), _row("b", "market for b", "GLO", 0.5)]
    assert [r["code"] for r in _run(pool, shown, ["RER"])["outside_region"]] == ["b"]


def test_nothing_outside_without_a_region():
    out = _run([_row("a", "market for a", "GLO", 0.6)], [], None)
    assert "outside_region" not in out and "outside_region_note" not in out
    assert out["more"] == "1+ similar"


# --- `more` -----------------------------------------------------------------------------------------------


def test_more_counts_similar_activities_not_regional_variants_and_leaves_out_what_is_listed():
    shown = [_row("s", "market for shown", "RER", 0.7)]
    pool = [
        *shown,
        # Three regional rows of ONE activity in the region: counted once.
        *[_row(f"x{g}", "market for x", g, 0.6) for g in ("RER", "GLO", "RoW")],
        _row("y", "market for y", "RER", 0.5),
        _row("weak", "market for weak", "RER", 0.42),  # below the weak threshold: not counted
        # Outside: two listed in outside_region, two more similar, one weak.
        *[_row(f"o{i}", f"market for o{i}", "GLO", 0.6 - i / 100, fused=0.1 - i / 100) for i in range(4)],
        _row("ow", "market for ow", "GLO", 0.30, fused=0.001),
    ]
    out = _run(pool, shown, ["RER"])
    assert [r["code"] for r in out["outside_region"]] == ["o0", "o1"]
    assert out["more"] == "2+ similar in RER, 2+ outside"


def test_more_is_absent_when_nothing_similar_is_left_and_names_the_outside_alone_otherwise():
    shown = [_row("s", "market for shown", "RER", 0.7)]
    assert "more" not in _run([*shown, _row("w", "market for w", "RER", 0.3)], shown, ["RER"])
    pool = [*shown, *[_row(f"o{i}", f"market for o{i}", "GLO", 0.6, fused=0.1 - i / 100) for i in range(3)]]
    assert _run(pool, shown, ["RER"])["more"] == "1+ similar outside RER"


def test_the_pool_bounds_the_count():
    """Only what reached the candidate pool is counted — hence the "+": a lower bound, never a total."""
    shown = [_row("s", "market for shown", "RER", 0.7)]
    pool = [*shown, *[_row(f"r{i}", f"market for r{i}", "RER", 0.6) for i in range(5)]]
    assert _run(pool[:3], shown, ["RER"])["more"] == "2+ similar in RER"
    assert _run(pool, shown, ["RER"])["more"] == "5+ similar in RER"


def test_region_label_keeps_the_request_order():
    assert region_label(["RER"]) == "RER"
    assert region_label(["DE", "RER", "DE", ""]) == "DE/RER"
    assert region_label(None) == ""


def test_what_the_additions_cost_one_query():
    """The batch limit of six is arithmetic: 120 000 characters over a worst-case query of ~19 600 (read.ts:36).
    The additions are two compact rows, a note and a count; with names as long as the longest real ones they
    cost ~820 characters a query, so six worst-case queries now overrun the ceiling by about 3 % and the result
    budget trims hits — never these rows, which are not the longest list (pinned in read.test.ts). This pins
    the cost, so a new field cannot creep in unnoticed."""
    long = "market for gizmo sulfonate, linear, petrochemical, with a very long qualifier"
    region = [_row("r", "market for r", "RER", 0.4)]
    pool = [*region, *[_row(f"{i:032x}", f"{long} {i}", "GLO", 0.6, fused=0.1 - i / 100) for i in range(4)]]
    out = _run(pool, region, ["Europe without Switzerland"])
    for row in out["outside_region"]:
        row.update(database="ecoinvent-3.12-cutoff", treatment=True, library=True)
    added = len(json.dumps(out, ensure_ascii=False, separators=(",", ":")))  # as the tool serialises it
    assert added <= 850, added


def test_the_hidden_dataset_note_gives_the_advice_that_fits_its_reason():
    """`activity_types="M"` used to be suggested whatever hid the dataset; it only helps when the limit cut markets."""
    market = {"name": "market for widget paste", "product": "widget paste", "geo": "GLO", "atype": "M", "unit": "kg"}
    made = {"name": "widget paste", "product": "widget paste", "geo": "GLO", "atype": "P", "unit": "kg"}

    def note(rows, filters=NO_FILTERS, target=None, outside=None):
        return _named_but_hidden("market for widget paste", rows, filters, "bg", set(), target, outside)[0]

    cut = note([market])
    assert "cut by the limit" in cut and 'larger limit or with activity_types="M"' in cut
    assert "region preference" not in cut
    assert 'activity_types="M"' not in _named_but_hidden("widget paste", [made], NO_FILTERS, "bg", set())[0]
    region = note([market], target="DE")
    assert "outranked by the region preference" in region and "activity_types" not in region
    typed = note([market], Filters.of(activity_types=["P"]))
    assert "kept out by activity_types" in typed and "search again without activity_types" in typed
    assert note([market], outside={("bg", "market for widget paste", "widget paste")}) is None


# --- through the API --------------------------------------------------------------------------------------


def _write(bd, name: str, rows) -> None:
    """(code, name, reference product, location, reference amount) rows, unit kg — invented datasets."""
    bd.Database(name).write({
        (name, code): {
            "name": nm, "reference product": prod, "location": loc, "unit": "kg",
            "exchanges": [{"input": (name, code), "amount": amount, "type": "production"}],
        }
        for code, nm, prod, loc, amount in rows
    })


GIZMO = [
    ("las", "market for gizmo sulfonate, linear, petrochemical", "gizmo sulfonate, linear, petrochemical", "GLO", 1.0),
    ("r1", "market for leachate, inert", "leachate, inert", "RER", 1.0),
    ("r2", "market for sodium sulfite", "sodium sulfite", "RER", 1.0),
    ("r3", "market for widget oil", "widget oil", "RER", 1.0),
    ("lin", "market for widget, linear", "widget, linear", "GLO", 1.0),
]

LANDFILL = [
    ("lf_ch", "treatment of waste gadget, sanitary landfill", "waste gadget", "CH", -1.0),
    ("lf_row", "treatment of waste gadget, sanitary landfill", "waste gadget", "RoW", -1.0),
    ("unsan", "treatment of waste gadget, unsanitary landfill", "waste gadget", "GLO", -1.0),
    ("rec", "treatment of waste gadget, recycling", "waste gadget", "RER", -1.0),
]


def _indexed(client, token, rows) -> str:
    db = "syn-" + uuid.uuid4().hex[:6]
    _write(get_bd(), db, rows)
    r = client.post("/api/v1/search/index", json={"database": db}, headers=token)
    assert r.status_code in (200, 202), r.text
    return db


def _search(client, token, **body) -> dict:
    r = client.post("/api/v1/search/activities", json=body, headers=token)
    assert r.status_code == 200, r.text
    return r.json()


def test_the_panel_gets_none_of_it(client, token, project):
    db = _indexed(client, token, GIZMO)
    out = _search(client, token, query="linear gizmo sulfonate", database=db, geographies=["RER"], limit=3)
    assert not {"more", "outside_region", "outside_region_note"} & set(out)
    assert "outside" not in out["proxy_warning"]


def test_the_region_preference_no_longer_hides_the_material(client, token, project):
    db = _indexed(client, token, GIZMO)
    out = _search(client, token, query="linear gizmo sulfonate", database=db, geographies=["RER"], limit=3,
                  beyond_limit=True)
    assert {h["geography"] for h in out["hits"]} == {"RER"}
    assert out["outside_region"][0]["code"] == "las"
    assert out["outside_region_note"] == "2 best outside RER; more may exist."
    # The proxy warning names the third explanation, before absence.
    assert "or it lies outside RER — see outside_region — or it has no dataset" in out["proxy_warning"]


def test_a_hard_filter_lists_the_dataset_it_hid_and_drops_the_note_that_said_so(client, token, project):
    db = _indexed(client, token, LANDFILL)
    query = "treatment of waste gadget, sanitary landfill"
    plain = _search(client, token, query=query, database=db, geographies=["RER", "GLO"], limit=5)
    assert "named exactly" in plain["outside_geography_filter"]  # the old note, still there for the panel

    out = _search(client, token, query=query, database=db, geographies=["RER", "GLO"], limit=5, beyond_limit=True)
    assert {h["geography"] for h in out["hits"]} <= {"RER", "GLO"}
    (row,) = out["outside_region"]
    assert row["name"] == query and row["geography"] in {"CH", "RoW"}
    assert row["treatment"] is True  # negative reference product: supplied with a negative amount
    assert set(row) == {"name", "geography", "code", "database", "product", "unit", "score", "treatment"}
    assert out["outside_region_note"] == "The best outside RER/GLO; more may exist."
    # The same dataset under outside_region: the note would only repeat it.
    assert "outside_geography_filter" not in out


def test_the_hidden_dataset_note_names_the_reason_it_was_hidden(client, token, project):
    rows = [
        ("m_glo", "market for widget paste", "widget paste", "GLO", 1.0),
        *[(f"d{i}", f"widget paste production, variant {i}", "widget paste", "DE", 1.0) for i in range(3)],
    ]
    db = _indexed(client, token, rows)
    query = "market for widget paste"

    region = _search(client, token, query=query, database=db, geographies=["DE"], limit=2)["outside_geography_filter"]
    assert "outranked by the region preference" in region and "pass its region in geographies" in region
    assert "activity_types" not in region and "cut by the limit" not in region

    typed = _search(client, token, query=query, database=db, activity_types=["P"], limit=5)["outside_geography_filter"]
    assert "kept out by activity_types" in typed and "search again without activity_types" in typed
    assert "region preference" not in typed

    # With the market listed under outside_region the note has nothing left to say.
    listed = _search(client, token, query=query, database=db, geographies=["DE"], limit=2, beyond_limit=True)
    assert listed["outside_region"][0]["code"] == "m_glo"
    assert "outside_geography_filter" not in listed


def test_without_collapse_the_outside_rows_skip_the_regions_of_a_shown_activity(client, token, project):
    rows = [
        ("a_rer", "market for gizmo sulfonate", "gizmo sulfonate", "RER", 1.0),
        ("a_glo", "market for gizmo sulfonate", "gizmo sulfonate", "GLO", 1.0),
        ("b_glo", "market for gizmo sulfonate, branched", "gizmo sulfonate, branched", "GLO", 1.0),
    ]
    db = _indexed(client, token, rows)
    out = _search(client, token, query="gizmo sulfonate", database=db, geographies=["RER"], limit=1,
                  collapse_geo=False, beyond_limit=True)
    assert [h["code"] for h in out["hits"]] == ["a_rer"]
    assert [r["code"] for r in out["outside_region"]] == ["b_glo"]


def test_a_market_in_seventy_regions_does_not_hide_what_exists_only_outside(client, token, project):
    """Row by row (collapse_geo=false) the pool is sixty rows, and one market in seventy regions fills it."""
    rows = [
        ("m_rer", "market for gizmo sulfonate", "gizmo sulfonate", "RER", 1.0),
        *[(f"m_{i:02d}", "market for gizmo sulfonate", "gizmo sulfonate", f"Z{i:02d}", 1.0) for i in range(70)],
        ("branched", "market for gizmo sulfonate, branched", "gizmo sulfonate, branched", "CH", 1.0),
    ]
    db = _indexed(client, token, rows)
    for regions in (["RER"], ["RER", "DE"]):
        out = _search(client, token, query="gizmo sulfonate", database=db, geographies=regions, limit=1,
                      collapse_geo=False, beyond_limit=True)
        # Which of the seventy identical rows makes the one slot is a tie; the activity is not.
        assert [h["name"] for h in out["hits"]] == ["market for gizmo sulfonate"], regions
        assert [r["code"] for r in out["outside_region"]] == ["branched"], regions
