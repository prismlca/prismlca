"""Reading a number in chapter prose: where it stands, whether it is a designation or a year, and which
unit is written after it.

The gate's figure rules (`report_numbers`) and the printed-form index (`report_printed`) both have to
answer "is 1350 here a year or 1350 MJ?" and "is this kg a mass or kg CO2-Eq?" the same way, in five
report languages. This module is that reading and nothing else: it judges no chapter and knows no
placeholder.
"""
from __future__ import annotations

import re
from typing import Any

from prism_lca.engine import units as units_of

#: A bare number typed into the prose. Forbidding every digit produces worse prose than it prevents,
#: so two kinds are left alone: small numbers and years ("the 3 phases", "in 2021"), and numbers that
#: are part of a *designation* rather than a result — "ISO 14044", "ecoinvent 3.12", "CML v4.8". Those
#: cannot go stale when the model is recomputed, which is the only thing this rule protects against.
_LITERAL_NUMBER = re.compile(r"(?<![\w.])\d[\d.,]*(?:[eE][+-]?\d+)?")
ALLOWED_LITERALS = re.compile(r"^(?:1[0-9]{3}|20[0-9]{2}|1[0-9]|[0-9])$")
DESIGNATORS = (
    "iso", "en", "din", "iec", "cen", "ipcc", "cml", "recipe", "traci", "pef", "epd",
    "ecoinvent", "gabi", "usetox", "gwp", "version", "v", "no",
)
_DESIGNATED = re.compile(
    r"(?:\b(?:" + "|".join(DESIGNATORS) + r")\b[\s.:v-]*)(\d[\d.,]*)", re.IGNORECASE
)


def numbers_in(text: str) -> list[tuple[str, int]]:
    """Numbers that are neither a designation nor obviously harmless, with where each one ends."""
    designated = {m.start(1) for m in _DESIGNATED.finditer(text)}
    return [(m.group(0), m.end()) for m in _LITERAL_NUMBER.finditer(text) if m.start() not in designated]


#: Unit tokens as they follow a figure in prose. Lower-cased; identifiers stay verbatim in reports, so
#: the SI/LCA symbols cover the five languages — the words are a small extra net. Matched as a PREFIX of
#: the token (see `unit_prefix`), so "kg" also covers "kg CO2-Eq", "kgCO2e", "kg-CO2-eq" and "kg/FU",
#: and "MJ" covers "MJ-eq"; the LCIA method's own units are added per report (`method_units`).
_UNIT_WORDS = frozenset({
    "kg", "g", "mg", "µg", "ug", "ng", "t", "kt", "mt", "km", "m", "cm", "mm", "l", "ml", "hl", "ha",
    "mol", "kmol", "kwh", "mwh", "gwh", "twh", "mj", "gj", "kj", "tj", "j", "w", "kw", "mw", "wh",
    "ppm", "ppb", "pt", "pts", "mpt", "bq", "kbq", "pa", "kpa", "mpa", "kcal", "cal", "m2", "m3",
    "m²", "m³", "m2a", "m3a", "km2", "km²", "tkm", "pkm", "vkm", "ctuh", "ctue", "daly", "dalys",
    "points", "punkte", "tonne", "tonnes", "tonnen", "toneladas", "tonnellate", "kilogram",
    "kilograms", "kilogramm", "kilogramme", "kilogrammes", "kilogramos", "chilogrammi", "gram",
    "grams", "gramm", "litre", "litres", "liter", "liters", "litros", "megajoule", "megajoules",
    "kilometre", "kilometres", "kilometer", "kilometers", "percent", "prozent", "pourcent",
})

#: What may stand between a figure and its unit: nothing ("12kg", "12%"), a space or a no-break space
#: ("12 kg", "12\u202fkg"), or a hyphen ("a 2-kg bottle").
UNIT_TOKEN = re.compile(r"[\s-]{0,2}([^\s.,;:)\]]{1,16})")


def unit_prefix(token: str, extra: frozenset[str] = frozenset()) -> str | None:
    """The physical unit the token begins with — "kg" for "kg", "kgCO2e", "kg-CO2-eq", "Kg" — or None.

    A prefix counts only where the unit ENDS there: what follows is nothing, a non-letter ("kg-eq",
    "g/km") or a reference substance with a digit in it ("kgCO2e", "tCO2eq"). A bare letter run does
    not count, or "m" would start "months", "l" would start "LCA" in "the 2 LCA studies" and "km" would
    start "KMU". Case is folded for the unit itself ("Kg", "MJ"); the longest unit wins ("mj", not "m").
    """
    if token[:1] in ("%", "‰"):
        return token[0]
    if token.startswith("°"):
        return "°"
    low = token.lower()
    for unit in sorted(_UNIT_WORDS | extra, key=len, reverse=True):
        if not low.startswith(unit):
            continue
        rest = token[len(unit):]
        if not rest or not rest[0].isalpha() or any(c.isdigit() for c in rest):
            return unit
    return None


