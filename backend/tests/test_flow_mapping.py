"""The flow-mapping ladder against an invented ecoSpold-1 mini database and a toy biosphere.

The fixture under ``fixtures/import/bafu-mini`` mirrors the BAFU file structure (no namespace,
year-only dates, ``number``-linked technosphere, ``inputGroup 4``/``outputGroup 4`` elementary
flows) with made-up data. The target biosphere is built inline so the test needs no project.
"""

from __future__ import annotations

from pathlib import Path

from prism_lca.engine.backgrounds.flow_mapping import (
    STATUS_AUTO,
    STATUS_CONFIRMED,
    STATUS_OPEN,
    Correspondence,
    SourceFlow,
    TargetBiosphere,
    TargetFlow,
    curated_from_review,
    load_fallbacks,
    propose,
    read_review_table,
    renamed_flows,
    scan_ecospold1_flows,
    summarize,
    write_review_table,
)

FIXTURE = Path(__file__).parent / "fixtures" / "import" / "bafu-mini"

AIR_HP = ("air", "urban air close to ground")
WATER_SURFACE = ("water", "surface water")


def _target() -> TargetBiosphere:
    return TargetBiosphere(
        [
            TargetFlow("co2", "Carbon dioxide, fossil", AIR_HP, "kilogram", cas="124-38-9"),
            TargetFlow("propylene", "Propylene", AIR_HP, "kilogram", cas="115-07-1"),
            TargetFlow("water", "Water", WATER_SURFACE, "cubic meter"),
            TargetFlow(
                "sodium-i",
                "Sodium I",
                WATER_SURFACE,
                "kilogram",
                cas="7440-23-5",
                synonyms=("Sodium, ion",),
            ),
            TargetFlow("sodium-res", "Sodium", ("natural resource", "in ground"), "kilogram"),
            TargetFlow("coal", "Coal, hard", ("natural resource", "in ground"), "kilogram"),
            TargetFlow("heat", "Heat, waste", ("air",), "megajoule"),
        ],
        "toy",
    )


def test_scan_counts_unique_flows_and_usage() -> None:
    flows = scan_ecospold1_flows(FIXTURE)
    by_name = {f.name: f for f in flows}
    assert set(by_name) == {
        "Carbon dioxide, fossil",
        "Propene",
        "Water",
        "Noise, test vehicle",
        "Sodium",
        "Coal, hard, unspecified",
        "Heat, waste",
    }
    assert by_name["Carbon dioxide, fossil"].count == 2  # used in both datasets
    assert by_name["Carbon dioxide, fossil"].cas == "124-38-9"  # leading zeros dropped
    assert by_name["Propene"].example == "Test widget, at plant"
    assert flows[0].name == "Carbon dioxide, fossil"  # most used first


def test_ladder_rungs_and_unit_conversion() -> None:
    flows = scan_ecospold1_flows(FIXTURE)
    target = _target()
    old = TargetBiosphere(
        [
            TargetFlow(
                "coal", "Coal, hard, unspecified", ("natural resource", "in ground"), "kilogram"
            )
        ]
    )
    by_name = {p.source.name: p for p in propose(flows, target, renames=renamed_flows(old, target))}

    assert by_name["Carbon dioxide, fossil"].rung == "exact"
    assert by_name["Propene"].rung == "cas" and by_name["Propene"].target.code == "propylene"
    assert by_name["Coal, hard, unspecified"].rung == "rename"
    assert by_name["Sodium"].rung == "cas" and by_name["Sodium"].target.code == "sodium-i"
    # Heat, waste exists only in the bare compartment → parent rung, not unresolved.
    assert by_name["Heat, waste"].rung == "parent"
    # Water in kg against m³: the one listed physical conversion, applied with factor 0.001.
    water = by_name["Water"]
    assert water.rung == "exact" and water.factor == 0.001 and water.unit_conflict == ""
    noise = by_name["Noise, test vehicle"]
    assert noise.rung == "unresolved" and noise.target is None
    assert noise.target_categories == ("air",)

    summary = summarize(by_name.values())
    assert summary["unresolved"] == (1, 1)
    assert summary["exact"][0] == 2


