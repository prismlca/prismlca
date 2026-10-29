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
