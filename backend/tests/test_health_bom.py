"""The health check's entry on the bill-of-materials research: every recorded part mass listed, none compared.

Nothing ties a logged part to the exchange that books it, so the entry does not decide whether a part is in
the model. A check that matched figures did: on a pavilion run it found ground pegs (0.2 kg, sourced from the
manufacturer's manual) that sat only in the shipping weight and in a dormant end-of-life branch — and it also
let a paint exchange of the same mass answer for such pegs, and reported timber booked by the cubic metre as
missing. The list keeps every row; the pegs' pattern survives as a remark on the row.
"""
from types import SimpleNamespace
from unittest.mock import patch

from prism_lca.engine import health, health_bom
from prism_lca.engine.research_log import clean_entry


def _bom(product: str, *findings: dict, asked: str = "2026-11-14T18:00:00Z") -> dict:
    return {"question": f"Bill of materials: {product}", "asked": asked, "findings": list(findings)}


def _part(component: str, mass: float, **more) -> dict:
    return {"text": f"{component}: {mass} kg", "component": component, "mass_kg": mass, **more}


def _run(entries: list[dict], params: list[dict], exchanges: list[tuple]) -> health_bom.OnRecord | None:
    with (
        patch("prism_lca.engine.research_log.ResearchLogStore.list", return_value=entries),
        patch("prism_lca.engine.params.list_params", return_value=params),
    ):
        return health_bom.research_on_record("any-model", exchanges)


def _rows(record: health_bom.OnRecord) -> list[str]:
    return [line for line in record.message.split("\n") if line.startswith("- ")]


def test_a_model_without_researched_part_masses_gets_no_entry():
    assert _run([], [], [("kilogram", 1.0, "")]) is None
    web = {"question": "Recycling rate of steel in Germany", "findings": [{"text": "87 %", "sources": ["https://x"]}]}
    assert _run([web], [], []) is None


def test_no_number_in_the_model_takes_a_row_off_the_list():
    """The cases the figure matching got wrong, each of them a row now: an exchange of the same mass that is
    another part's (pegs against paint), a part booked at exactly its figure, one exchange in the neighbourhood
    of ten parts."""
    pegs = _run(
        [_bom("pavilion", _part("ground pegs", 0.2))],
        [{"name": "m_pegs", "amount": 0.2, "unit": "kg"}],
        [("kilogram", 0.2, "")],
    )
    assert pegs.parts == 1 and _rows(pegs) == ["- ground pegs: 0.2 kg"]
    ten = _run(
        [_bom("rack", *[_part(f"part {i}", round(0.7 + 0.08 * i, 2)) for i in range(10)])],
        [],
        [("kilogram", 1.0, "")],
    )
    assert ten.parts == 10 and len(_rows(ten)) == 10 and ten.remarks == []


def test_the_entry_says_that_it_compared_nothing():
    record = _run([_bom("pavilion", _part("ground pegs", 0.2))], [], [])
    head = record.message.split("\n")[0]
    assert head.startswith("The bill-of-materials research has 1 part mass on record")
    assert "compares none of them with the model" in head
    assert "a row without a remark has NOT been found" in head
    assert "not that a part is missing" in head
    # What a reader does with it, and what never to do with it.
    assert "inside another part" in head and "judge by the amounts and the sources, not by comments" in head
    assert "left out where the study's cut-off criteria allow it" in head
    assert "needs nothing added" in head and "is still one part" in head
    assert "a loss allowance or a rounding on top of the researched mass is modelling" in head
    assert "A row's mass is that of all its pieces together." in head
    assert "never modelled" not in head
    several = _run([_bom("pavilion", _part("pegs", 0.2), _part("roof", 2.2))], [], [])
    assert "has 2 part masses on record" in several.message


def test_namesakes_stay_two_rows_under_the_products_they_were_researched_for():
    record = _run(
        [
            _bom("frame", _part("screws", 0.2), asked="2026-11-14T18:00:00Z"),
            _bom("lid", _part("screws", 0.4), asked="2026-11-15T18:00:00Z"),
        ],
        [],
        [("kilogram", 0.2, "")],
    )
    assert record.message.split("\n")[1:] == [
        "For 'frame' (asked 2026-11-14):",
        "- screws: 0.2 kg",
        "For 'lid' (asked 2026-11-15):",
        "- screws: 0.4 kg",
    ]