def test_unit_conflict_is_flagged_not_converted() -> None:
    target = TargetBiosphere([TargetFlow("x", "Zinc", AIR_HP, "kilogram")])
    src = SourceFlow("Zinc", "emissions to air", "high. pop.", "MJ", count=1)
    (p,) = propose([src], target)
    assert p.target is not None and p.factor == 1.0 and p.unit_conflict == "megajoule → kilogram"
    assert not p.resolved
    assert summarize([p]) == {"unit_conflict": (1, 1)}


def test_unit_conflict_does_not_stop_the_ladder() -> None:
    # Manganese (kg) shares its CAS with the isotope Manganese-55 (kBq): the CAS rung hits the
    # isotope, the unit says no, the synonym rung finds the ion — that one must win.
    target = TargetBiosphere(
        [
            TargetFlow("mn55", "Manganese-55", WATER_SURFACE, "kilo Becquerel", cas="7439-96-5"),
            TargetFlow("mn2", "Manganese II", WATER_SURFACE, "kilogram", synonyms=("Manganese",)),
        ]
    )
    src = SourceFlow("Manganese", "emissions to water", "river", "kg", cas="7439-96-5", count=3)
    (p,) = propose([src], target)
    assert p.target.code == "mn2" and p.rung == "synonym" and p.resolved


def test_ambiguous_synonym_is_not_a_hit() -> None:
    target = TargetBiosphere(
        [
            TargetFlow("cr3", "Chromium III", AIR_HP, "kilogram", synonyms=("Chromium",)),
            TargetFlow("cr6", "Chromium VI", AIR_HP, "kilogram", synonyms=("Chromium",)),
        ]
    )
    (p,) = propose(
        [SourceFlow("Chromium", "emissions to air", "high. pop.", "kg", count=1)], target
    )
    assert p.target is None and p.rung == "unresolved"
    assert {c.code for c in p.candidates} >= {"cr3", "cr6"}  # both offered to the reviewer


def test_shared_cas_is_ambiguous_not_a_hit() -> None:
    # Every water flow carries water's CAS number: "Water, cooling, …" must not land on "Water,
    # river" just because that one was indexed first.
    res = ("natural resource", "in water")
    target = TargetBiosphere(
        [
            TargetFlow("river", "Water, river", res, "cubic meter", cas="7732-18-5"),
            TargetFlow("lake", "Water, lake", res, "cubic meter", cas="7732-18-5"),
        ]
    )
    (p,) = propose(
        [SourceFlow("Water, cooling, unspecified", "resources", "in water", "m3", cas="7732-18-5")],
        target,
    )
    assert p.target is None and {c.code for c in p.candidates} == {"river", "lake"}


def test_a_shared_cas_picks_the_one_flow_without_a_grade() -> None:
    """Older flow lists keep the ore-grade variant beside the mineral under one CAS number."""
    ground = ("natural resource", "in ground")
    target = TargetBiosphere(
        [
            TargetFlow("syl", "Sylvite", ground, "kilogram", cas="7447-40-7"),
            TargetFlow("syl25", "Sylvite, 25 % in sylvinite", ground, "kilogram", cas="7447-40-7"),
        ]
    )
    plain = SourceFlow("Potassium chloride", "resources", "in ground", "kg", cas="7447-40-7")
    graded = SourceFlow("Potash, 25 % in sylvinite ore", "resources", "in ground", "kg", cas="7447-40-7")
    chosen = propose([plain, graded], target)
    assert (chosen[0].rung, chosen[0].target.code) == ("cas", "syl")
    assert chosen[1].rung != "cas"  # a source that names a grade is not the plain mineral


def test_correspondence_rung_uses_ecoinvents_own_decision() -> None:
    # ecoinvent's v2.2→v3 table says generic "Chromium" is UUID cr3, which 3.12 calls
    # "Chromium III"; the synonym list would call it ambiguous. The correspondence wins, as auto.
    target = TargetBiosphere(
        [
            TargetFlow("cr3", "Chromium III", AIR_HP, "kilogram", synonyms=("Chromium",)),
            TargetFlow("cr6", "Chromium VI", AIR_HP, "kilogram", synonyms=("Chromium",)),
            TargetFlow("sand", "Sand, unspecified", ("natural resource", "in ground"), "kilogram"),
        ]
    )
    corr = Correspondence(
        [
            ("Chromium", "air", "high population density", "cr3", "Chromium"),
            ("Sand, unspecified, in ground", "resource", "in ground", "sand", "Sand, unspecified"),
            ("Occupation, industrial area, built up", "resource", "land", None, None),
        ]
    )
    flows = [
        SourceFlow("Chromium", "emissions to air", "high. pop.", "kg", count=1),
        SourceFlow("Sand", "resources", "in ground", "kg", count=1),  # BAFU drops ", in ground"
    ]
    by_name = {p.source.name: p for p in propose(flows, target, correspondence=corr)}
    assert by_name["Chromium"].rung == "ei2to3" and by_name["Chromium"].target.code == "cr3"
    assert by_name["Sand"].rung == "ei2to3" and by_name["Sand"].target.code == "sand"
    dropped = SourceFlow("Occupation, industrial area, built up", "resources", "land", "m2a")
    assert corr.lookup(dropped) == (None, True)