def method_units(data: dict[str, Any]) -> frozenset[str]:
    """The leading symbol of every unit the report's own results carry — "CTUh", "kBq", "disease".

    The static list cannot know every LCIA method's unit; the results handed to the writer can. Only
    result and contribution units: a parameter's unit may be "piece" or "unit", and "12 pieces" is a
    count, which is what the small-number allowance exists for.
    """
    units = [r.get("unit") for r in data.get("results") or [] if isinstance(r, dict)]
    units.append((data.get("contribution") or {}).get("unit"))
    out: set[str] = set()
    for unit in units:
        if not isinstance(unit, str) or not unit.strip():
            continue
        lead = re.split(r"[\s.,/(]", unit.strip(), maxsplit=1)[0].lower()
        if len(lead) >= 2 and re.search(r"[a-zµ]", lead) and lead not in DESIGNATORS:
            out.add(lead)
    return frozenset(out)


def physical_unit_after(text: str, end: int, extra: frozenset[str] = frozenset()) -> str | None:
    """The physical unit written right after a number — "kg" for "12 kg CO2-Eq", "%" for "12 %".

    The strict half of `unit_follows`, and the only half the small-number allowance asks: "the 3
    LCIA methods" and "2 EPDs" start with capitals and would read as units to the broader test.
    """
    m = UNIT_TOKEN.match(text[end:])
    return unit_prefix(m.group(1).rstrip(".,;:!?"), extra) if m else None


def physical_unit_follows(text: str, end: int, extra: frozenset[str] = frozenset()) -> bool:
    return physical_unit_after(text, end, extra) is not None


def written_unit(text: str, end: int) -> str:
    """The unit token after a number as the writer typed it, for quoting it back ("MJ", "kgCO2e")."""
    m = UNIT_TOKEN.match(text[end:])
    return m.group(1).rstrip(".,;:!?") if m else ""


#: What marks a unit as a characterised LCIA unit when it is written INTO the unit token: "kgCO2e",
#: "kg-CO2-Eq", "kgSO2eq". Read only on the token's own rest — never on the words after it.
CHARACTERISED = re.compile(r"(?i)eq\b|eq\.|co2|co₂|\d")

#: …and when it follows as its own token: "kg CO2-Eq", "mol H+-Eq", "kBq U235-Eq", "kg SO2 eq",
#: "kg P eq", "m3 world eq. deprived". A reference substance with its "eq", or CO2 alone ("kg CO2").
#: Deliberately narrow: "2 kg and 3 bottles" and "2 kg in 2026" are a mass, and the digit in a later
#: word is no part of the unit.
_SUBSTANCE_EQ = re.compile(
    r"(?i)(?:co2|co₂)(?:[-‑ ]?e(?:q)?\b\.?)?(?![\w])"
    r"|[\w+,₀-₉-]{1,12}?[-‑]eq\b\.?"
    r"|[\w+₀-₉]{1,8}\s+eq\b\.?"
    r"|eq\b\.?"
)


def unit_signature(text: str, end: int, extra: frozenset[str] = frozenset()) -> tuple[str, bool] | None:
    """The unit after a number and whether it is characterised — ("kg", True) for "1 kg CO2-Eq",
    ("kg", False) for "1 kg of juice". What a quotation must match: the scope's "1 kg" functional unit
    is not the "1 kg CO2-Eq" result.

    Characterised is read inside the unit expression only: the rest of the unit token itself, or the
    token directly after it when that is a reference substance (`_SUBSTANCE_EQ`). Reading "the next two
    words" made "2 kg in 2026" a characterised unit and let a parameter's value through unreported."""
    m = UNIT_TOKEN.match(text[end:])
    if not m:
        return None
    token = m.group(1).rstrip(".,;:!?")
    if (unit := unit_prefix(token, extra)) is None:
        return None
    if CHARACTERISED.search(token[len(unit):]):
        return unit, True
    after = text[end + m.end(1) :]
    # Any whitespace, a line break included ("kg\nCO2-Eq" from a wrapped line, "kg   CO2-Eq"). The
    # token is normalised before it is judged: sentence punctuation off ("kg CO2."), and a per-unit
    # suffix after the substance cut ("CO2-Eq/m2", "CO2-Eq/FU"), so the substance itself decides.
    following = re.match(r"\s+(\S+(?:\s+eq\b\.?)?)", after, re.IGNORECASE)
    if not following:
        return unit, False
    candidate = following.group(1).split("/", 1)[0].rstrip(".,;:!?)")
    return unit, bool(candidate and _SUBSTANCE_EQ.fullmatch(candidate))


