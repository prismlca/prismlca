"""What an indicator is called, and what that name may not cost (V203).

A method name is a tuple, and two families spell it differently. ``EF v3.1`` puts the impact category
second and a technicality third, so the second part is the name. ``ReCiPe 2016 v1.03, endpoint (H)``
puts the *damage category* second and the indicator third, so the second part names twelve indicators
at once. Everything printed the second part: a French report of four endpoint indicators came out with
"6.2 ecosystem quality" and "6.3 ecosystem quality" in its contents, two results rows reading
``ecosystem quality | species.yr`` with 4,07e-14 and 1,49e-09 under them, and two figure captions that
were the same sentence.

One rule fixes all of them, and the second half of this file is about what it must not break: a printed
label is not an identity. The chapters of a finished report pin their figures to the method *tuple*
(`report_data.RANKED_LISTS["results"] == ("method_label",)`, the full path), so a nicer name may not
turn a report nobody touched into one whose chapters are all out of date.
"""
from __future__ import annotations

from prism_lca.engine import report_data as rd
from prism_lca.engine import report_render
from prism_lca.engine import report_staleness as rs
from prism_lca.engine import report_typst as rt

ENDPOINT = "ReCiPe 2016 v1.03, endpoint (H)"
FRESHWATER = (ENDPOINT, "ecosystem quality", "climate change: freshwater ecosystems")
TERRESTRIAL = (ENDPOINT, "ecosystem quality", "climate change: terrestrial ecosystems")
HEALTH = (ENDPOINT, "human health", "climate change: human health")
CLIMATE = ("EF v3.1", "climate change", "global warming potential (GWP100)")
WATER = ("EF v3.1", "water use", "user deprivation potential")
#: A family that keeps its whole path in two segments, as several ecoinvent families do.
CED = ("Cumulative energy demand", "energy resources: renewable, biomass")

CATALOGUE = [list(m) for m in (CLIMATE, WATER, FRESHWATER, TERRESTRIAL, HEALTH, CED)]


def path(method: tuple[str, ...]) -> str:
    return " / ".join(method)


# ---- the rule ----------------------------------------------------------------


def test_a_category_that_names_one_indicator_is_the_name():
    labels = rt.indicator_labels(CATALOGUE)
    assert rt.short_method(path(CLIMATE), labels) == "climate change"
    assert rt.short_method(path(WATER), labels) == "water use"


def test_a_category_that_names_several_indicators_is_not():
    labels = rt.indicator_labels(CATALOGUE)
    named = [rt.short_method(path(m), labels) for m in (FRESHWATER, TERRESTRIAL)]
    assert named == [
        "ecosystem quality / climate change: freshwater ecosystems",
        "ecosystem quality / climate change: terrestrial ecosystems",
    ]
    assert len(set(named)) == 2
    # Its sibling under the other damage category is the only one there, so nothing is spelled out.
    assert rt.short_method(path(HEALTH), labels) == "human health"


def test_the_family_is_judged_by_the_catalogue_and_not_by_the_selection():
    """The decisive property: a report of one endpoint indicator names it the same way as a report of
    four. Judged against the selection, "ecosystem quality" would be unique in that report and the
    name would grow the day a sibling was ticked — the same indicator, two names, no way to tell which
    document meant what."""
    selection = rt.indicator_labels([list(FRESHWATER), list(HEALTH)])
    assert rt.short_method(path(FRESHWATER), selection) == "ecosystem quality"  # the wrong input
    whole = rt.indicator_labels(CATALOGUE)
    assert rt.short_method(path(FRESHWATER), whole) == (
        "ecosystem quality / climate change: freshwater ecosystems"
    )


def test_a_two_part_path_is_printed_whole_and_gains_no_separator():
    labels = rt.indicator_labels(CATALOGUE)
    printed = rt.short_method(path(CED), labels)
    assert printed == "Cumulative energy demand / energy resources: renewable, biomass"
    assert not printed.endswith("/") and printed.strip()
    # Not in the map at all: its middle segment is also its last, so no two of them can collide.
    assert path(CED) not in labels


def test_without_a_catalogue_the_middle_segment_still_stands_in():
    """A caller with no project open — the /iso path, a test — keeps what the document did before."""
    assert rt.short_method(path(FRESHWATER)) == "ecosystem quality"
    assert rt.short_method(path(CLIMATE)) == "climate change"
    assert rt.short_method("") == ""


def test_the_same_method_twice_is_not_two_indicators_sharing_a_name():
    labels = rt.indicator_labels([list(CLIMATE), list(CLIMATE)])
    assert labels[path(CLIMATE)] == "climate change"