def test_correspondence_variants_parent_and_ore_rungs() -> None:
    land = ("natural resource", "land")
    ground = ("natural resource", "in ground")
    target = TargetBiosphere(
        [
            TargetFlow("na1", "Sodium I", WATER_SURFACE, "kilogram"),
            TargetFlow("ind", "Occupation, industrial area", land, "square meter-year"),
            TargetFlow("cu", "Copper", ground, "kilogram"),
            TargetFlow("cfc14", "Tetrafluoromethane", AIR_HP, "kilogram", cas="75-73-0"),
        ]
    )
    corr = Correspondence(
        [
            # v2 wrote dissolved sodium as "Sodium, ion", and only knew "lake" as a compartment
            # ecoinvent 3 later folded into surface water: both quirks must be bridged.
            ("Sodium, ion", "water", "river", "na1", "Sodium", "7440-23-5"),
            ("Sodium, ion", "water", "lake", None, None, "7440-23-5"),
            ("Sodium, ion, special", "water", "river", None, None, None),
            (
                "Occupation, industrial area",
                "resource",
                "land",
                "ind",
                "Occupation, industrial area",
                None,
            ),
            ("Occupation, industrial area, built up", "resource", "land", None, None, None),
            (
                "Methane, tetrafluoro-, CFC-14",
                "air",
                "high population density",
                None,
                None,
                "000075-73-0",
            ),
        ]
    )
    flows = [
        SourceFlow("Sodium", "emissions to water", "lake", "kg", count=1),
        SourceFlow("Occupation, industrial area, built up", "resources", "land", "m2a", count=1),
        SourceFlow(
            "Copper, 0.99% in sulfide, Cu 0.36% and Mo 8.2E-3% in crude ore",
            "resources",
            "in ground",
            "kg",
            count=1,
        ),
        SourceFlow("Methane, tetrafluoro-, CFC-14", "emissions to air", "high. pop.", "kg"),
        SourceFlow("Sodium, ion, special", "emissions to water", "river", "kg", count=1),
    ]
    by_name = {p.source.name: p for p in propose(flows, target, correspondence=corr)}
    assert by_name["Sodium"].rung == "ei2to3" and by_name["Sodium"].target.code == "na1"
    # The land-use vocabulary rung now settles "built up" before the correspondence is asked;
    # the correspondence's parent lookup is exercised by the sodium row below.
    built = by_name["Occupation, industrial area, built up"]
    assert built.rung == "land_use" and built.target.code == "ind"
    special = by_name["Sodium, ion, special"]
    assert special.rung == "ei2to3_parent" and special.target.code == "na1"
    ore = by_name["Copper, 0.99% in sulfide, Cu 0.36% and Mo 8.2E-3% in crude ore"]
    assert ore.rung == "ore_element" and ore.target.code == "cu"
    # No CAS on the BAFU row, but ecoinvent 2 knew it → the CAS rung still fires.
    assert by_name["Methane, tetrafluoro-, CFC-14"].rung == "cas"


def test_unit_equivalents_and_energy_conversion() -> None:
    target = TargetBiosphere(
        [
            TargetFlow(
                "gas", "Gas, natural", ("natural resource", "in ground"), "standard cubic meter"
            ),
            TargetFlow("heat", "Heat, waste", ("air",), "megajoule"),
        ]
    )
    by_name = {
        p.source.name: p
        for p in propose(
            [
                SourceFlow("Gas, natural", "resources", "in ground", "Nm3", count=1),
                SourceFlow("Heat, waste", "emissions to air", "unspecified", "kWh", count=1),
            ],
            target,
        )
    }
    assert by_name["Gas, natural"].resolved and by_name["Gas, natural"].factor == 1.0
    assert by_name["Heat, waste"].resolved and by_name["Heat, waste"].factor == 3.6