def test_a_part_researched_again_is_two_records_under_one_product():
    record = _run(
        [
            _bom("rack", _part("boards", 7.65), asked="2026-11-14T18:00:00Z"),
            _bom("rack", _part("boards", 6.12), asked="2026-11-15T18:00:00Z"),
        ],
        [],
        [],
    )
    assert record.parts == 2
    assert record.message.split("\n")[1:] == [
        "For 'rack' (asked 2026-11-14, 2026-11-15):",
        "- boards: 7.65 kg",
        "- boards: 6.12 kg",
    ]


def test_a_row_carries_what_the_log_knows_of_the_figure():
    record = _run(
        [
            _bom(
                "wheelbarrow",
                {
                    "text": "handles (beech) (2 pieces): 0.2 kg",
                    "component": "handles",
                    "mass_kg": 0.2,
                    "mass_range_kg": [0.18, 0.25],
                    "alternatives_kg": [0.23, 0.3],
                    "version": "PRAKTICA 150",
                    "source_class": "media",
                    "confidence": "medium",
                    "sources": ["https://www.shop.example/garden/holzgriff", "https://www.shop.example/garden/holzgriff"],
                    "note": "two handles of 0.1 kg",
                },
            )
        ],
        [],
        [],
    )
    assert _rows(record) == [
        "- handles (beech) (2 pieces): 0.2 kg (range 0.18–0.25 kg) (version: PRAKTICA 150) "
        "(alternatives found: 0.23 kg, 0.3 kg) [media/medium] — shop.example/holzgriff"
    ]


def test_a_row_counted_without_a_source_says_so():
    record = _run([_bom("rack", _part("frame", 9, sources=["https://e.org/frame"]),
                        _part("shelves", 4, sources=[], unsourced=True))], [], [])
    assert _rows(record) == [
        "- frame: 9 kg — e.org/frame",
        "- shelves: 4 kg — NO SOURCE: the research counted this mass without a page behind it",
    ]
    merged = _run([_bom("soap", _part("water", 0.4595, sources=["https://s.example/sles"], unsourced_kg=0.35))],
                  [], [])
    assert _rows(merged) == ["- water: 0.4595 kg — s.example/sles — NO SOURCE for 0.35 kg of it"]


def test_a_row_the_chat_or_the_user_gave_says_who_gave_it():
    record = _run([_bom("barrow",
                        _part("tub", 11, sources=["https://shop.example/tub"], origin="assistant"),
                        _part("frame", 6.4, sources=[], unsourced=True, origin="assistant"),
                        _part("wheel", 2.5, sources=[], origin="user"))], [], [])
    assert _rows(record) == [
        "- tub: 11 kg — shop.example/tub — given by the assistant",
        "- frame: 6.4 kg — given by the assistant — NO SOURCE: the assistant counted this mass without a page behind it",
        "- wheel: 2.5 kg — stated by the user",
    ]


def test_a_row_whose_page_no_lookup_backs_says_so():
    record = _run([_bom("shelf",
                        _part("boards", 5.76, sources=["https://www.praxis.example/10322182"], cited_by_search=False,
                              origin="assistant"),
                        _part("beams", 2, sources=["https://shop.example/beam"], cited_by_search=False),
                        _part("feet", 0.04, sources=["https://shop.example/feet"], cited_by_search=True))], [], [])
    assert _rows(record) == [
        "- boards: 5.76 kg — praxis.example/10322182 — given by the assistant (source on no record of the chat)",
        "- beams: 2 kg — shop.example/beam (source not returned by the search engine)",
        "- feet: 0.04 kg — shop.example/feet",
    ]


def test_a_given_row_says_how_it_was_got_and_a_page_beside_a_users_figure_is_not_its_check():
    record = _run([_bom("door",
                        _part("strip", 0.65, sources=["https://forza.example/epd.pdf"], cited_by_search=True,
                              origin="user", note="Re-weighed by the user: 0.65 kg (the EPD states 0.6 kg)"),
                        _part("core", 56.2, sources=["https://forza.example/epd.pdf"], cited_by_search=True,
                              origin="assistant", note="EPD table 4"))], [], [])
    assert _rows(record) == [
        "- strip: 0.65 kg — forza.example/epd.pdf — stated by the user (the page beside it is not checked against "
        "this figure) — how: Re-weighed by the user: 0.65 kg (the EPD states 0.6 kg)",
        "- core: 56.2 kg — forza.example/epd.pdf — given by the assistant — how: EPD table 4",
    ]


