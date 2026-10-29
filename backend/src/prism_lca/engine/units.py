"""The handful of unit conversions a *check* is allowed to make.

Two checks need to ask "is this written figure the same quantity as that stored value": the model-health
linter, comparing a process note against the parameter it names, and the report gate, comparing a number
typed into prose against the parameters the model holds. Both had the same table; one table with one
owner is the point of this module.

Deliberately small. A conversion this cannot do with certainty is a comparison the checks must not make —
they *report* a disagreement, and a checker that guesses at units would report one that is not there.
There is no dimensional analysis here and no aspiration to any: `kg/L` and `MJ/L` are compared by their
leading symbol, because that is what the two sides of these comparisons actually carry.
"""
from __future__ import annotations

#: Symbols a figure may be written in, and what one of them is in the family's base unit.
UNIT_FAMILIES: tuple[dict[str, float], ...] = (
    {"g": 0.001, "kg": 1.0, "t": 1000.0},          # base kg
    {"mm": 0.000001, "m": 0.001, "km": 1.0},       # base km
    {"ml": 0.001, "l": 1.0},                       # base litre
    {"mj": 1.0},
    {"kwh": 1.0},
    {"%": 0.01},                                   # a share written as a percentage
)

#: Index of the share family above — a value with no unit is compared in it, because that is how a
#: dimensionless 0.85 gets written down: "85 %".
PERCENT_FAMILY = len(UNIT_FAMILIES) - 1


def base(value: float, symbol: str) -> tuple[int, float] | None:
    """(family, value in the family's base unit), or None for a symbol we do not convert."""
    low = symbol.lower()
    for index, family in enumerate(UNIT_FAMILIES):
        if low in family:
            return index, value * family[low]
    return None


def written_forms(value: float, unit: str | None) -> list[float]:
    """Every number this value could legitimately be written as, in its own family.

    0.042 kg is "0.042", "42" and "4.2e-05"; a share of 0.85 is "0.85" and "85". Used to recognise a
    parameter's value in prose whichever unit the writer chose — the figure is the same quantity either
    way, and it is equally wrong the day the parameter moves.
    """
    symbol = (unit or "").split("/")[0].strip()
    placed = base(value, symbol) if symbol else (PERCENT_FAMILY, value)
    if placed is None:
        return [value]
    index, in_base = placed
    return [in_base / factor for factor in UNIT_FAMILIES[index].values()] + [value]