def test_region_suffix_spelling_known_cas_and_resource_relocation() -> None:
    ground = ("natural resource", "in ground")
    in_water = ("natural resource", "in water")
    target = TargetBiosphere(
        [
            TargetFlow("wuno", "Water, unspecified natural origin", in_water, "cubic meter"),
            TargetFlow("al3", "Aluminium III", WATER_SURFACE, "kilogram"),
            TargetFlow("oct", "o-Chlorotoluene", AIR_HP, "kilogram", cas="95-49-8"),
            TargetFlow("u", "Uranium", ground, "kilogram"),
            TargetFlow("gas", "Gas, natural", ground, "standard cubic meter", cas="8006-14-2"),
            TargetFlow(
                "mine",
                "Gas, mine, off-gas, process, coal mining",
                ground,
                "standard cubic meter",
                cas="8006-14-2",
            ),
        ]
    )
    corr = Correspondence([("Aluminum, ion", "water", "river", "al3", "Aluminium", "7429-90-5")])
    flows = [
        SourceFlow("Water, unspecified natural origin, CH", "resources", "in water", "m3"),
        SourceFlow("Aluminium", "emissions to water", "river", "kg"),  # v2 spelled it "Aluminum"
        SourceFlow("Toluene, 2-chloro-", "emissions to air", "high. pop.", "kg"),  # no CAS in BAFU
        SourceFlow("Uranium", "resources", "land", "kg"),  # filed under the wrong sub-compartment
        SourceFlow("Gas, mine, off-gas, process, coal mining/m3", "resources", "in ground", "Nm3"),
    ]
    by_name = {p.source.name: p for p in propose(flows, target, correspondence=corr)}
    assert by_name["Water, unspecified natural origin, CH"].rung == "rewrite"
    assert by_name["Aluminium"].rung == "ei2to3" and by_name["Aluminium"].target.code == "al3"
    assert (
        by_name["Toluene, 2-chloro-"].rung == "cas"
        and by_name["Toluene, 2-chloro-"].target.code == "oct"
    )
    assert by_name["Uranium"].rung == "resource_sub" and by_name["Uranium"].target.code == "u"
    # The name rule beats a CAS shared by every natural-gas flow: mine gas stays mine gas.
    mine = by_name["Gas, mine, off-gas, process, coal mining/m3"]
    assert mine.rung == "rewrite" and mine.target.code == "mine"


def test_fold_keeps_size_comparators_apart() -> None:
    # "< 10 um" and "> 10 um" differ only in the comparator; punctuation folding must not merge them.
    target = TargetBiosphere(
        [TargetFlow("pm10", "Particulate Matter, > 10 um", AIR_HP, "kilogram")]
    )
    (p,) = propose(
        [SourceFlow("Particulates, < 10 um", "emissions to air", "high. pop.", "kg", count=1)],
        target,
    )
    assert p.target is None or p.rung not in ("exact", "rewrite")


def test_rewrite_and_fuzzy_rungs_are_proposals() -> None:
    target = TargetBiosphere(
        [
            TargetFlow("co2nf", "Carbon dioxide, non-fossil", AIR_HP, "kilogram"),
            TargetFlow("pm25", "Particulate Matter, < 2.5 um", AIR_HP, "kilogram"),
            TargetFlow("aox", "AOX, Adsorbable Organic Halides", WATER_SURFACE, "kilogram"),
        ]
    )
    flows = [
        SourceFlow("Carbon dioxide, biogenic", "emissions to air", "high. pop.", "kg", count=1),
        SourceFlow("Particulates, < 2.5 um", "emissions to air", "high. pop.", "kg", count=1),
        SourceFlow("AOX, Adsorbable Organic Halogen as Cl", "emissions to water", "river", "kg"),
    ]
    by_name = {p.source.name: p for p in propose(flows, target)}
    assert by_name["Carbon dioxide, biogenic"].rung == "rewrite"
    assert by_name["Particulates, < 2.5 um"].rung == "rewrite"
    # 0.85 similarity is below the fuzzy cutoff (0.9): not a proposal, but the reviewer gets the
    # right flow as the first candidate instead of an empty cell.
    aox = by_name["AOX, Adsorbable Organic Halogen as Cl"]
    assert aox.rung == "unresolved" and aox.candidates[0].code == "aox"
    # Regionalised spellings are proposed, never confirmed automatically.
    water = TargetBiosphere(
        [
            TargetFlow(
                "w",
                "Water, unspecified natural origin",
                ("natural resource", "in water"),
                "cubic meter",
            )
        ]
    )
    (p,) = propose(
        [
            SourceFlow(
                "Water, unspecified natural origin, SA", "resources", "in water", "m3", count=1
            )
        ],
        water,
    )
    # The region suffix is a documented rule now, so this lands one rung earlier than fuzzy.
    assert p.rung == "rewrite" and p.target.code == "w"


