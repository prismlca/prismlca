"""The unwatched hand-over, watched: researched component masses vs. what the model books.

On the 2026-08-29 pavilion run the BOM researcher found the ground pegs (0.2 kg, sourced from the
manufacturer's own manual) and the modeller then booked them nowhere on the production side — they
sat in the shipping weight and in a dormant end-of-life branch. The research had delivered, the
model computed consistently, and no check compared the two.
"""
from unittest.mock import patch

from prism_lca.engine import health_bom
from prism_lca.engine.research_log import clean_entry


def _run(findings: list[dict], params: list[dict], exchanges: list[tuple]) -> list[tuple[str, str]]:
    entries = [{"question": "Bill of materials: test product", "findings": findings}]
    with (
        patch("prism_lca.engine.research_log.ResearchLogStore.list", return_value=entries),
        patch("prism_lca.engine.params.list_params", return_value=params),
    ):
        return health_bom.bom_items_unbooked("any-model", exchanges)


def test_the_pegs_case_a_figure_parked_in_a_dormant_branch():
    """The parameter carries the researched mass, but its only formula evaluates to zero — the
    production side was never modelled. That is the finding, and it names the carrier. The 0.22-kg
    bystander exchange is the live regression: a coincidental neighbouring mass must not answer for
    a parameter that exists and feeds nothing (measured on the pavilion model, 2026-08-29)."""
    found = _run(
        [{"text": "ground pegs (galvanized steel): 0.2 kg", "component": "ground pegs", "mass_kg": 0.2}],
        [
            {"name": "heringe_masse", "amount": 0.2, "unit": "kg"},
            # The second live regression: 0.3 kg sits at exactly 1.5x of 0.2 and feeds a live
            # exchange — a loose neighbour must not answer for an exact, dormant carrier.
            {"name": "verbinder_masse", "amount": 0.3, "unit": "kg"},
        ],
        [
            ("kilogram", 0.0, "-(1 - eol_stahl_recycling) * (gestell_masse + heringe_masse)"),
            ("kilogram", 0.22, "dach_masse * 0.1"),
            ("kilogram", 0.315, "verbinder_masse * (1 + verlust_rate)"),
        ],
    )
    assert len(found) == 1
    component, detail = found[0]
    assert component == "ground pegs"
    assert "heringe_masse" in detail and "no non-zero exchange" in detail


def test_the_finding_asks_for_a_reconciliation_not_a_cut_off():
    """The check compares numbers, so a part booked inside another part, split differently or in another unit
    lands here as well: shelf boards booked as a set in m³ against a researched mass per board, small parts whose
    axle sits in the wheel. The text must send the reader to find the part first, and offer the cut-off only
    where the study's own criteria allow it — not as the other half of "never modelled or cut-off"."""
    no_trail = _run([{"component": "small parts", "mass_kg": 0.38}], [], [("kilogram", 0.08, "m_kleinteile")])
    dormant = _run(  # the other way in: a parameter carries the figure and feeds nothing
        [{"component": "ground pegs", "mass_kg": 0.2}],
        [{"name": "heringe_masse", "amount": 0.2, "unit": "kg"}],
        [("kilogram", 0.0, "heringe_masse * schalter"), ("kilogram", 9.0, "")],
    )
    for found in (no_trail, dormant):
        assert len(found) == 1
        text = found[0][1]
        assert "Find it in the model before you change anything" in text and "add nothing" in text
        assert "only where the study's cut-off criteria allow it" in text
        assert "ask the user when they do not decide it" in text
        assert "never modelled" not in text
    # The sister text, for a figure that only lowers what it reaches, offers the cut-off on the same condition.
    reduces = _run(
        [{"component": "part", "mass_kg": 0.2}],
        [{"name": "m_part", "amount": 0.2, "unit": "kg"}],
        [("kilogram", 0.8, "1 - m_part")],
    )
    assert len(reduces) == 1 and "only reduces" in reduces[0][1]
    assert "only where the study's cut-off criteria allow it" in reduces[0][1]
    assert "never modelled" not in reduces[0][1]


