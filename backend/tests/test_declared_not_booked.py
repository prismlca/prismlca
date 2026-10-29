"""V273 — the one check that compares the model against something outside itself.

A PET-bottle run entered three masses in grams into fields measured in kilograms. The
computed climate result was 42x too high and *every* structural check stayed green, because a model
with a consistent unit slip is a self-consistent model. What caught two of the three was a comment
that happened to quote the figure beside the parameter's name; the study's functional unit had held
the same figure all along and nothing compared the two.
"""
from unittest.mock import patch

import pytest

from prism_lca.engine import health


def _run(declared: str, params: list[dict]) -> list[tuple[str, str]]:
    meta = {"functional_unit": declared}
    with (
        patch("prism_lca.engine.study.StudyMetaStore.get", return_value=meta),
        patch("prism_lca.engine.params.list_params", return_value=params),
    ):
        return health._declared_but_not_booked("any-model")


def test_a_gram_typed_into_a_kilogram_field_is_found():
    """The real one, verbatim from the run's functional unit."""
    found = _run(
        "…tertiary packaging (1 expendable GMA pallet + 0.25 kg LDPE wrap per 2,016 bottles).",
        [{"name": "wrap_mass_kg", "amount": 0.00025, "unit": "kg"}],
    )
    assert len(found) == 1
    written, culprit = found[0]
    assert written == "0.25 kg"
    assert "wrap_mass_kg" in culprit and "1000" in culprit


def test_the_same_quantity_written_differently_is_silence():
    """8.30 g and 0.0083 kg are the same mass. Both sides go through the unit base, so a check that
    fired here would be complaining about notation."""
    assert _run("one 8.30 g PET bottle", [{"name": "bottle_g", "amount": 0.0083, "unit": "kg"}]) == []
    assert _run("one 8.30 g PET bottle", [{"name": "bottle_g", "amount": 8.3, "unit": "g"}]) == []


def test_a_merely_different_number_is_not_a_finding():
    """The brief says 450 km and the model uses 400. That is a modelling decision, and a linter with
    an opinion about it is a linter that gets switched off."""
    assert _run("transport over 450 km", [{"name": "distance", "amount": 400, "unit": "km"}]) == []
    # …and a factor of ten stays silent too: ten bottles per case is a choice somebody makes.
    assert _run("a 2 kg pallet", [{"name": "pallet", "amount": 0.2, "unit": "kg"}]) == []


def test_a_quantity_booked_correctly_elsewhere_is_silence():
    """One parameter has it right; another of the same family happens to be a thousand times smaller.
    Nothing is wrong, and saying so would fire on half the models in existence."""
    assert _run(
        "0.25 kg LDPE wrap",
        [
            {"name": "wrap_kg", "amount": 0.25, "unit": "kg"},
            {"name": "label_kg", "amount": 0.00025, "unit": "kg"},
        ],
    ) == []


def test_quantities_of_another_kind_never_compare():
    """A volume in the scope against a mass in the model is not a slip, it is two different things."""
    assert _run("500 mL of bottled water", [{"name": "mass", "amount": 0.0005, "unit": "kg"}]) == []


def test_no_scope_text_and_no_units_produce_nothing():
    assert _run("", [{"name": "x", "amount": 1, "unit": "kg"}]) == []
    # A bare share carries no family to compare against.
    assert _run("0.25 kg of film", [{"name": "share", "amount": 0.00025, "unit": ""}]) == []


@pytest.mark.parametrize("factor", [100, 1000, 10_000])
def test_every_decimal_prefix_slip_is_caught(factor):
    assert len(_run("0.5 kg of steel", [{"name": "p", "amount": 0.5 / factor, "unit": "kg"}])) == 1


def test_the_signature_keeps_the_word_that_tells_two_materials_apart():
    """V276. `_GENERIC_TERMS` drops "high" and "low" — right, because neither names a material. For
    the *have I asked this already* signature they are the whole difference, and dropping them told
    a search for HDPE incineration that it had already searched LDPE incineration, inside the same
    batched call."""
    from prism_lca.search.ranking import content_terms, query_signature

    low = query_signature("treatment of waste low density polyethylene municipal incineration")
    high = query_signature("treatment of waste high density polyethylene municipal incineration")
    assert low != high
    assert "low" in low and "high" in high
    # The other question is unchanged: "is this word in the database" still ignores them.
    assert "high" not in content_terms("high density polyethylene")


def test_a_batch_error_that_sees_an_array_says_which_parameter_to_use():
    """V277. A model put the whole batch under the singular `code`, as a JSON string, and got back
    "Activity '[…]' not found — Check the activity code and database". The value was in the message;
    nothing read it. Two dead calls, and a tooling critique blaming a batch that works."""
    from prism_lca.engine.model import _not_found_hint

    hint = _not_found_hint('["aaa", "bbb", "ccc", "ddd"]')
    assert '"codes"' in hint and "4 codes" in hint and "+1 more" in hint
    # An ordinary miss keeps the ordinary hint.
    assert _not_found_hint("0d6068eb37e8505839cdff55ac38045e") == "Check the activity code and database."
    assert _not_found_hint("[not json") == "Check the activity code and database."
    assert _not_found_hint("[]") == "Check the activity code and database."