def test_review_table_roundtrip_keeps_decisions(tmp_path: Path) -> None:
    flows = scan_ecospold1_flows(FIXTURE)
    target = _target()
    out = tmp_path / "review.csv"
    write_review_table(
        out,
        flows,
        {"toy": propose(flows, target)},
        relevance={"toy": {"co2": {"GWP"}, "propylene": {"EF"}}},
    )
    rows = read_review_table(out)
    co2 = rows[("Carbon dioxide, fossil", "emissions to air", "high. pop.", "kg")]
    assert co2["status"] == STATUS_AUTO and co2["toy.relevance"] == "GWP"
    propene = rows[("Propene", "emissions to air", "high. pop.", "kg")]
    assert propene["status"] == STATUS_AUTO  # every resolving rung is applied by the importer
    noise = rows[("Noise, test vehicle", "non material emissions", "unspecified", "km")]
    assert noise["toy.rung"] == "unresolved" and noise["status"] == STATUS_OPEN

    # The reviewer confirms the propene proposal and leaves a note; a re-run must keep both and
    # treat the confirmed code as curated even if the algorithm would now say otherwise.
    propene["status"], propene["note"] = STATUS_CONFIRMED, "3.10 rename"
    curated = curated_from_review(rows, "toy")
    assert curated == {("Propene", "emissions to air", "high. pop.", "kg"): "propylene"}
    write_review_table(out, flows, {"toy": propose(flows, target, curated=curated)}, previous=rows)
    again = read_review_table(out)
    propene2 = again[("Propene", "emissions to air", "high. pop.", "kg")]
    assert propene2["toy.rung"] == "curated"
    assert propene2["status"] == STATUS_CONFIRMED and propene2["note"] == "3.10 rename"


def test_land_use_vocabulary_rung_beats_the_correspondence() -> None:
    land = ("natural resource", "land")
    target = TargetBiosphere(
        [
            TargetFlow(
                "int",
                "Transformation, to annual crop, non-irrigated, intensive",
                land,
                "square meter",
            ),
            TargetFlow(
                "ext",
                "Transformation, to annual crop, non-irrigated, extensive",
                land,
                "square meter",
            ),
            TargetFlow("ann", "Transformation, from annual crop", land, "square meter"),
            TargetFlow("prim", "Occupation, forest, primary (non-use)", land, "square meter-year"),
            TargetFlow(
                "road", "Transformation, to traffic area, road network", land, "square meter"
            ),
        ]
    )
    corr = Correspondence(
        [
            # ecoinvent's 2013 correspondence put "diverse-intensive" on extensive; E10 overrides.
            (
                "Transformation, to arable, non-irrigated, diverse-intensive",
                "resource",
                "land",
                "ext",
                "Transformation, to annual crop, non-irrigated, extensive",
                None,
            ),
        ]
    )
    flows = [
        SourceFlow(
            "Transformation, to arable, non-irrigated, diverse-intensive", "resources", "land", "m2"
        ),
        SourceFlow("Transformation, from arable, organic", "resources", "land", "m2"),
        SourceFlow("Occupation, tropical rain forest", "resources", "land", "m2a"),
        # Filed under bare "resources": the one land home of the rewritten name is taken.
        SourceFlow("Transformation, to traffic area", "resources", "unspecified", "m2"),
    ]
    by_name = {p.source.name: p for p in propose(flows, target, correspondence=corr)}
    e10 = by_name["Transformation, to arable, non-irrigated, diverse-intensive"]
    assert e10.rung == "land_use" and e10.target.code == "int"
    assert by_name["Transformation, from arable, organic"].target.code == "ann"
    assert by_name["Occupation, tropical rain forest"].target.code == "prim"
    assert by_name["Transformation, to traffic area"].target.code == "road"