def signature_key(signature: tuple[str, bool]) -> tuple[str, bool]:
    """A unit signature with its symbol normalised through the alias table — "kilometres" is "km"."""
    unit, characterised = signature
    return UNIT_ALIASES.get(unit, unit), characterised


def unit_follows(text: str, end: int, extra: frozenset[str] = frozenset()) -> bool:
    """Whether the token right after a number reads as a unit — "1350 MJ" is a figure, not a year.

    The year whitelist below let any 1000–2099 literal through, and four-digit results are routine in
    LCA (MJ, km, L for larger functional units). A token counts as a unit when it begins with a known
    unit (`physical_unit_follows`), or when it is a short token with an uppercase letter or digit
    *after* its first character ("CO2-Eq") — not on its first, or every German noun and every
    sentence-initial word after a year would match. Designators are excluded: they come before their
    number ("ISO 14044"), and "seit 2006 ISO 14044 gilt …" must stay a year.
    """
    if physical_unit_follows(text, end, extra):
        return True
    m = re.match(r"\s{1,2}([^\s.,;:)\]]{1,12})", text[end:])
    if not m:
        return False
    token = m.group(1)
    base = token.rstrip(".,;:!?").lower()
    return len(base) <= 6 and base not in DESIGNATORS and bool(re.search(r"[A-Z0-9µ]", token[1:]))


def number_key(number: str) -> str:
    """A number normalised for whitelist comparison: trailing punctuation off, decimal mark unified.

    Both sides of the quotation check go through this — the chapter's numbers used to be stripped while
    the whitelist entries were not, so a scope ending in "…of 300." blocked a chapter writing "300",
    and a German chapter quoting "1,5" never matched the metadata's "1.5"."""
    return number.rstrip(".,").replace(",", ".")


#: Spellings of a unit that mean the same symbol, for the unit-beside-placeholder comparison only.
UNIT_ALIASES: dict[str, str] = {
    "percent": "%", "prozent": "%", "pourcent": "%",
    "tonne": "t", "tonnes": "t", "tonnen": "t", "toneladas": "t", "tonnellate": "t",
    "kilogram": "kg", "kilograms": "kg", "kilogramm": "kg", "kilogramme": "kg", "kilogrammes": "kg",
    "kilogramos": "kg", "chilogrammi": "kg",
    "gram": "g", "grams": "g", "gramm": "g",
    "litre": "l", "litres": "l", "liter": "l", "liters": "l", "litros": "l",
    "megajoule": "mj", "megajoules": "mj",
    "kilometre": "km", "kilometres": "km", "kilometer": "km", "kilometers": "km",
    "points": "pt", "punkte": "pt", "pts": "pt",
    "m²": "m2", "m³": "m3", "km²": "km2",
}



def unit_family_after(text: str, end: int) -> int | None:
    """Which unit family the token after a number belongs to, or None if it carries no unit we know."""
    m = re.match(r"\s{0,2}(%|[^\s.,;:)\]]{1,6})", text[end:])
    if not m:
        return None
    placed = units_of.base(1.0, m.group(1).rstrip(".,;:!?"))
    return placed[0] if placed else None



#: Quotation marks in all five report languages, as pairs. A number inside a quoted source sentence
#: is somebody else's wording and is never rewritten — the whole point of quoting is that it is verbatim.
_QUOTE_PAIRS = (("\u201c", "\u201d"), ("\u201e", "\u201c"), ("\u00ab", "\u00bb"), ('"', '"'))


def inside_quotes(text: str, start: int) -> bool:
    """Whether the position sits inside a quotation. Cheap and deliberately over-cautious: an odd
    number of openers before it counts as inside, so an unbalanced quote suppresses the repair rather
    than risking one inside somebody else's sentence."""
    before = text[:start]
    for opener, closer in _QUOTE_PAIRS:
        if opener == closer:
            if before.count(opener) % 2 == 1:
                return True
        elif before.count(opener) > before.count(closer):
            return True
    return False
