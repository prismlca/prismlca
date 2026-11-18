"""The unwatched hand-over, watched: researched component masses vs. what the model books.

On the 2026-08-29 pavilion run the BOM researcher found the ground pegs (0.2 kg, sourced from the
manufacturer's own manual) and the modeller then booked them nowhere on the production side — they
sat in the shipping weight and in a dormant end-of-life branch. The research had delivered, the
model computed consistently, and no check compared the two.
"""
from unittest.mock import patch

from prism_lca.engine import health
from prism_lca.engine.research_log import clean_entry


def _run(findings: list[dict], params: list[dict], exchanges: list[tuple]) -> list[tuple[str, str]]:
    entries = [{"question": "Bill of materials: test product", "findings": findings}]
    with (
        patch("prism_lca.engine.research_log.ResearchLogStore.list", return_value=entries),
        patch("prism_lca.engine.params.list_params", return_value=params),
    ):
        return health._bom_items_unbooked("any-model", exchanges)


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
        found = health._bom_items_unbooked("any-model", [("kilogram", 0.5, "")])
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