def test_the_pegs_case_is_a_remark_on_its_row():
    """The parameter holds the researched mass and reaches the shipping weight and a switched-off end-of-life
    amount, and no production input. The 0.2 kg of paint beside it is nobody's answer any more."""
    record = _run(
        [_bom("pavilion", _part("ground pegs", 0.2), _part("roof", 2.2))],
        [
            {"name": "heringe_masse", "amount": 0.2, "unit": "kg"},
            {"name": "dach_masse", "amount": 2.2, "unit": "kg"},
        ],
        [
            ("ton kilometer", 1.2, "(gestell_masse + heringe_masse + dach_masse) / 1000 * 500"),
            ("kilogram", 0.0, "-(1 - eol_stahl_recycling) * heringe_masse"),
            ("kilogram", 0.2, ""),
            ("kilogram", 2.2, "dach_masse"),
        ],
    )
    lines = record.message.split("\n")
    at = lines.index("- ground pegs: 0.2 kg")
    assert lines[at + 1] == (
        "    Remark: parameter 'heringe_masse' has this value, and no formula leads from it to a positive input "
        "other than transport, energy or time (it leads to inputs in ton kilometer; amounts that evaluate to zero)."
    )
    assert record.remarks == [f"'ground pegs' (0.2 kg): {lines[at + 1].removeprefix('    Remark: ')}"]
    assert not lines[lines.index("- roof: 2.2 kg") + 1 :]  # the roof's parameter leads to its input: no remark


def test_a_parameter_that_leads_to_a_positive_input_draws_no_remark():
    for exchanges, params in (
        ([("kilogram", 0.21, "m_pegs * (1 + loss)")], []),
        ([("cubic meter", 0.0003, "m_pegs / density")], []),  # booked as a volume through its parameter
        ([("unit", 4.0, "m_pegs / 0.05")], []),  # as pieces
        ([("kilogram", 1.3, "m_steel")], [{"name": "m_steel", "amount": 1.3, "formula": "m_frame + m_pegs", "unit": "kg"}]),
    ):
        record = _run(
            [_bom("pavilion", _part("ground pegs", 0.2))],
            [{"name": "m_pegs", "amount": 0.2, "unit": "kg"}, *params],
            exchanges,
        )
        assert record.remarks == [], exchanges


def test_a_parameter_that_only_reaches_waste_or_nothing_is_said_so():
    """Handles typed in as a volume, their parameter feeding the wood disposal alone: the remark is true of the
    parameter, and the row's reader finds the volume. An unused parameter is named as unused."""
    waste = _run(
        [_bom("wheelbarrow", _part("handles", 0.2))],
        [{"name": "masse_griffe_kg", "amount": 0.2, "unit": "kg"}],
        [("kilogram", -0.0488, "-masse_griffe_kg * eol_holz_verbrennung"), ("cubic meter", 0.000238, "")],
    )
    assert "(it leads to negative amounts (waste or end of life))" in waste.remarks[0]
    unused = _run(
        [_bom("pavilion", _part("ground pegs", 0.2))],
        [{"name": "m_pegs", "amount": 0.2, "unit": "kg"}],
        [("kilogram", 0.2, ""), ("kilogram", 3.0, "m_roof")],
    )
    assert "(no exchange formula uses it)" in unused.remarks[0]


def test_only_a_parameter_holding_the_value_itself_is_remarked_on():
    """A neighbouring mass is another part's parameter: 0.3 kg of connectors beside 0.2 kg of pegs, 0.21 beside
    0.2. A unit conversion is the same value."""
    record = _run(
        [_bom("pavilion", _part("ground pegs", 0.2))],
        [
            {"name": "m_connectors", "amount": 0.3, "unit": "kg"},
            {"name": "m_almost", "amount": 0.21, "unit": "kg"},
            {"name": "share", "amount": 0.2, "unit": "Anteil"},
            {"name": "km", "amount": 0.2, "unit": "km"},
        ],
        [],
    )
    assert record.remarks == []
    grams = _run([_bom("pavilion", _part("ground pegs", 0.2))], [{"name": "m_pegs_g", "amount": 200, "unit": "g"}], [])
    assert grams.remarks and "'m_pegs_g'" in grams.remarks[0]


def test_a_rate_a_share_or_a_flow_with_the_same_number_is_no_mass_of_the_part():
    """0.2 kg/m² of coating, a 0.2 kg/kg share and 0.2 kg a year are other quantities than 0.2 kg of pegs. A mass
    per piece or per product is how a part's mass is declared."""
    def remarks(unit: str) -> list[str]:
        return _run([_bom("pavilion", _part("ground pegs", 0.2))], [{"name": "p", "amount": 0.2, "unit": unit}], []).remarks

    for unit in ("kg/m2", "kg/m³", "kg/kg", "kg/a", "kg/kWh", "g/m"):
        assert remarks(unit) == [], unit
    for unit in ("kg", "kg/piece", "kg/unit", "kg/Stück", "kg / Regal"):
        assert remarks(unit), unit