# ---- the document ------------------------------------------------------------


def _lcia(pair: tuple[tuple[str, ...], ...], *scores: float) -> dict:
    return {
        "activity": {"name": "Bottle", "database": "cmp", "code": "b"},
        "amount": 1.0,
        "results": [
            {"method": list(m), "unit": "species.yr", "score": s}
            for m, s in zip(pair, scores, strict=True)
        ],
    }


def _tree() -> dict:
    return {
        "aggregation": {
            "dimension": "tag:Phase",
            "groups": [
                {"key": "Production", "impact": 0.8, "share": 0.8},
                {"key": "Transport", "impact": 0.2, "share": 0.2},
            ],
        },
        "meta": {"unit": "species.yr"},
    }


def _document(pair: tuple[tuple[str, ...], ...] = (FRESHWATER, TERRESTRIAL), **kw) -> str:
    """The typeset sources for a two-variant report of `pair` — the shape run 16 delivered."""
    report = {
        "lang": "en",
        "sections": [
            {"id": "l", "kind": "lcia", "order": 0},
            {"id": "c", "kind": "contribution", "order": 1},
        ],
    }
    sources, _info = report_render.render_sources(
        report,
        {"functional_unit": "1 bottle"},
        _lcia(pair, 4.07e-14, 1.49e-09),
        _tree(),
        subjects=[
            {"label": "Baseline", "code": "b", "scenario": None, "lcia": _lcia(pair, 4.07e-14, 1.49e-09)},
            {"label": "Variant", "code": "b", "scenario": "s1", "lcia": _lcia(pair, 3.9e-14, 1.2e-09)},
        ],
        contributions=[
            {
                "index": i,
                "method_label": path(m),
                "contribution": _tree(),
                "subjects": [],
                "hotspots": [],
            }
            for i, m in enumerate(pair)
        ],
        # Keyed by the indicator, as the renderer keys them (report_model.chart_key).
        figures={f"lcia:{path(m)}": "<svg/>" for m in pair},
        **kw,
    )
    # The tables read their cells from `tables.json`; the text of both is the document.
    return rt.document_text(sources)


def _captions(main: str) -> list[str]:
    return [line for line in main.splitlines() if "— comparison]" in line]


def test_two_indicators_of_one_damage_category_read_differently_everywhere():
    main = _document(method_catalog=CATALOGUE)
    # The results table, whose columns are the indicators here: told apart by the part the old label
    # dropped. A whole cell (one line each in the document text), because the legend below prints the
    # full paths and would match anything.
    assert "\necosystem quality / climate change: freshwater ecosystems (species.yr)\n" in main
    assert "\necosystem quality / climate change: terrestrial ecosystems (species.yr)\n" in main
    # The contribution chapter's sub-headings, which are also what the table of contents prints.
    headings = [line for line in main.splitlines() if line.startswith("==")]
    assert any("freshwater" in h for h in headings) and any("terrestrial" in h for h in headings)
    # The two per-indicator figure captions.
    captions = _captions(main)
    assert len(captions) == 2 and captions[0] != captions[1]
    # Nothing is left standing on the damage category alone — that caption was the whole defect.
    assert "caption: [ecosystem quality —" not in main


def test_the_catalogue_names_an_indicator_whose_sibling_the_report_does_not_carry():
    """The half a report cannot answer for itself.

    Freshwater and human health are unambiguous *within this report*, and named against it that is what
    they look like. The family still has a second ecosystem-quality indicator, so "ecosystem quality" is
    not this one's name — and the day the author adds it, no chapter's caption may change meaning.
    """
    with_catalogue = _document((FRESHWATER, HEALTH), method_catalog=CATALOGUE)
    assert "ecosystem quality / climate change: freshwater ecosystems" in with_catalogue
    assert _captions(with_catalogue)[1].count("human health") == 1  # its own category is enough

    # Without one — the ad-hoc paths, a caller with no project — the report is judged by itself, which
    # is honest about what it knows and is why the render passes the catalogue in.
    alone = _document((FRESHWATER, HEALTH))
    assert _captions(alone)[0].startswith("  caption: [ecosystem quality —")


def test_the_full_path_is_still_in_the_document_once():
    """Shortening a name may not remove the identity of the method from the report: the legend under
    the results table carries the full path, and it is keyed by the printed name."""
    main = _document(method_catalog=CATALOGUE)
    assert path(FRESHWATER) in main and path(TERRESTRIAL) in main


# ---- what the rule may not cost ----------------------------------------------

