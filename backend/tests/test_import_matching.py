"""What the rules decide before any model is asked — and what they refuse to decide.

Every test here is also a statement about the asymmetry the feature rests on: a flow left open is
visible in three places afterwards, a flow matched to the wrong substance is a finished-looking
number. So "no match" is a correct answer and is tested as one.
"""

from __future__ import annotations

import pytest

from prism_lca.engine.dataimport.matching import (
    REGIONS_PER_HIT,
    BiosphereIndex,
    Confidence,
    match_biosphere,
    match_technosphere,
    normalise_name,
)
from prism_lca.engine.dataimport.model import FlowProperty, ForeignExchange

FLOWS = [
    {"code": "co2-air", "name": "Carbon dioxide, fossil", "unit": "kilogram", "categories": ("air",)},
    {"code": "co2-urban", "name": "Carbon dioxide, fossil", "unit": "kilogram",
     "categories": ("air", "urban air close to ground")},
    {"code": "co2-water", "name": "Carbon dioxide, fossil", "unit": "kilogram", "categories": ("water",)},
    {"code": "ch4-air", "name": "Methane, fossil", "unit": "kilogram", "categories": ("air",)},
    {"code": "oil", "name": "Oil, crude", "unit": "kilogram", "categories": ("natural resource", "in ground")},
    {"code": "energy-air", "name": "Energy, solar", "unit": "megajoule", "categories": ("natural resource", "in air")},
]
INDEX = BiosphereIndex.build(FLOWS)


def flow(name, unit="kg", compartment=("Emissions to air",), uuid=None, kind="biosphere"):
    return ForeignExchange(kind=kind, name=name, amount=1.0, unit=unit, compartment=compartment, uuid=uuid)