def test_of_two_parameters_with_the_value_the_one_that_leads_nowhere_is_named():
    record = _run(
        [_bom("pavilion", _part("ground pegs", 0.2))],
        [{"name": "m_paint", "amount": 0.2, "unit": "kg"}, {"name": "m_pegs", "amount": 0.2, "unit": "kg"}],
        [("kilogram", 0.2, "m_paint")],
    )
    assert len(record.remarks) == 1
    assert "'m_pegs'" in record.remarks[0] and "m_paint" not in record.remarks[0]


def test_every_service_unit_spelling_is_no_candidate_and_an_unknown_unit_still_is():
    def remarks(unit: str) -> list[str]:
        return _run(
            [_bom("x", _part("part", 0.2))],
            [{"name": "m_part", "amount": 0.2, "unit": "kg"}],
            [(unit, 1.0, "m_part * 5")],
        ).remarks

    for unit in ("ton kilometer", "tkm", "kilowatt hour", "kWh", "megajoule", "MJ", "hour"):
        assert remarks(unit), unit
    for unit in ("kilogram", "cubic meter", "square meter", "meter", "unit", "Stück", "bag"):
        assert remarks(unit) == [], unit


def test_a_figure_subtracted_on_its_way_draws_no_remark():
    """Names, not directions: `rest = total - part` leads the part's parameter to the input that uses the rest.
    A remark that is missing is the side this may err on — the row is there either way."""
    record = _run(
        [_bom("recipe", _part("additives", 0.2))],
        [
            {"name": "m_additives", "amount": 0.2, "unit": "kg"},
            {"name": "m_rest", "amount": 0.8, "formula": "1 - m_additives", "unit": "kg"},
        ],
        [("kilogram", 0.8, "m_rest")],
    )
    assert record.parts == 1 and record.remarks == []


def test_a_number_or_a_comment_that_merely_spells_the_name_is_no_path():
    record = _run(
        [_bom("x", _part("part", 0.2))],
        [{"name": "e3", "amount": 0.2, "unit": "kg"}],
        [("kilogram", 1000.0, "1e3")],
    )
    assert "(no exchange formula uses it)" in record.remarks[0]


def test_unreadable_parameters_leave_the_list_without_remarks():
    with (
        patch("prism_lca.engine.research_log.ResearchLogStore.list", return_value=[_bom("x", _part("part", 0.2))]),
        patch("prism_lca.engine.params.list_params", side_effect=ValueError("broken parameter file")),
    ):
        record = health_bom.research_on_record("any-model", [])
    assert record.parts == 1 and record.remarks == []


def test_old_log_entries_are_read_from_their_text():
    """Entries logged before the masses were stored structured carry the same figure in prose — the tool has
    always written 'component (material): X kg'. Only a bill-of-materials call is read that way: a web finding
    that ends on a mass is no part."""
    record = _run(
        [
            _bom("pavilion", {"text": "ground pegs/fixings (galvanized steel): 0.2 kg", "sources": ["https://x"]}),
            {"question": "How much zinc does galvanising add?", "findings": [{"text": "typical coating: 0.14 kg"}]},
        ],
        [],
        [],
    )
    assert _rows(record) == ["- ground pegs/fixings (galvanized steel): 0.2 kg — x"]


def test_a_check_a_derivation_a_container_and_an_alternative_are_never_rows():
    """Whole-product masses of a check, the derivation of a figure, an entry that contains other listed parts
    and the page of another figure are kept by the log as what was found, not as part masses."""
    entry = clean_entry({
        "question": "Bill of materials: rack",
        "findings": [
            {"text": "boards (HDF) (5 pieces): 7.65 kg", "sources": ["https://x"], "component": "boards",
             "mass_kg": 7.65, "note": "frame: 13 kg total minus boards — 1.53 kg"},
            {"text": "wheel: 2.5 kg — contains axle, listed separately, so not a mass to book whole"},
            {"text": 'Alternative figure for "boards": 6.12 kg (4 mm) — not counted (the research counted 7.65 kg)'},
        ],
        "bom_check": {"summary": "Checked against the researched total 13 kg: 13 kg",
                      "unresolved": [{"component": "frame", "reason": "no_mass", "note": "frame: 5.35 kg"}],
                      "totals": [{"mass_kg": 13, "basis": "net"}, {"mass_kg": 24, "basis": "unknown"}]},
    })
    record = _run([entry], [], [])
    assert record.parts == 1 and _rows(record) == ["- boards (HDF) (5 pieces): 7.65 kg — x"]