def test_a_component_booked_directly_is_silence():
    found = _run(
        [{"component": "roof canopy", "mass_kg": 2.2}],
        [],
        [("kilogram", 2.31, "dach_masse * (1 + verlust_rate)")],
    )
    assert found == []


def test_a_parameter_that_feeds_a_live_exchange_is_silence():
    found = _run(
        [{"component": "steel frame", "mass_kg": 9.0}],
        [{"name": "gestell_masse", "amount": 9, "unit": "kg"}],
        [("kilogram", 9.45, "gestell_masse * (1 + verlust_rate)")],
    )
    assert found == []


def test_a_figure_that_arrives_through_a_derived_parameter_is_silence():
    """The wheel's 2.5 kg sits in `m_rad`, which no exchange names: it feeds
    `m_stahl_rad = m_rad - m_reifen - m_schlauch`, and that one carries the steel exchanges. The
    figure is booked, one step removed — the finding stood through three health checks of a run
    and went into the reviewer's dossier as a gap."""
    found = _run(
        [{"component": "wheel, complete", "mass_kg": 2.5}],
        [
            {"name": "m_rad", "amount": 2.5, "unit": "kg"},
            {"name": "m_reifen", "amount": 0.8, "unit": "kg"},
            {"name": "m_schlauch", "amount": 0.2, "unit": "kg"},
            {"name": "m_stahl_rad", "amount": 1.5, "unit": "kg", "formula": "m_rad - m_reifen - m_schlauch"},
        ],
        [("kilogram", 1.5, "m_stahl_rad"), ("kilogram", 0.8, "m_reifen")],
    )
    assert found == []


def test_a_derived_parameter_that_feeds_only_a_dormant_exchange_is_still_the_finding():
    """The chain has to end in a NON-ZERO exchange: a derived parameter parked in a switched-off
    branch books nothing, however many steps lead to it."""
    found = _run(
        [{"component": "wheel, complete", "mass_kg": 2.5}],
        [
            {"name": "m_rad", "amount": 2.5, "unit": "kg"},
            {"name": "m_stahl_rad", "amount": 1.5, "unit": "kg", "formula": "m_rad - 1"},
        ],
        [("kilogram", 0.0, "m_stahl_rad * schalter"), ("kilogram", 9.0, "m_gestell")],
    )
    assert len(found) == 1 and "m_rad" in found[0][1]


def test_a_number_or_a_comment_that_merely_spells_the_name_is_no_dependency():
    """`1e3` is a number, not the parameter `e3`, and a name in a comment is read by nobody. A
    dormant carrier must not count as booked through a parameter that only looks related."""
    found = _run(
        [{"component": "ground pegs", "mass_kg": 0.2}],
        [
            {"name": "e3", "amount": 0.2, "unit": "kg"},
            {"name": "per_tonne", "amount": 1000, "unit": "kg", "formula": "1e3"},
            {"name": "frame", "amount": 9, "unit": "kg", "formula": "9  # was e3 once"},
        ],
        [("kilogram", 1000.0, "per_tonne"), ("kilogram", 9.0, "frame")],
    )
    assert len(found) == 1 and "e3" in found[0][1]


def test_a_deliberate_deviation_stays_inside_the_tolerance():
    """Research said 0.4 kg, the modeller booked 0.3 after checking — modelling, not a gap."""
    found = _run(
        [{"component": "connectors", "mass_kg": 0.4}],
        [],
        [("kilogram", 0.315, "verbinder_masse * (1 + verlust_rate)")],
    )
    assert found == []


def test_old_log_entries_are_read_from_their_text():
    """Entries logged before the masses were stored structured carry the same figure in prose —
    the tool has always written 'component (material): X kg'."""
    found = _run(
        [{"text": "ground pegs/fixings (galvanized steel): 0.2 kg", "sources": ["https://x"]}],
        [],
        [("kilogram", 9.45, "")],
    )
    assert len(found) == 1 and found[0][0] == "ground pegs/fixings"