class TestBiosphere:
    def test_an_identifier_that_hits_needs_no_judgement(self):
        found = match_biosphere(flow("Whatever the source called it", uuid="ch4-air"), INDEX)
        assert found.confidence is Confidence.good
        assert found.target.code == "ch4-air"
        assert "same flow identifier" in found.evidence

    def test_an_identifier_whose_unit_will_not_convert_is_a_contradiction_not_a_match(self):
        """The identifier says one thing and the unit says another. Taking the identifier would
        import kilowatt hours as kilograms."""
        found = match_biosphere(flow("x", unit="kWh", uuid="co2-air"), INDEX)
        assert not found.matched
        assert "will not" in found.evidence or "cannot be converted" in found.evidence

    def test_name_plus_compartment_is_a_match(self):
        found = match_biosphere(flow("Carbon dioxide, fossil"), INDEX)
        assert found.confidence is Confidence.good
        assert found.target.code == "co2-air"

    def test_an_omitted_subcompartment_is_not_a_downgrade(self):
        """Most sources give a compartment and nothing more. Treating that as a compromise would
        mark the majority of a normal import "medium" — and a band that applies to nearly
        everything says nothing about anything. The bare compartment is a real ecoinvent category,
        so honouring the omission is the correct answer, not a widening."""
        found = match_biosphere(flow("Methane, fossil", compartment=("air",)), INDEX)
        assert found.matched and found.confidence is Confidence.good

    def test_an_assumed_unit_conversion_does_cost_a_band(self):
        """What DOES cost a band is a factor that rests on a substance property rather than on a
        definition — that one is a modelling decision, and it needs a person."""
        from prism_lca.engine.dataimport import units

        assert units.with_assumption("l", "kg", quantity=0.915, what="density").kind is units.ASSUMED

    def test_the_compartment_decides_which_carbon_dioxide(self):
        """Three flows share the name. The medium is what tells them apart, and it is a filter on
        the shortlist rather than one feature among several."""
        water = match_biosphere(flow("Carbon dioxide, fossil", compartment=("Emissions to water",)), INDEX)
        assert water.target.code == "co2-water"
        assert all(c.categories[0] == "water" for c in water.candidates)

    def test_a_convertible_unit_is_rescaled_and_says_so(self):
        found = match_biosphere(flow("Carbon dioxide, fossil", unit="g"), INDEX)
        assert found.matched
        assert found.factor == 0.001
        assert "factor" in found.scale_note

    def test_a_resource_with_only_one_possible_subcompartment_is_not_a_guess(self):
        """Our biosphere has no bare "natural resource", so "Resources, unspecified" used to be a
        dead end. But if the substance exists in exactly ONE subcompartment there is nothing left
        to guess — coal is in the ground and ecoinvent has it nowhere else."""
        found = match_biosphere(flow("Oil, crude", compartment=("Resources",)), INDEX)
        assert found.matched
        assert found.target.categories == ("natural resource", "in ground")
        assert "the only" in found.evidence

    def test_a_resource_that_could_be_in_two_places_stays_a_decision(self):
        """Uniqueness is the whole argument. Two candidates are two answers, and picking one would
        be the guess the rule exists to avoid."""
        index = BiosphereIndex.build(
            FLOWS
            + [
                {"code": "water-ground", "name": "Water", "unit": "cubic meter",
                 "categories": ("natural resource", "in ground")},
                {"code": "water-river", "name": "Water", "unit": "cubic meter",
                 "categories": ("natural resource", "in water")},
            ]
        )
        found = match_biosphere(
            flow("Water", unit="m3", compartment=("Resources",)), index
        )
        assert not found.matched
        assert found.needs_model
        assert {c.categories[1] for c in found.candidates} == {"in ground", "in water"}

    def test_a_cas_index_name_is_the_systematic_name_turned_around(self):
        """US LCI writes "Methane, bromo-", ecoinvent writes "Bromomethane" — the same substance,
        and the two share no word any lexical search could use. Nine of the 105 flows in the ABS
        resin are exactly this, including three refrigerants whose trade code trails the name."""
        index = BiosphereIndex.build(
            FLOWS
            + [
                {"code": "bromomethane", "name": "Bromomethane", "unit": "kilogram",
                 "categories": ("air",)},
                {"code": "ethylbenzene", "name": "Ethyl benzene", "unit": "kilogram",
                 "categories": ("air",)},
            ]
        )
        found = match_biosphere(flow("Methane, bromo-, Halon 1001"), index)
        assert found.target.code == "bromomethane"
        assert found.confidence is Confidence.good
        assert "CAS index name" in found.evidence

        # …and across a space, because "Ethyl benzene" and "ethylbenzene" are the same string once
        # the spaces are gone.
        spaced = match_biosphere(flow("Benzene, ethyl-"), index)
        assert spaced.target.code == "ethylbenzene"

    def test_an_inverted_name_that_leads_nowhere_stays_open(self):
        """The rule must not invent: "Benzene, chloro-" turns into "chlorobenzene", and if our
        biosphere has no such flow the answer is still nothing."""
        found = match_biosphere(flow("Benzene, chloro-"), INDEX)
        assert not found.matched

    def test_an_element_in_air_means_the_ion_our_biosphere_names(self):
        """ecoinvent keeps the bare element for the RESOURCE and names the EMISSION as its ion:
        "Antimony ion", "Cadmium II", "Selenium IV". A source that writes "Antimony" to air means
        the ion, and no amount of word overlap says so — it settles 38 of the 105 flows in the US
        LCI ABS resin, which the model had refused one by one."""
        index = BiosphereIndex.build(
            FLOWS
            + [
                {"code": "sb-air", "name": "Antimony ion", "unit": "kilogram",
                 "categories": ("air", "urban air close to ground")},
                {"code": "sb-res", "name": "Antimony", "unit": "kilogram",
                 "categories": ("natural resource", "in ground")},
            ]
        )
        found = match_biosphere(flow("Antimony"), index)
        assert found.target.code == "sb-air"
        # A convention, not an identifier — so never better than medium, and the reviewer's band
        # filter still shows every one of them.
        assert found.confidence is Confidence.medium
        assert "ion" in found.evidence

    def test_an_unknown_name_comes_back_with_a_shortlist_from_the_right_compartment(self):
        found = match_biosphere(flow("Carbon dioxide, biogenic"), INDEX)
        assert not found.matched
        assert found.needs_model
        assert found.candidates
        assert {c.categories[0] for c in found.candidates} == {"air"}

    def test_a_name_nothing_resembles_gets_no_shortlist_and_no_model(self):
        """The abstention case the whole design turns on: no candidates means no question to ask,
        and inventing one would be the only way to get a wrong answer here."""
        found = match_biosphere(flow("Kryptonite"), INDEX)
        assert not found.matched and not found.needs_model
        assert found.candidates == []
        assert "shares a word" in found.evidence