def test_it_names_every_candidate_because_it_cannot_know_which_one_was_meant():
    """In the run this was built for, the PP label and the pallet wrap both stood at 0.00025 in base
    units. Naming only the first would have pointed the reader at the innocent parameter."""
    found = _run(
        "0.25 g PP label and 0.25 kg LDPE wrap",
        [
            {"name": "mass_pp_label", "amount": 0.00025, "unit": "kg"},
            {"name": "mass_wrap_pallet", "amount": 0.00025, "unit": "kg"},
        ],
    )
    # The gram figure is booked (both parameters carry it); the kilogram figure is not.
    assert [w for w, _ in found] == ["0.25 kg"]
    assert "mass_pp_label" in found[0][1] and "mass_wrap_pallet" in found[0][1]


def test_a_neighbouring_parameter_does_not_declare_the_quantity_booked():
    """The tolerance started at 1.5 and swallowed the case it was built for: the pallet's NAIL mass of
    0.2 kg sits within 1.5x of a declared 0.25 kg, so an unrelated parameter silenced a thousand-fold
    slip on the wrap."""
    found = _run(
        "0.25 kg LDPE wrap",
        [
            {"name": "mass_nails_pallet", "amount": 0.2, "unit": "kg"},
            {"name": "mass_wrap_pallet", "amount": 0.00025, "unit": "kg"},
        ],
    )
    assert len(found) == 1 and "mass_wrap_pallet" in found[0][1]


def test_the_unused_parameter_remedy_offers_the_split_before_the_delete():
    """V278. Under cut-off a recycled share has no exchange BY DESIGN, and the old remedy — "delete
    it, or use it" — recommended deleting a sourced EPA figure out of the report's parameter table.

    Measured against two models: the old wording sent one into rewriting every split
    as `1 - a - b` while calling it "faking usage", and the other into inventing an
    `eol_total = a + b + c` that nothing consumes either. The new wording sent both to the right
    place, and a genuinely dead parameter (a price in a model that computes no costs) is still
    deleted.
    """
    with patch(
        "prism_lca.engine.params.unreachable_parameters",
        return_value={"eol_pet_recycled": []},
    ):
        (name, message), = health._unused_parameters("any-model")

    assert name == "eol_pet_recycled"
    # The split comes first and carries the formula, with the parameter's own name in it.
    assert message.index("REMAINDER") < message.index("delete it")
    assert '"1 - eol_pet_recycled - <the other shares>"' in message
    assert "burden-free" in message
    # …and the shortcut both models reached for is named and refused.
    assert "Do NOT invent a parameter that merely adds the shares up" in message
    # The verdict itself is unchanged: a scenario on it still returns the baseline.
    assert "returns the baseline" in message


def test_a_footprint_is_geometry_and_never_a_quantity():
    """V280, the check's first fire in the field: "3 m × 3 m" is a pavilion's footprint, and the
    first half of it was matched against a 300-km transport parameter, "a factor of 100000 away".
    A figure inside a measurement expression is off the table — with × and with x alike."""
    params = [{"name": "km_lkw_cn", "amount": 300, "unit": "km"}]
    assert _run("a pavilion of 3 m × 3 m footprint", params) == []
    assert _run("Faltpavillon 300 x 300 cm", params) == []
    # …and the exclusion is exactly that narrow: the same figure outside an expression still counts.
    assert len(_run("3 m of seam", [{"name": "seam_m", "amount": 3000, "unit": "m"}])) == 1


def test_five_decades_is_not_a_slip():
    """V280, the corridor's ceiling: g↔kg is 10³, nobody misses a field by five decades. 10⁴ (the
    last plausible hop) still fires — the parametrised test above pins that boundary."""
    assert _run("over 3 m of profile", [{"name": "km_lkw_cn", "amount": 300, "unit": "km"}]) == []


def test_the_finding_shows_its_arithmetic():
    """V280 (c): the reader's first job was to reconstruct the factor to decide whether to believe
    it — now the message carries parameter value, scope value in base units, and the factor."""
    found = _run(
        "0.25 kg LDPE wrap", [{"name": "wrap_mass_kg", "amount": 0.00025, "unit": "kg"}]
    )
    assert len(found) == 1
    culprit = found[0][1]
    assert "wrap_mass_kg holds 0.00025" in culprit
    assert "comes to 0.25" in culprit
    assert "factor of 1000" in culprit


def test_a_thousands_grouped_figure_booked_at_its_grouped_value_is_silence():
    """"22.848 km" in a German scope IS the 22848.4 km the model books (V404) — the check
    read it as 22.848 and reported a factor of 1000. Both readings count; the decimal one still fires
    when neither matches anything."""
    assert _run("Seetransport Ningbo–Hamburg, 22.848 km", [{"name": "km_sea", "amount": 22848.4, "unit": "km"}]) == []
    # The English spelling of the same quantity is unchanged, and so is the real slip.
    assert _run("sea leg of 22,848 km", [{"name": "km_sea", "amount": 22848.4, "unit": "km"}]) == []
    found = _run("Seetransport über 22.848 km", [{"name": "km_sea", "amount": 0.022848, "unit": "km"}])
    assert len(found) == 1 and "km_sea" in found[0][1]