def test_a_check_and_a_derivation_are_never_read_as_parts():
    """The whole-product masses of a bill-of-materials check (13 kg, 24 kg) and the derivation of a
    part's figure are no components: nothing in a model books "the rack", so reading them would report
    every researched total as a part nobody built."""
    entries = [clean_entry({
        "question": "Bill of materials: rack",
        "findings": [{"text": "boards (HDF) (5 pieces): 7.65 kg", "sources": ["https://x"],
                      "component": "boards", "mass_kg": 7.65,
                      "note": "frame: 13 kg total minus boards — 1.53 kg"}],
        "bom_check": {"summary": "Checked against the researched total 13 kg: 13 kg",
                      "unresolved": [{"component": "frame", "reason": "no_mass", "note": "frame: 5.35 kg"}],
                      "totals": [{"mass_kg": 13, "basis": "net"}, {"mass_kg": 24, "basis": "unknown"}]},
    })]
    with (
        patch("prism_lca.engine.research_log.ResearchLogStore.list", return_value=entries),
        patch("prism_lca.engine.params.list_params", return_value=[]),
    ):
        found = health_bom.bom_items_unbooked("any-model", [("kilogram", 0.5, "")])
    assert found == [("boards", found[0][1])]


def test_units_other_than_mass_never_match():
    """A 0.2-kWh exchange is not 0.2 kg of pegs."""
    found = _run(
        [{"component": "ground pegs", "mass_kg": 0.2}],
        [],
        [("kilowatt hour", 0.2, "")],
    )
    assert len(found) == 1


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


def test_a_literal_booking_of_the_exact_figure_counts_even_beside_a_parameter():
    """The modeller typed the amount instead of using the parameter — booked is booked."""
    found = _run(
        [{"component": "ground pegs", "mass_kg": 0.2}],
        [{"name": "heringe_masse", "amount": 0.2, "unit": "kg"}],
        [("kilogram", 0.2, "")],
    )
    assert found == []


def test_a_waste_amount_never_books_a_component():
    """A shelving run booked 0.14 kg of zinc as `0.14 / frame_kg` per kilogram of frame, and the check stayed
    silent — because a cardboard DISPOSAL of 0.1056 kg sat within 1.5x of 0.14. Waste leaving the system
    books nothing; without the formula the zinc is the finding."""
    found = _run(
        [{"component": "zinc coating", "mass_kg": 0.14}],
        [{"name": "frame_kg", "amount": 7.0, "unit": "kg"}],
        [("kilogram", -0.1056, "-carton_kg * eol_carton_incineration"), ("kilogram", 0.02, "0.02")],
    )
    assert len(found) == 1 and found[0][0] == "zinc coating"


def test_a_number_in_a_formula_books_the_figure():
    """The same zinc, booked the way the run booked it: 0.14 kg spread over the frame's kilograms. Silence,
    now for the right reason."""
    found = _run(
        [{"component": "zinc coating", "mass_kg": 0.14}],
        [{"name": "frame_kg", "amount": 7.0, "unit": "kg"}],
        [("kilogram", -0.1056, "-carton_kg * eol_carton_incineration"), ("kilogram", 0.02, "0.14 / frame_kg")],
    )
    assert found == []


def test_a_number_in_a_formula_counts_only_in_a_positive_mass_input():
    """The figure in an electricity formula, or in a disposal, is no booking of the part — and a digit inside
    a name or an exponent is no figure."""
    found = _run(
        [{"component": "zinc coating", "mass_kg": 0.14}],
        [],
        [
            ("kilowatt hour", 0.02, "0.14 / frame_kg"),
            ("kilogram", -0.02, "-0.14 / frame_kg"),
            ("kilogram", 1.0, "m0_14 * 0.14e3"),
        ],
    )
    assert len(found) == 1