class TestTechnosphere:
    def test_a_link_always_goes_through_the_shortlist(self):
        """There is no exact vocabulary for technosphere links, so rules cannot settle one. What
        the rules DO is bound the question: the model chooses from these or from nothing."""
        def search(query, database, limit):
            assert query == "Electricity, medium voltage"
            return [{"code": "elec-de", "name": "market for electricity, medium voltage",
                     "unit": "kilowatt hour", "location": "DE", "database": database}]

        found = match_technosphere(
            flow("Electricity, medium voltage", unit="MJ", kind="technosphere"),
            search=search,
            background="ecoinvent-3.12-cutoff",
        )
        assert found.needs_model
        assert len(found.candidates) == 1
        assert found.candidates[0].location == "DE"

    def test_every_region_of_a_hit_is_offered(self):
        """The search collapses an activity's regions into one row. Offering only the collapsed
        representative would bind whichever region the collapse picked — and for electricity or
        transport the region IS the answer, not a detail. So each one is a candidate of its own."""
        def search(query, database, limit):
            return [
                {
                    "code": "elec-glo",
                    "name": "market for electricity, medium voltage",
                    "unit": "kilowatt hour",
                    "geography": "GLO",
                    "database": database,
                    "variants": [
                        {"code": "elec-de", "geography": "DE", "database": database},
                        {"code": "elec-fr", "geography": "FR", "database": database},
                        {"code": "elec-glo", "geography": "GLO", "database": database},
                    ],
                }
            ]

        found = match_technosphere(
            flow("Electricity, medium voltage", unit="MJ", kind="technosphere"),
            search=search,
            background="ecoinvent-3.12-cutoff",
        )
        # GLO first: the source line named no region, so the global mix is the honest default —
        # and it is the one the matching model gets to see.
        assert [c.location for c in found.candidates] == ["GLO", "DE", "FR"]
        assert {c.code for c in found.candidates} == {"elec-de", "elec-fr", "elec-glo"}
        # …and the label carries the region, because that is what a reviewer scans.
        assert found.candidates[0].label.endswith("GLO")
        assert "across 3 regions" in found.evidence

    def test_the_region_the_source_named_comes_first(self):
        """When the file says DE, picking GLO would throw away the one piece of evidence there is."""
        def search(query, database, limit):
            return [
                {
                    "code": "elec-glo",
                    "name": "market for electricity, medium voltage",
                    "unit": "kilowatt hour",
                    "database": database,
                    "variants": [
                        {"code": "elec-glo", "geography": "GLO"},
                        {"code": "elec-de", "geography": "DE"},
                    ],
                }
            ]

        exchange = flow("Electricity, medium voltage", unit="MJ", kind="technosphere")
        exchange.location = "DE"
        found = match_technosphere(exchange, search=search, background="ecoinvent-3.12-cutoff")
        assert found.candidates[0].location == "DE"

    def test_a_candidate_says_what_the_search_read_an_abbreviation_as(self):
        """The reviewer and the matching model see the reading the shortlist came from — the way to
        catch a wrong one (it was once lost on the way to the Candidate)."""
        def search(query, database, limit):
            return [{"code": "pet", "name": "market for polyethylene terephthalate, granulate",
                     "unit": "kilogram", "database": database,
                     "searched_as": "polyethylene terephthalate resin"}]

        found = match_technosphere(flow("PET resin", kind="technosphere"), search=search,
                                   background="ecoinvent-3.12-cutoff")
        assert found.candidates[0].why == "semantic search (also searched as “polyethylene terephthalate resin”)"

    def test_ties_keep_the_search_order_not_the_alphabet(self):
        """An earlier version sorted the remainder alphabetically and made AE the default for a
        European dataset. Order by name is not order by relevance."""
        def search(query, database, limit):
            return [
                {
                    "code": "elec-pt",  # what the collapse picked as the representative
                    "name": "market for electricity, medium voltage",
                    "unit": "kilowatt hour",
                    "database": database,
                    "variants": [
                        {"code": "elec-zw", "geography": "ZW"},
                        {"code": "elec-pt", "geography": "PT"},
                        {"code": "elec-ae", "geography": "AE"},
                    ],
                }
            ]

        found = match_technosphere(
            flow("Electricity, medium voltage", kind="technosphere"),
            search=search,
            background="ecoinvent-3.12-cutoff",
        )
        assert [c.location for c in found.candidates] == ["PT", "ZW", "AE"]

    def test_the_dataset_region_stands_in_when_the_line_gives_none(self):
        """A German dataset buying "electricity" is buying German electricity unless it says
        otherwise. That is evidence, and the only piece there usually is."""
        def search(query, database, limit):
            return [
                {
                    "code": "elec-fr",
                    "name": "market for electricity, medium voltage",
                    "unit": "kilowatt hour",
                    "database": database,
                    "variants": [
                        {"code": "elec-fr", "geography": "FR"},
                        {"code": "elec-de", "geography": "DE"},
                    ],
                }
            ]

        found = match_technosphere(
            flow("Electricity, medium voltage", kind="technosphere"),
            search=search,
            background="ecoinvent-3.12-cutoff",
            prefer_location="DE",
        )
        assert found.candidates[0].location == "DE"

    def test_a_region_list_is_capped(self):
        """ecoinvent has electricity in eighty regions. A dropdown of eighty is not a choice
        anybody makes, and for the matching model it is eighty ways to be wrong."""
        def search(query, database, limit):
            return [
                {
                    "code": "e0",
                    "name": "market for electricity",
                    "unit": "kilowatt hour",
                    "database": database,
                    "variants": [{"code": f"e{i}", "geography": f"R{i}"} for i in range(40)],
                }
            ]

        found = match_technosphere(
            flow("Electricity", kind="technosphere"),
            search=search,
            background="ecoinvent-3.12-cutoff",
        )
        assert len(found.candidates) == REGIONS_PER_HIT

    def test_nothing_found_means_nothing_to_ask(self):
        found = match_technosphere(
            flow("Unobtainium sheet", kind="technosphere"),
            search=lambda *a, **k: [],
            background="ecoinvent-3.12-cutoff",
        )
        assert not found.needs_model and found.candidates == []