#: A chapter as it was stored before the names changed: the pin is the method *path*, which is what
#: `report_data.bindings_for` writes for a `results` index and what `identity_matches` compares.
WRITTEN_BEFORE = {
    "text": (
        "Damage to freshwater ecosystems is {{results.0.score}} {{results.0.unit}}, "
        "against {{results.1.score}} for terrestrial ecosystems."
    ),
    "bindings": {"results.0": {"method_label": path(FRESHWATER)}, "results.1": {"method_label": path(TERRESTRIAL)}},
}


def _snapshot() -> dict:
    return rd.build_data({"functional_unit": "1 bottle"}, _lcia((FRESHWATER, TERRESTRIAL), 4.07e-14, 1.49e-09))


def _report_definition() -> dict:
    return {
        "methods": [list(FRESHWATER), list(TERRESTRIAL)],
        "subjects": [{"label": "Baseline", "code": "b"}],
        "lang": "en",
    }


def test_the_snapshot_identifies_an_indicator_by_its_path_not_by_its_name():
    data = _snapshot()
    assert [r["method_label"] for r in data["results"]] == [path(FRESHWATER), path(TERRESTRIAL)]
    bound = rd.bindings_for(WRITTEN_BEFORE["text"], data)
    assert bound == WRITTEN_BEFORE["bindings"]
    # And what the selection check remembers is the same path — no printed name anywhere in it.
    selection = rs.selection_of(_report_definition(), data)
    assert selection["methods"] == sorted([path(FRESHWATER), path(TERRESTRIAL)])


def test_a_chapter_written_before_the_names_changed_is_not_stale():
    """The one thing this improvement was not allowed to do: hand every chapter of a finished report a
    rewrite badge, and the author a bill, for a cosmetic change to a caption."""
    report = _report_definition()
    data = _snapshot()
    section = {
        "id": "s1",
        "kind": "prose",
        **WRITTEN_BEFORE,
        # Recorded when the chapter was written, against the same numbers — the record a stored
        # chapter carries. Nothing in it is a printed label.
        "based_on": rs.components(WRITTEN_BEFORE["text"], WRITTEN_BEFORE["bindings"], report, data),
    }
    assert rs.verdicts(section, report, _snapshot()) == []
    # The document those bindings belong to now prints the long names; the pins do not notice.
    main = _document(method_catalog=CATALOGUE)
    assert "climate change: freshwater ecosystems" in main
    assert rs.worst(rs.verdicts(section, report, _snapshot())) == "none"


# ---- the catalogue comes from the project ------------------------------------


def _seed(bd) -> None:
    """One model, and a family whose damage category names three indicators — two installed, one of
    which the report leaves out."""
    bd.Database("biosphere").write(
        {("biosphere", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("ind").write(
        {
            ("ind", "b"): {
                "name": "Bottle", "unit": "unit", "reference product": "bottle", "location": "GLO",
                "exchanges": [
                    {"input": ("ind", "b"), "amount": 1, "type": "production"},
                    {"input": ("biosphere", "co2"), "amount": 2.0, "type": "biosphere"},
                ],
            }
        }
    )
    for method in (FRESHWATER, TERRESTRIAL, HEALTH):
        bd.Method(method).write([(("biosphere", "co2"), 1.0)])


def test_the_render_asks_the_project_which_indicators_the_family_has(client, token, project):
    """End to end, because this is the wiring the rule stands on: the report selects two indicators,
    and the third one — installed, unselected, never computed — is what decides that the first cannot
    be called "ecosystem quality"."""
    from prism_lca.engine.bootstrap import get_bd

    _seed(get_bd())
    rep = client.post(
        "/api/v1/report/create",
        json={
            "database": "ind",
            "methods": [list(FRESHWATER), list(HEALTH)],
            "subjects": [{"database": "ind", "code": "b"}],
            "sections": [{"kind": "lcia"}],
        },
        headers=token,
    ).json()
    out = client.post(f"/api/v1/report/one/ind/{rep['id']}/sources", json={}, headers=token).json()
    main = rt.document_text(out["files"])
    # The results row's first cell, whole: the legend under it prints full paths and matches any fragment.
    assert "\necosystem quality / climate change: freshwater ecosystems\n" in main
    # …and the unambiguous one is left alone, so nothing that reads well today gets longer.
    assert "\nhuman health\n" in main
    # The snapshot still identifies both by their full path — that is what chapters pin to.
    assert [r["method_label"] for r in out["data"]["results"]] == [path(FRESHWATER), path(HEALTH)]