_RECIPE = [
    {"name": "m_fill", "amount": 0.51, "unit": "kg"},
    {"name": "m_water", "amount": 0.377, "unit": "kg"},
    {"name": "m_surfactants", "amount": 0.0595, "unit": "kg"},
    {"name": "m_additives", "amount": 0.0181, "unit": "kg"},
    {
        "name": "m_other_ingredients", "amount": 0.0552, "unit": "kg",
        "formula": "m_fill - m_water - m_surfactants - m_additives",
    },
    {"name": "m_salt", "amount": 0.0112, "unit": "kg", "formula": "m_fill * 0.022"},
]


def test_a_figure_that_only_reduces_the_rest_books_nothing():
    """A soap recipe: the additives' 0.0181 kg is subtracted from the fill to give the rest, and the rest
    goes into the water exchange — so the name `m_additives` reaches an exchange, but raising it LOWERS the
    water. The additives are booked one by one (`m_fill * 0.022` for the salt), which is fine, and the
    finding says exactly that instead of claiming the parameter feeds nothing."""
    found = _run(
        [{"component": "additives", "mass_kg": 0.0181}],
        _RECIPE,
        [
            ("kilogram", 0.4322, "m_water + m_other_ingredients"),
            ("kilogram", 0.0595, "m_surfactants"),
            ("kilogram", 0.0112, "m_salt"),
        ],
    )
    assert len(found) == 1
    text = found[0][1]
    assert "'m_additives'" in text and "only reduces 'm_other_ingredients'" in text
    assert "booked another way" in text and "feeds no non-zero exchange" not in text


def test_a_closed_recipe_books_each_figure_it_adds():
    """`water = m_water + m_other_ingredients` does not move when the water rises — the rest falls by as
    much — and the water is booked all the same: the chain that adds it is what counts."""
    found = _run(
        [{"component": "water", "mass_kg": 0.377}, {"component": "surfactants", "mass_kg": 0.0595}],
        _RECIPE,
        [("kilogram", 0.4322, "m_water + m_other_ingredients"), ("kilogram", 0.0595, "m_surfactants")],
    )
    assert found == []


def test_a_figure_that_only_reaches_end_of_life_is_named_as_such():
    """The pegs' shape with a live end-of-life branch: the handles' mass is disposed of, and produced
    nowhere. The waste amount names the parameter; it books nothing."""
    found = _run(
        [{"component": "handles", "mass_kg": 0.2}],
        [{"name": "m_handles", "amount": 0.2, "unit": "kg"}, {"name": "eol_burn", "amount": 0.244, "unit": ""}],
        [("kilogram", -0.0488, "-m_handles * eol_burn"), ("cubic meter", 0.000238, "")],
    )
    assert len(found) == 1 and "only enters outputs" in found[0][1]


def test_a_chain_the_probe_cannot_evaluate_keeps_to_the_names():
    """A formula the probe cannot compute (a name outside the parameter list) says nothing either way —
    then the name that reaches a live exchange counts, as it always did."""
    found = _run(
        [{"component": "frame", "mass_kg": 9.0}],
        [{"name": "m_frame", "amount": 9.0, "unit": "kg"}],
        [("kilogram", 9.45, "m_frame * (1 + group_loss)")],
    )
    assert found == []


def test_a_negative_step_on_the_way_keeps_its_sign():
    """`neg = -m_part` falls when the part rises; `-neg / 2` then rises with it — booked. A probe that
    multiplied a negative value by 1.01 lowered it and read both steps the wrong way round."""
    params = [
        {"name": "m_part", "amount": 0.2, "unit": "kg"},
        {"name": "neg", "amount": -0.2, "unit": "kg", "formula": "-m_part"},
    ]
    assert _run([{"component": "part", "mass_kg": 0.2}], params, [("kilogram", 0.1, "-neg / 2")]) == []
    found = _run([{"component": "part", "mass_kg": 0.2}], params, [("kilogram", 0.8, "1 + neg")])
    assert len(found) == 1 and "only reduces 'neg'" in found[0][1]