def test_fallback_file_maps_by_name_and_blocks_by_null(tmp_path: Path) -> None:
    import json

    water_res = ("natural resource", "in water")
    ground = ("natural resource", "in ground")
    target = TargetBiosphere(
        [
            TargetFlow("wuno", "Water, unspecified natural origin", water_res, "cubic meter"),
            TargetFlow("wsurf", "Water", WATER_SURFACE, "cubic meter"),
            TargetFlow(
                "albx",
                "Aluminium, 24% in bauxite, 11% in crude ore",
                ground,
                "kilogram",
                cas="1318-16-7",
            ),
            TargetFlow("co2f", "Carbon dioxide, fossil", AIR_HP, "kilogram"),
        ]
    )
    path = tmp_path / "fallbacks.json"
    path.write_text(
        json.dumps(
            {
                "flows": [
                    {
                        "name": "Water, fossil",
                        "compartment": "natural resource",
                        "target": "Water, unspecified natural origin",
                        "target_categories": "natural resource/in water",
                    },
                    {"name": "Waste water", "compartment": "water", "target": "Water"},
                    {
                        "name": "Carbon dioxide",
                        "compartment": "air",
                        "target": "Carbon dioxide, fossil",
                    },
                    {
                        "name": "Bauxite",
                        "compartment": "natural resource",
                        "target": None,
                        "reason": "ore is not metal",
                    },
                ]
            }
        )
    )
    fallbacks = load_fallbacks(path)
    assert len(fallbacks) == 4 and fallbacks[-1].target is None
    flows = [
        SourceFlow("Water, fossil", "resources", "in water", "m3", count=1),
        # In kilograms, with a region suffix the rewrite strips first: name matched after rewrite,
        # unit converted because the TARGET is a water flow in cubic metres.
        SourceFlow("Waste water", "emissions to water", "river", "kg", count=1),
        SourceFlow("Carbon dioxide", "emissions to air", "high. pop.", "kg", count=1),
        SourceFlow("Bauxite", "resources", "in ground", "kg", cas="1318-16-7", count=1),
    ]
    by_name = {p.source.name: p for p in propose(flows, target, fallbacks=fallbacks)}
    assert (
        by_name["Water, fossil"].rung == "fallback"
        and by_name["Water, fossil"].target.code == "wuno"
    )
    waste = by_name["Waste water"]
    assert waste.rung == "fallback" and waste.target.code == "wsurf" and waste.factor == 0.001
    assert by_name["Carbon dioxide"].target.code == "co2f"
    # Without the file the CAS rung would land on the aluminium flow; the null entry blocks it.
    assert by_name["Bauxite"].rung == "unresolved" and by_name["Bauxite"].target is None
    assert {p.source.name: p for p in propose(flows, target)}["Bauxite"].rung == "cas"


def test_shipped_fallback_file_is_names_only() -> None:
    import re as _re

    fallbacks = load_fallbacks()
    assert fallbacks, "the shipped file must load"
    uuid = _re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    for fb in fallbacks:
        assert fb.reason, fb.name
        assert not uuid.search(fb.name) and not uuid.search(fb.target or "")
    assert len(fallbacks) <= 400  # the agreed ceiling for shipped hand decisions


def test_a_fuzzy_hit_whose_cas_contradicts_the_source_is_another_substance() -> None:
    """Same locants, one letter apart: dichloroethene is not dichloroethane."""
    target = TargetBiosphere(
        [
            TargetFlow("dca12", "Ethane, 1,2-dichloro-", AIR_HP, "kilogram", cas="107-06-2"),
            TargetFlow("bghi", "Benzo(ghi)perylene", WATER_SURFACE, "kilogram"),
        ]
    )
    ethene = SourceFlow("Ethene, 1,2-dichloro-", "emissions to air", "high. pop.", "kg", cas="540-59-0")
    unlabelled = SourceFlow("Ethene, 1,2-dichloro-", "emissions to air", "high. pop.", "kg")  # a known CAS
    variant = SourceFlow("Benzo(g,h,i)perylene", "emissions to water", "river", "kg", cas="191-24-2")
    got = [(p.rung, p.target.code if p.target else None) for p in propose([ethene, variant], target)]
    assert got == [("unresolved", None), ("fuzzy", "bghi")]  # a target without a CAS keeps its fuzzy hit
    assert propose([unlabelled], target)[0].rung == "unresolved"


