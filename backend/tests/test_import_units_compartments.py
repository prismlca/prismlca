"""The two pure rules the matcher stands on: unit conversion and compartments.

Both are tested for what they REFUSE as much as for what they do — an importer that converts
everything and places everything is an importer that hides its mistakes.
"""

from __future__ import annotations

import pytest

from prism_lca.engine.dataimport import compartments, units


class TestUnits:
    @pytest.mark.parametrize(
        ("source", "target", "factor"),
        [
            ("MJ", "kWh", 1 / 3.6),
            ("kWh", "MJ", 3.6),
            ("l", "m3", 1e-3),
            ("m³", "litre", 1e3),
            ("g", "kg", 1e-3),
            ("t", "kg", 1e3),
            ("kg", "kilogram", 1.0),
        ],
    )
    def test_a_definition_is_applied_without_asking(self, source: str, target: str, factor: float):
        result = units.rescale(source, target)
        assert result.kind is units.EXACT
        assert result.factor == pytest.approx(factor)

    def test_across_dimensions_is_not_a_conversion_problem(self):
        """kg↔kWh has no factor with or without an assumption. Saying so is the point: a unit that
        will not convert is the strongest signal that the MATCH is wrong, and an invented factor
        would hide the very error the review step exists to catch."""
        result = units.rescale("kg", "kWh")
        assert result.kind is units.IMPOSSIBLE
        assert "mass cannot be converted into energy" in result.note
        assert "the match itself is wrong" in result.note

    def test_a_missing_unit_converts_to_nothing(self):
        assert units.rescale("", "kg").kind is units.IMPOSSIBLE
        assert units.rescale("kg", "").kind is units.IMPOSSIBLE

    def test_an_assumption_names_itself(self):
        """Class B is a modelling decision, so the factor's origin travels with it."""
        result = units.with_assumption("l", "kg", quantity=0.915, what="density")
        assert result.kind is units.ASSUMED
        assert result.factor == pytest.approx(0.915)
        assert "density" in result.note and "0.915" in result.note


class TestCompartments:
    def test_an_ilcd_path_lands_in_our_vocabulary(self):
        found = compartments.resolve(("Emissions", "Emissions to air", "Emissions to air, unspecified"))
        assert found.categories == ("air",)
        assert found.unspecified is True

    def test_a_subcompartment_is_kept(self):
        found = compartments.resolve(("Emissions to water", "surface water"))
        assert found.categories == ("water", "surface water")
        assert found.unspecified is False

    def test_a_foreign_spelling_is_translated(self):
        # "low population density" is non-urban air; the long-term flow needs the source to say
        # "long-term" (the alias used to add a time horizon nobody stated).
        assert compartments.resolve(("air", "low population density")).categories == (
            "air",
            "non-urban air or from high stacks",
        )
        assert compartments.resolve(("air", "low. pop., long-term")).categories == (
            "air",
            "low population density, long-term",
        )
        assert compartments.resolve(("water", "river")).categories == ("water", "surface water")

    @pytest.mark.parametrize("compartment", ["air", "water", "soil"])
    def test_a_missing_subcompartment_falls_back_where_that_is_real(self, compartment: str):
        """Measured on biosphere3: 1 276 air, 1 272 water and 942 soil flows carry no
        subcompartment. "Unspecified" is ecoinvent's own category, not something we invent."""
        found = compartments.resolve((compartment,))
        assert found.categories == (compartment,)
        assert found.unspecified is True

    def test_a_natural_resource_without_a_subcompartment_is_refused(self):
        """The asymmetry that makes the rule a rule: biosphere3 has ZERO natural-resource flows
        without a subcompartment, so there is nothing to fall back on."""
        found = compartments.resolve(("Resources",))
        assert found.categories is None
        assert "nothing to fall back on" in found.reason

    def test_no_compartment_at_all_is_refused(self):
        found = compartments.resolve(())
        assert found.categories is None
        assert "guessing" in found.reason

    def test_a_grouping_above_the_compartment_is_not_a_subcompartment(self):
        """ILCD writes "Emissions / Emissions to air / …". Reading that first level as a
        subcompartment yields "air / emissions", which exists nowhere — and it is what an earlier
        version of this function produced."""
        found = compartments.resolve(("Emissions", "Emissions to air"))
        assert found.categories == ("air",)

    def test_an_explicit_unspecified_is_an_answer_and_not_a_gap(self):
        """A source that says "unspecified" has answered the question. Falling back to a shallower
        level would overrule that answer with a guess."""
        found = compartments.resolve(("Emissions", "Emissions to air", "Emissions to air, unspecified"))
        assert found.categories == ("air",)
        assert found.unspecified is True


def test_knows_radioactivity():
    """Bq against our kilo Becquerel is a factor of a thousand, not a dead end."""
    scaled = units.rescale("Bq", "kilo Becquerel")
    assert scaled.ok
    assert scaled.factor == pytest.approx(1e-3)
    # And it stays a different quantity from mass — that rejection was right.
    assert not units.rescale("kg", "kilo Becquerel").ok


def test_knows_the_units_us_sources_arrive_in():
    assert units.rescale("lb", "kilogram").factor == pytest.approx(0.45359237)
    assert units.rescale("gal", "litre").factor == pytest.approx(3.785411784)
    assert units.rescale("scf", "cubic meter").factor == pytest.approx(0.028316846592)
    assert units.rescale("MMBtu", "MJ").factor == pytest.approx(1055.05585262)
    # A pound of feathers is still not a gallon of anything.
    assert not units.rescale("lb", "gal").ok


def test_names_what_a_unit_measures():
    assert units.dimension("kg") == "mass"
    assert units.dimension("standard cubic meter") == "volume"
    assert units.dimension("nonsense") == ""