def test_a_contribution_switched_off_or_cancelled_books_nothing():
    """The probe computed, and nothing moved: a figure behind a factor of zero, or added and taken off in the
    same formula, books nothing — it is not handed back to the names, which would call it booked."""
    for formula in ("1 + enabled * m_part", "1 + m_part - m_part"):
        found = _run(
            [{"component": "part", "mass_kg": 0.2}],
            [{"name": "m_part", "amount": 0.2, "unit": "kg"}, {"name": "enabled", "amount": 0, "unit": ""}],
            [("kilogram", 1.0, formula)],
        )
        assert len(found) == 1, formula
        assert "moves no input amount" in found[0][1]


def test_a_number_counts_only_where_it_raises_the_amount():
    """A figure in a comment is no number, a subtracted one books nothing, and neither does one switched off
    by a factor of zero. The run's own shape still books."""
    zinc = [{"component": "zinc coating", "mass_kg": 0.14}]
    params = [{"name": "frame_kg", "amount": 7.0, "unit": "kg"}, {"name": "enabled", "amount": 0, "unit": ""}]
    for formula, amount in (
        ("9 # omitted zinc: 0.14 kg", 9.0),
        ("1 - 0.14", 0.86),
        ("1 + 0.14 * enabled", 1.0),
    ):
        assert len(_run(zinc, params, [("kilogram", amount, formula)])) == 1, formula
    assert _run(zinc, params, [("kilogram", 0.02, "0.14 / frame_kg")]) == []
    # Grams: the number is read in the exchange's unit.
    assert _run(zinc, params, [("gram", 20.0, "140 / frame_kg")]) == []


def test_a_formula_the_probe_cannot_compute_still_shows_its_numbers():
    """A name outside the parameter list leaves the formula unevaluable: its number then counts by the
    syntax — never by a comment."""
    zinc = [{"component": "zinc coating", "mass_kg": 0.14}]
    params = [{"name": "frame_kg", "amount": 7.0, "unit": "kg"}]
    assert _run(zinc, params, [("kilogram", 0.02, "0.14 / group_frame_kg")]) == []
    assert len(_run(zinc, params, [("kilogram", 1.0, "group_total # 0.14 kg zinc")])) == 1


# Other figures for one part: the research counts one and keeps the others beside it (a label, or a direct print —
# either one or the other). The assistant is told to book an alternative when the user's product is that variant.
_LABEL = {
    "text": "label (PP): 0.0006 kg",
    "component": "label",
    "mass_kg": 0.0006,
    "alternatives_kg": [0.00015],
}


def test_a_booking_of_an_alternative_books_the_part():
    """The direct print is booked, four times lighter than the counted label: the part is in the model."""
    assert _run([_LABEL], [], [("kilogram", 0.00015, "")]) == []


def test_without_the_alternative_on_record_the_same_booking_is_the_finding():
    """The counter-case: the same booking against a part with no other figure is not that part."""
    found = _run([{k: v for k, v in _LABEL.items() if k != "alternatives_kg"}], [], [("kilogram", 0.00015, "")])
    assert [c for c, _t in found] == ["label"]


def test_a_part_none_of_whose_figures_is_booked_is_named_by_its_counted_figure():
    found = _run([_LABEL], [], [("kilogram", 0.5, "")])
    assert len(found) == 1 and "'label' at 0.0006 kg" in found[0][1]


def test_an_alternative_logged_as_text_is_never_a_part_to_book():
    """The log documents each alternative with its own page, in a text the reconciliation must not read as a part."""
    found = _run(
        [
            _LABEL,
            {
                "text": 'Alternative figure for "label": 0.00015 kg (direct print ink) — not counted '
                "(the research counted 0.0006 kg)",
                "sources": ["https://print.example"],
            },
        ],
        [],
        [("kilogram", 0.0006, "")],
    )
    assert found == []


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