class TestPropertyBridge:
    """A property the source states bridges two quantities — reading the file, not assuming."""

    def test_a_stated_mass_per_volume_is_a_density_and_converts(self):
        stated = ForeignExchange(
            kind="biosphere", name="Carbon dioxide, fossil", amount=2.0, unit="m3",
            compartment=("Emissions to air",),
            properties=(FlowProperty(name="Mass", amount=1.8, unit="kg"),),
        )
        found = match_biosphere(stated, INDEX)
        assert found.target is not None and found.target.code == "co2-air"
        # 2 m³ × 1.8 kg/m³ — and the note says whose number that is.
        assert found.factor == pytest.approx(1.8)
        assert "the source's own" in found.evidence or "the source's own" in found.scale_note
        # A bridged conversion is an assumption, however well sourced — never the top band.
        assert found.confidence is Confidence.medium

    def test_a_dry_mass_yields_to_the_plain_mass(self):
        stated = ForeignExchange(
            kind="biosphere", name="Carbon dioxide, fossil", amount=1.0, unit="m3",
            compartment=("Emissions to air",),
            properties=(
                FlowProperty(name="dry mass", amount=1.2, unit="kg"),
                FlowProperty(name="Mass", amount=1.8, unit="kg"),
            ),
        )
        found = match_biosphere(stated, INDEX)
        assert found.factor == pytest.approx(1.8)

    def test_no_stated_property_no_bridge(self):
        found = match_biosphere(
            ForeignExchange(kind="biosphere", name="Carbon dioxide, fossil", amount=1.0,
                            unit="m3", compartment=("Emissions to air",)),
            INDEX,
        )
        assert found.target is None or found.confidence is not Confidence.good


def test_dashes_do_not_make_two_substances():
    assert normalise_name("lorry, 16–32 metric ton") == normalise_name("lorry, 16-32 metric ton")


def test_folds_the_spellings_chemistry_never_settled():
    """"Aluminum" in water is "Aluminium III" — the match must not die on a vowel."""
    assert normalise_name("Aluminum") == normalise_name("Aluminium")
    assert normalise_name("Cesium-137") == normalise_name("Caesium-137")
    assert normalise_name("Ammonium sulphate") == normalise_name("Ammonium sulfate")
    # And it must not collapse two substances that really are different.
    assert normalise_name("Sulfur dioxide") != normalise_name("Sulfur trioxide")


class TestSubcompartmentsAndVariants:
    def test_a_named_subcompartment_wins_over_the_bare_flow(self):
        """The source said urban air and the flow for urban air existed, and the
        bare one was chosen anyway."""
        index = BiosphereIndex.build(
            FLOWS
            + [
                {"code": "bromo-air", "name": "Bromomethane", "unit": "kilogram", "categories": ("air",)},
                {"code": "bromo-urban", "name": "Bromomethane", "unit": "kilogram",
                 "categories": ("air", "urban air close to ground")},
            ]
        )
        found = match_biosphere(
            flow("Methane, bromo-", compartment=("Emissions to air", "high population density")), index
        )
        assert found.target is not None and found.target.code == "bromo-urban"
        # …and with no subcompartment stated, the bare flow still wins.
        bare = match_biosphere(flow("Methane, bromo-"), index)
        assert bare.target is not None and bare.target.code == "bromo-air"

    def test_the_semantic_shortlist_reads_every_variant_of_a_hit(self):
        """The search collapses one name across compartments; the representative
        was the water flow and the air flow under `variants` was never looked at."""
        index = BiosphereIndex.build(
            [
                {"code": "x-water", "name": "Xylene", "unit": "kilogram", "categories": ("water",)},
                {"code": "x-air", "name": "Xylene", "unit": "kilogram", "categories": ("air",)},
            ]
        )

        def search(query, database, limit):
            return [{"code": "x-water", "variants": [{"code": "x-water"}, {"code": "x-air"}]}]

        found = match_biosphere(flow("Some aromatic nobody spells like this"), index, search=search)
        assert any(c.code == "x-air" for c in found.candidates)
        assert not any(c.code == "x-water" for c in found.candidates)
