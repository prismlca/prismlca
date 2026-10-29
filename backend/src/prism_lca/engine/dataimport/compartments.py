"""Mapping a foreign compartment path onto ours — including the rule for what is missing.

A flow's compartment is not decoration. CO₂ to air and CO₂ to water are two different flows with
two different characterisation factors, so the compartment is a **filter** on the candidate list,
not one feature among several: a candidate from the wrong compartment never reaches the matcher.

The rule for missing subcompartments is not invented — it is read off our own biosphere (measured
on ecoinvent 3.12's ``biosphere3``, 9 850 flows):

===================  ================================================  ==============
compartment          subcompartments                                   flows with none
===================  ================================================  ==============
air                  low population density long-term · lower               **1 276**
                     stratosphere + upper troposphere · non-urban air
                     or from high stacks · urban air close to ground
water                fossil well · ground- · ground-, long-term ·           **1 272**
                     ocean · surface water
soil                 agricultural · forestry · industrial                     **942**
natural resource     biotic · fossil well · in air · in ground ·                **0**
                     in water · land
===================  ================================================  ==============

So "no subcompartment" is a *real target* in three of the four compartments — it is ecoinvent's own
"unspecified" — and in the fourth it does not exist. That asymmetry is the whole rule.
"""

from __future__ import annotations

from dataclasses import dataclass

#: How the compartment names the world's exporters use map onto ours. The left side is lower-cased
#: and stripped of the "Emissions to"/"Resources from" prefixes that ILCD and SimaPro prepend.
_COMPARTMENT_ALIASES: dict[str, str] = {
    "air": "air", "emissions to air": "air", "airborne emissions": "air", "emission to air": "air",
    "water": "water", "emissions to water": "water", "waterborne emissions": "water",
    "emission to water": "water",
    "soil": "soil", "emissions to soil": "soil", "emission to soil": "soil",
    "natural resource": "natural resource", "resources": "natural resource",
    "raw materials": "natural resource", "resources from ground": "natural resource",
    "raw": "natural resource", "resource": "natural resource",
}

#: Subcompartment spellings other tools use for ours.
_SUB_ALIASES: dict[tuple[str, str], str] = {
    # "low population density" is ecoinvent's NON-URBAN air; only the source's own "long-term"
    # says long-term. The alias added a time horizon the source never stated — and with it other
    # characterisation factors. The background mapping table agrees.
    ("air", "low population density"): "non-urban air or from high stacks",
    ("air", "high population density"): "urban air close to ground",
    ("air", "urban air close to ground"): "urban air close to ground",
    ("air", "low. pop."): "non-urban air or from high stacks",
    ("air", "low. pop., long-term"): "low population density, long-term",
    ("air", "low population density, long-term"): "low population density, long-term",
    ("air", "stratosphere + troposphere"): "lower stratosphere + upper troposphere",
    ("water", "river"): "surface water",
    ("water", "lake"): "surface water",
    ("water", "groundwater"): "ground-",
    ("water", "ground water"): "ground-",
    ("soil", "agricultural"): "agricultural",
    ("soil", "industrial"): "industrial",
    ("soil", "forestry"): "forestry",
}

#: The compartments in which "no subcompartment" is itself a valid target (measured, see above).
UNSPECIFIED_ALLOWED = frozenset({"air", "water", "soil"})


@dataclass(frozen=True)
class CompartmentMatch:
    #: The categories tuple to look for in biosphere3, or None when the rule refuses to guess.
    categories: tuple[str, ...] | None
    #: The source named no subcompartment and the flow was placed in the bare compartment.
    #:
    #: This is NOT a downgrade, and getting that wrong once cost the band its meaning: most sources
    #: give a compartment and nothing more, so treating "unspecified" as a widening would have
    #: marked the majority of a normal import "medium" — a band that applies to nearly everything
    #: says nothing about anything. The bare compartment is a real ecoinvent category and honouring
    #: an omission is the correct answer, not a compromise. A subcompartment that WAS given and
    #: could not be placed does not come through here at all: the lookup misses and the flow goes
    #: to the shortlist.
    unspecified: bool
    reason: str
    #: The compartment itself, even when no categories tuple could be formed. A refusal here is not
    #: the end of the road: "resource, unspecified" names a compartment we know, and if the
    #: substance exists in exactly one of its subcompartments there is nothing left to guess —
    #: coal is in the ground, and ecoinvent has it nowhere else.
    compartment: str = ""


def _clean(part: str) -> str:
    return (part or "").strip().strip(",").lower()


def _strip_compartment_prefix(compartment: str, part: str) -> str:
    """The subcompartment inside a level like ``"emissions to air, unspecified"``.

    Longest prefix first, and that ordering is the whole trick: stripping ``"air, "`` before
    ``"emissions to air"`` turns that level into ``"emissions to unspecified"`` — a subcompartment
    that exists nowhere, arrived at by two correct-looking replacements in the wrong order.
    """
    text = part
    for prefix in sorted(
        (
            f"emissions to {compartment}",
            f"emission to {compartment}",
            f"resources from {compartment}",
            f"resources from {compartment} ground",
            compartment,
        ),
        key=len,
        reverse=True,
    ):
        if text.startswith(prefix):
            text = text[len(prefix) :]
            break
    text = text.strip(" ,;/-")
    return "" if text in {"", "unspecified", "non-specified", "unspecified subcompartment"} else text


def resolve(path: tuple[str, ...]) -> CompartmentMatch:
    """Map a source compartment path onto a ``biosphere3`` categories tuple.

    ``path`` is outermost-first as the source wrote it, e.g.
    ``("Emissions", "Emissions to air", "Emissions to air, unspecified")``.
    """
    parts = [p for p in (_clean(p) for p in path) if p]
    if not parts:
        return CompartmentMatch(
            None,
            False,
            "the source gives no compartment — too little to place an elementary flow, and guessing "
            "one would put an emission in the wrong medium",
        )

    level = next((i for i, p in enumerate(parts) if p in _COMPARTMENT_ALIASES), None)
    if level is None:
        return CompartmentMatch(None, False, f"“{' / '.join(path)}” is not a compartment PrismLCA knows")
    compartment = _COMPARTMENT_ALIASES[parts[level]]

    # Only levels BELOW the compartment can be a subcompartment. What stands above it is a grouping
    # — ILCD writes "Emissions / Emissions to air / …", and reading that first level as a
    # subcompartment yields the non-existent "air / emissions".
    below = parts[level + 1 :]
    # The deepest level decides, and it decides even when it says "unspecified": a source that
    # states "unspecified" has answered the question, and falling back to a shallower level would
    # overrule the answer with a guess.
    sub = ""
    if below:
        stripped = _strip_compartment_prefix(compartment, below[-1])
        sub = _SUB_ALIASES.get((compartment, stripped), stripped) if stripped else ""

    if not sub:
        if compartment in UNSPECIFIED_ALLOWED:
            return CompartmentMatch(
                (compartment,),
                True,
                f"no subcompartment given — placed in unspecified {compartment}, which is a real "
                f"category in our biosphere",
                compartment,
            )
        return CompartmentMatch(
            None,
            False,
            "a natural resource always carries a subcompartment in our biosphere (in ground, in "
            "water, in air, biotic, land, fossil well); there is nothing to fall back on",
            compartment,
        )
    return CompartmentMatch((compartment, sub), False, f"{compartment} / {sub}", compartment)
