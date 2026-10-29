"""Turning a foreign amount into our unit — in three classes that must not be confused.

The classes exist because they are differently *safe*, and a converter that treats them alike is
worse than none:

**A — exact.** The factor is a definition. MJ↔kWh is 3.6 because that is what the units mean.
Runs automatically and does not touch the confidence of a match.

**B — needs an assumption about the substance.** litre→kilogram needs a density, m³ of gas→MJ needs
a calorific value, kilogram→item needs a mass. The factor is a *modelling decision*, so it is never
applied silently: the assumption is written out in words and the match can be no better than "low"
until a person confirms it.

**C — impossible.** kg↔kWh has no factor, with or without an assumption. This is deliberately NOT
treated as a conversion problem: a unit that cannot be converted is the strongest available signal
that the *match* is wrong, and covering it with an invented factor would hide exactly the error the
review step exists to catch.

bw2io's ``UNITS_NORMALIZATION`` (46 spellings, measured) does the spelling half — "kg" and
"kilogram" and "KG" are one unit. This module does the arithmetic half, which bw2io only covers for
one special case (``change_electricity_unit_mj_to_kwh``).
"""

from __future__ import annotations

from dataclasses import dataclass

#: Canonical spelling per unit. Built on bw2io's table and extended where our sources differ; the
#: import is not the place to discover that "cubic meter" and "m3" are the same thing.
_SPELLINGS: dict[str, str] = {
    "kg": "kilogram", "kilogram": "kilogram", "kilograms": "kilogram", "kgs": "kilogram",
    "g": "gram", "gram": "gram", "grams": "gram",
    "mg": "milligram", "milligram": "milligram",
    "t": "ton", "ton": "ton", "tonne": "ton", "metric ton": "ton", "tons": "ton",
    "kwh": "kilowatt hour", "kilowatt hour": "kilowatt hour", "kw*h": "kilowatt hour",
    "mj": "megajoule", "megajoule": "megajoule",
    "kj": "kilojoule", "kilojoule": "kilojoule",
    "gj": "gigajoule", "gigajoule": "gigajoule",
    "wh": "watt hour", "watt hour": "watt hour",
    "l": "litre", "liter": "litre", "litre": "litre", "liters": "litre", "litres": "litre",
    "m3": "cubic meter", "m³": "cubic meter", "cubic meter": "cubic meter", "cubic metre": "cubic meter",
    "ml": "millilitre", "millilitre": "millilitre", "milliliter": "millilitre",
    "m2": "square meter", "m²": "square meter", "square meter": "square meter", "square metre": "square meter",
    "ha": "hectare", "hectare": "hectare",
    "km": "kilometer", "kilometer": "kilometer", "kilometre": "kilometer",
    "m": "meter", "meter": "meter", "metre": "meter",
    "tkm": "ton kilometer", "ton kilometer": "ton kilometer", "tonne kilometer": "ton kilometer",
    "kgkm": "kilogram kilometer", "kilogram kilometer": "kilogram kilometer",
    "p": "unit", "unit": "unit", "item": "unit", "item(s)": "unit", "items": "unit", "piece": "unit",
    "a": "year", "year": "year", "h": "hour", "hour": "hour", "hr": "hour",
    # Radioactivity. Missing entirely until now, which made "Bq" against our "kilo Becquerel" read
    # as two incompatible quantities — a factor of a thousand reported as a dead end.
    "bq": "becquerel", "becquerel": "becquerel",
    "kbq": "kilo becquerel", "kilo becquerel": "kilo becquerel", "kilobecquerel": "kilo becquerel",
    "mbq": "mega becquerel", "mega becquerel": "mega becquerel", "megabecquerel": "mega becquerel",
    # A standard cubic metre is a cubic metre at a stated temperature and pressure. Treating the two
    # as one is what every importer does; the point of naming it here is that "kg against Sm3" then
    # reports honestly as mass against volume instead of "not a unit PrismLCA knows".
    "sm3": "cubic meter", "standard cubic meter": "cubic meter",
    "nm3": "cubic meter", "normal cubic meter": "cubic meter",
    # The units US sources actually arrive in. Definitions, not conventions: the pound is 1959's
    # international avoirdupois, the gallon is the US liquid gallon (US LCI is a US inventory; a
    # UK source writing "gal" is rare enough to correct by hand), the Btu is the IT Btu.
    "lb": "pound", "pound": "pound", "lbs": "pound", "pounds": "pound",
    "oz": "ounce", "ounce": "ounce",
    "short ton": "short ton",
    "gal": "us gallon", "gallon": "us gallon", "us gallon": "us gallon",
    "ft3": "cubic foot", "cubic foot": "cubic foot", "cu ft": "cubic foot", "cuft": "cubic foot",
    "scf": "cubic foot", "standard cubic foot": "cubic foot",
    "btu": "btu", "mmbtu": "million btu", "million btu": "million btu",
    "mwh": "megawatt hour", "megawatt hour": "megawatt hour",
    "gwh": "gigawatt hour", "gigawatt hour": "gigawatt hour",
    "ug": "microgram", "µg": "microgram", "microgram": "microgram",
    "cm3": "cubic centimeter", "cm³": "cubic centimeter", "cubic centimeter": "cubic centimeter",
    "dm3": "litre", "dm³": "litre",
}