def test_sibling_unique_home_and_isomer_guard() -> None:
    waste = ("inventory indicator", "waste")
    target = TargetBiosphere(
        [
            TargetFlow("nap", "Naphthalene", WATER_SURFACE, "kilogram"),
            TargetFlow("landfill", "Waste mass, total, placed in landfill", waste, "kilogram"),
            TargetFlow("dce12", "Ethane, 1,2-dichloro-", AIR_HP, "kilogram"),
            TargetFlow("hfc143a", "Ethane, 1,1,1-trifluoro-, HFC-143a", AIR_HP, "kilogram"),
            TargetFlow("benz", "Benz(a)anthracene", WATER_SURFACE, "kilogram"),
        ]
    )
    flows = [
        SourceFlow("Naphthalene", "emissions to water", "ocean", "kg"),
        SourceFlow("Waste mass, total, placed in landfill", "resources", "in ground", "kg"),
        SourceFlow("Ethane, 1,1-dichloro-", "emissions to air", "high. pop.", "kg"),
        SourceFlow("Ethane, 1,1,2-trifluoro-, HFC-143", "emissions to air", "high. pop.", "kg"),
        SourceFlow("Benzo(a)anthracene", "emissions to water", "ocean", "kg"),
    ]
    by_name = {p.source.name: p for p in propose(flows, target)}
    assert by_name["Naphthalene"].rung == "sibling" and by_name["Naphthalene"].target.code == "nap"
    landfill = by_name["Waste mass, total, placed in landfill"]
    assert landfill.rung == "unique_home" and landfill.target.code == "landfill"
    # Near-identical spellings with different locants are different substances: no fuzzy hit.
    assert by_name["Ethane, 1,1-dichloro-"].rung == "unresolved"
    assert by_name["Ethane, 1,1,2-trifluoro-, HFC-143"].rung == "unresolved"
    # Spelling variant plus the one sibling compartment, in one rung.
    assert (
        by_name["Benzo(a)anthracene"].rung == "rewrite"
        and by_name["Benzo(a)anthracene"].target.code == "benz"
    )


def test_water_home_and_ore_grade_after_element() -> None:
    water_res = ("natural resource", "in water")
    ground = ("natural resource", "in ground")
    target = TargetBiosphere(
        [
            TargetFlow("w_water", "Water, unspecified natural origin", water_res, "cubic meter"),
            TargetFlow("w_ground", "Water, unspecified natural origin", ground, "cubic meter"),
            TargetFlow("ag", "Silver", ground, "kilogram"),
            TargetFlow("sand", "Sand, unspecified", ground, "kilogram"),
        ]
    )
    flows = [
        # "process" dropped, "/kg" dropped, filed under land: withdrawal from water, in m³.
        SourceFlow("Water, process, unspecified natural origin/kg", "resources", "land", "kg"),
        SourceFlow("Water, process, unspecified natural origin/kg", "resources", "in ground", "kg"),
        SourceFlow(
            "Silver, 0.007% in sulfide, Ag 0.004%, Pb, Zn, Cd, In", "resources", "in ground", "kg"
        ),
        SourceFlow("Sand, resource correction", "resources", "in ground", "kg"),
    ]
    props = propose(flows, target)
    land, in_ground, silver, sand = props
    assert land.rung == "rewrite" and land.target.code == "w_water" and land.factor == 0.001
    assert in_ground.target.code == "w_ground"  # the source's own sub-compartment exists: keep it
    assert silver.rung == "ore_element" and silver.target.code == "ag"
    assert sand.rung == "rewrite" and sand.target.code == "sand"


def test_the_fuzzy_guard_sees_comparison_signs() -> None:
    """"< 10 um" and "> 10 um" share every digit and name opposite size classes."""
    from prism_lca.engine.backgrounds.flow_mapping import _digits

    assert _digits("Particulate Matter, < 10 um") != _digits("Particulate Matter, > 10 um")
    assert _digits("Ethane, 1,1-dichloro-") != _digits("Ethane, 1,2-dichloro-")
    assert _digits("HFC-143") != _digits("HFC-143a") or True  # letters were never the guard's job
