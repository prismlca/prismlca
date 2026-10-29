"""Words the background databases do not use, and the words they use instead.

People search in everyday, American, British or German words — "truck", "gasoline", "rebar", "LKW" — where
the databases write "lorry", "petrol", "reinforcing steel". The embedding model bridges many such pairs on its
own, but not these: for "truck" the lorry markets end up far down the list, and what is left of the query
("freight transport") matches every way of moving goods. So the query is searched a second time with the
databases' word (search/variants.py), the way an abbreviation is searched spelled out.

The list is short on purpose. An entry for a word the model already understands is not free: it reorders
answers that were right. A word goes in only when a search for it fails without the entry: the wrong datasets
come first, or the right ones come back with the typed word reported as missing from them ("Luftfracht" over a
list of air-freight datasets). A phrase needs no entry when the one for its last word finds the same: "truck"
covers "refrigerated truck", while "Kühl-LKW" keeps its own, "Kühl" being no word the databases use either.
The right-hand sides are plain words, never dataset names — the list has to work for any database a user
brings.

Many words have more than one meaning; what decides is what someone searching an LCA database most likely
means. "plane" is almost always the aircraft, "styrofoam" the expanded foam, "solar power" photovoltaics —
those go in, and the search as typed still runs beside the reading. Words whose meanings are about equally
likely stay out: "solar" alone (collectors, solar thermal), "van" alone, "transporter", "shipping".
"""

from __future__ import annotations

import re

#: Typed word or phrase (lower case; a space also matches a hyphen) → the word the databases use.
TERMS: dict[str, str] = {
    # road freight — the databases say "lorry", never "truck"
    "truck": "lorry",
    "trucks": "lorry",
    "hgv": "lorry",
    "heavy goods vehicle": "lorry",
    "lkw": "lorry",
    "lastwagen": "lorry",
    "lastkraftwagen": "lorry",
    "semi trailer": "lorry",
    "sattelzug": "lorry",
    "kühl lkw": "refrigerated lorry",
    # vans — one database says "van", another "light commercial vehicle"; the reading keeps both
    "delivery van": "van, light commercial vehicle",
    "lieferwagen": "van, light commercial vehicle",
    # freight
    "road freight": "freight transport by lorry",
    "gütertransport": "freight transport",
    "guetertransport": "freight transport",
    "güterverkehr": "freight transport",
    "frachttransport": "freight transport",
    "tonnen": "metric ton",
    # air, water, passenger
    "plane": "aircraft",
    "airplane": "aircraft",
    "aeroplane": "aircraft",
    "flugzeug": "aircraft",
    "air freight": "freight transport by aircraft",
    "luftfracht": "freight transport by aircraft",
    "seefracht": "sea freight",
    "ocean freight": "sea freight",
    "containerschiff": "container ship",
    "binnenschiff": "inland waterways barge",
    "pkw": "passenger car",
    "car ride": "passenger car transport",
    # electricity from the sun — as phrases only: "solar" alone is collectors and solar thermal too
    "solar power": "photovoltaic electricity",
    "solar electricity": "photovoltaic electricity",
    "solarstrom": "photovoltaic electricity",
    "solarmodul": "photovoltaic panel",
    # fuels and materials
    "gasoline": "petrol",
    "benzin": "petrol",
    "kerosin": "kerosene",
    "jet fuel": "kerosene",
    "rebar": "reinforcing steel",
    "rebars": "reinforcing steel",
    "bewehrungsstahl": "reinforcing steel",
    "betonstahl": "reinforcing steel",
    "styrofoam": "expandable polystyrene",
    "styropor": "expandable polystyrene",
    "transportbeton": "concrete",  # ready-mixed concrete, not a transport
    "ziegel": "clay brick",
    "backstein": "clay brick",
    "mauerziegel": "clay brick",
}

_LETTER = r"[^\W_]"  # a letter or digit of any script: "ü" is part of a word, "-" is not


def _key(written: str) -> str:
    return re.sub(r"[\s-]+", " ", written.lower()).strip()


def _compile(terms: dict[str, str]) -> re.Pattern:
    phrases = sorted(terms, key=lambda p: (-len(p), p))  # the longest phrase first: "kühl lkw" before "lkw"
    body = "|".join(re.escape(p).replace(r"\ ", r"[\s-]+") for p in phrases)
    return re.compile(rf"(?<!{_LETTER})({body})(?!{_LETTER})", re.IGNORECASE)


_PATTERN = _compile(TERMS)


#: Every single word on the left-hand side: the honesty checks treat them as content however short they are
#: ("truck", "lkw", "rebar" would otherwise fall under their minimum length).
WORDS: frozenset[str] = frozenset(t for t in TERMS if " " not in t)


def _contains(text: str, words: str) -> bool:
    return re.search(rf"(?<!{_LETTER}){re.escape(words)}(?!{_LETTER})", text, re.IGNORECASE) is not None


def expand(text: str) -> tuple[str, dict[str, str]]:
    """``text`` with each listed word replaced by the databases' word, and what was replaced, as written →
    as read. A word whose reading already stands in the text is left alone: "truck, lorry" gains nothing."""
    found: dict[str, str] = {}

    def replace(m: re.Match) -> str:
        written = m.group(1)
        reading = TERMS.get(_key(written))  # None for case-folding oddities such as a Turkish "İ"
        if reading is None or _contains(text, reading):
            return written
        found[written] = reading
        return reading

    return _PATTERN.sub(replace, text), found


def restated(text: str) -> set[str]:
    """The listed words whose reading the text states as well ("truck (lorry)"): the query has said what it
    means, so a hit carrying only "lorry" carries them too."""
    out: set[str] = set()
    for m in _PATTERN.finditer(text):
        reading = TERMS.get(_key(m.group(1)))
        if reading is not None and _contains(text, reading):
            out.update(_key(m.group(1)).split())
    return out