#: What a unit measures. Two units convert exactly only within one dimension — that single rule is
#: what makes class C fall out by itself instead of needing a list of forbidden pairs.
_DIMENSION: dict[str, str] = {
    "kilogram": "mass", "gram": "mass", "milligram": "mass", "ton": "mass",
    "kilowatt hour": "energy", "megajoule": "energy", "kilojoule": "energy",
    "gigajoule": "energy", "watt hour": "energy",
    "litre": "volume", "cubic meter": "volume", "millilitre": "volume",
    "square meter": "area", "hectare": "area",
    "kilometer": "length", "meter": "length",
    "ton kilometer": "transport", "kilogram kilometer": "transport",
    "unit": "count", "year": "time", "hour": "time",
    "becquerel": "radioactivity", "kilo becquerel": "radioactivity",
    "mega becquerel": "radioactivity",
    "pound": "mass", "ounce": "mass", "short ton": "mass", "microgram": "mass",
    "us gallon": "volume", "cubic foot": "volume", "cubic centimeter": "volume",
    "btu": "energy", "million btu": "energy", "megawatt hour": "energy", "gigawatt hour": "energy",
}

#: How much of the dimension's base unit one of these is. Definitions, all of them.
_IN_BASE: dict[str, float] = {
    "kilogram": 1.0, "gram": 1e-3, "milligram": 1e-6, "ton": 1e3,
    "megajoule": 1.0, "kilowatt hour": 3.6, "kilojoule": 1e-3, "gigajoule": 1e3, "watt hour": 3.6e-3,
    "cubic meter": 1.0, "litre": 1e-3, "millilitre": 1e-6,
    "square meter": 1.0, "hectare": 1e4,
    "meter": 1.0, "kilometer": 1e3,
    "ton kilometer": 1.0, "kilogram kilometer": 1e-3,
    "unit": 1.0, "hour": 1.0, "year": 8760.0,
    "kilo becquerel": 1.0, "becquerel": 1e-3, "mega becquerel": 1e3,
    "pound": 0.45359237, "ounce": 0.028349523125, "short ton": 907.18474, "microgram": 1e-9,
    "us gallon": 3.785411784e-3, "cubic foot": 0.028316846592, "cubic centimeter": 1e-6,
    "btu": 1.05505585262e-3, "million btu": 1055.05585262,
    "megawatt hour": 3600.0, "gigawatt hour": 3.6e6,
}


class Conversion(str):
    """Marker for the three classes, so a caller cannot mistake one for another."""


EXACT = Conversion("exact")
ASSUMED = Conversion("assumed")
IMPOSSIBLE = Conversion("impossible")


@dataclass(frozen=True)
class Rescale:
    kind: Conversion
    factor: float
    #: What happened, in the words the review table and the import report print.
    note: str

    @property
    def ok(self) -> bool:
        return self.kind is not IMPOSSIBLE


def canonical(unit: str) -> str:
    """The one spelling we compare against. Unknown units keep their own text, lower-cased."""
    cleaned = (unit or "").strip().lower()
    return _SPELLINGS.get(cleaned, cleaned)


def dimension(unit: str) -> str:
    """What a unit measures — "mass", "volume", "energy" — or "" for one we do not know.

    Exposed so the review and the matching model can SAY that two units measure different things,
    instead of leaving a reader to spot that "kg" and "standard cubic meter" are not neighbours.
    """
    return _DIMENSION.get(canonical(unit), "")


def same_unit(left: str, right: str) -> bool:
    return bool(left) and canonical(left) == canonical(right)


def rescale(from_unit: str, to_unit: str) -> Rescale:
    """The factor that turns an amount in ``from_unit`` into ``to_unit``.

    Only class A is decided here. Class B needs a substance and therefore a caller that knows which
    one — see :func:`with_assumption`.
    """
    a, b = canonical(from_unit), canonical(to_unit)
    if not a or not b:
        return Rescale(IMPOSSIBLE, 1.0, "one side has no unit, so nothing can be converted")
    if a == b:
        return Rescale(EXACT, 1.0, "same unit")

    dim_a, dim_b = _DIMENSION.get(a), _DIMENSION.get(b)
    if dim_a is None or dim_b is None:
        return Rescale(
            IMPOSSIBLE, 1.0, f"“{from_unit}” or “{to_unit}” is not a unit PrismLCA knows"
        )
    if dim_a != dim_b:
        return Rescale(
            IMPOSSIBLE,
            1.0,
            f"{dim_a} cannot be converted into {dim_b} — this usually means the match itself is wrong",
        )
    factor = _IN_BASE[a] / _IN_BASE[b]
    return Rescale(EXACT, factor, f"{from_unit} → {to_unit}, factor {factor:g}")


def with_assumption(from_unit: str, to_unit: str, *, quantity: float, what: str) -> Rescale:
    """A class-B conversion: the caller supplies the substance property and it is written down.

    ``quantity`` is how much of ``to_unit`` one ``from_unit`` is — a density in kg/l, a calorific
    value in MJ/m³, a piece mass in kg. The note names it, because a factor whose origin is not on
    screen is indistinguishable from one somebody invented.
    """
    if quantity <= 0:
        return Rescale(IMPOSSIBLE, 1.0, f"{what} must be positive to convert {from_unit} to {to_unit}")
    return Rescale(ASSUMED, quantity, f"{from_unit} → {to_unit} via {what} ({quantity:g} {to_unit}/{from_unit})")