def test_a_long_log_lists_its_newest_rows_and_counts_the_rest():
    entries = [_bom(f"product {i}", *[_part(f"part {i}.{j}", 1 + j) for j in range(8)]) for i in range(10)]
    record = _run(entries, [], [])
    assert record.parts == 80 and len(_rows(record)) == health_bom.MAX_ROWS
    assert "(20 earlier part masses are on record and not listed here; the 60 most recent follow.)" in record.message
    assert _rows(record)[-1] == "- part 9.7: 8 kg" and "part 0.0" not in record.message


def test_long_names_are_cut_and_the_mass_stays():
    long = "Stahlrohrrahmen " + "mit Streben und Steckverbindern " * 8
    record = _run([_bom("wheelbarrow " * 20, _part(long.strip(), 6.0))], [], [])
    row = _rows(record)[0]
    assert row.endswith("…: 6 kg") and len(row) < 130
    assert len(record.message.split("\n")[1]) < 130
    # The number of pieces survives the cut: it says whether 7.65 kg is one board or five.
    boards = {"text": f"boards ({'HDF ' * 40}) (5 pieces): 7.65 kg", "component": "boards", "mass_kg": 7.65}
    row = _rows(_run([_bom("rack", boards)], [], []))[0]
    assert row.endswith("… (5 pieces): 7.65 kg") and len(row) < 130


def test_the_health_check_carries_one_info_entry_with_its_remarks():
    ctx = SimpleNamespace(database="any-model", exchange_records=[("ton kilometer", 1.0, "m_pegs * 5")])
    with (
        patch(
            "prism_lca.engine.research_log.ResearchLogStore.list",
            return_value=[_bom("pavilion", _part("ground pegs", 0.2), _part("roof", 2.2))],
        ),
        patch("prism_lca.engine.params.list_params", return_value=[{"name": "m_pegs", "amount": 0.2, "unit": "kg"}]),
    ):
        (finding,) = health._rule_bom_on_record(ctx)
    assert finding["severity"] == "info" and finding["code"] == "bom_research_on_record"
    assert finding["parts"] == 2 and len(finding["remarks"]) == 1 and finding["activity"] is None
    with patch("prism_lca.engine.research_log.ResearchLogStore.list", return_value=[]):
        assert health._rule_bom_on_record(ctx) == []
    with patch("prism_lca.engine.research_log.ResearchLogStore.list", side_effect=OSError("unreadable")):
        assert health._rule_bom_on_record(ctx) == []


def test_clean_entry_keeps_the_judgement_and_the_figure_and_drops_free_text():
    entry = clean_entry(
        {
            "question": "Bill of materials: pavilion",
            "findings": [
                {
                    "text": "frame: 9 kg",
                    "sources": ["https://a"],
                    "component": "frame",
                    "mass_kg": 9,
                    "source_class": "industry",
                    "confidence": "medium",
                    "confidence_note": "three comparable products agree",
                },
                {
                    "text": "roof: 2.2 kg",
                    "sources": ["https://b"],
                    "source_class": "very trustworthy",  # not in the closed set — dropped
                    "confidence": "4",  # numeric scales are exactly what we refused
                    "mass_kg": -1,  # nonsense mass — dropped
                },
            ],
        }
    )
    first, second = entry["findings"]
    assert first["component"] == "frame" and first["mass_kg"] == 9.0
    assert first["source_class"] == "industry" and first["confidence"] == "medium"
    assert first["confidence_note"].startswith("three comparable")
    assert "source_class" not in second and "confidence" not in second and "mass_kg" not in second


def test_clean_entry_keeps_the_other_figures_only_beside_a_figure_of_its_own():
    entry = clean_entry(
        {
            "question": "Bill of materials: refill pouch",
            "findings": [
                {"text": "pouch: 0.0102 kg", "component": "pouch", "mass_kg": 0.0102,
                 "alternatives_kg": [0.0103, "0.012", True, -1, 0.01206, 0.011, 0.0099, 0.0098]},
                {"text": "spout", "alternatives_kg": [0.002]},
            ],
        }
    )
    pouch, spout = entry["findings"]
    # Strings, booleans and non-positive figures go; at most four stay.
    assert pouch["alternatives_kg"] == [0.0103, 0.01206, 0.011, 0.0099]
    assert "alternatives_kg" not in spout
