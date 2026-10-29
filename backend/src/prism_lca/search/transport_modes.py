"""Which way of moving goods or people a query asks for, and the ranking that follows from it.

"freight transport by truck" shares two of its three words with every freight dataset; only "truck" says which
one is meant, and it is a word the databases do not use. When a query asks for a transport service and names
exactly one mode, the services of that mode move up and those of every other mode move down. Nothing else is
touched.

A query asks for a service when it says so — "transport", "freight", "Fracht", "ride" … — so "car battery" or
"heavy duty truck production" leave the ranking alone; so does "delivery van", the name of a vehicle. A dataset
is a service when it is counted in tonne-, person- or vehicle-kilometres; vehicles, infrastructure and fuels
(counted per unit, per kilogram) are never adjusted, and neither are the vehicle and infrastructure shares some
databases list beside a service. The mode comes from plain words in the dataset's name. Freight and passenger
services are kept apart when the query says which it wants: "air freight" does not lift passenger flights.
"road" alone covers every road vehicle; "truck", "van", "car" and "bus" name one of them. German compounds
name the mode in front of the transport word ("Bahntransport", "Zugfahrt") and count like the separate word.

A query that names the transport only as what something is for — "diesel for road transport", "Reifen für
PKW-Transport", or in the databases' own comma style "tyre wear emissions, lorry transport" — asks for the
diesel, the tyres, the emissions. There the other modes still move down, but the named one is not lifted:
lifted, its services would push the product itself out of the list. "market for transport, …" is no such
case: it is the databases' wording for the service itself.
"""

from __future__ import annotations

import re
from typing import NamedTuple

#: How much a service of the asked mode gains, and a service of any other mode loses, on the fused score.
UP, DOWN = 2.0, 0.5

#: Mode → words a query uses for it (lower case; a space also matches a hyphen).
QUERY_WORDS: dict[str, tuple[str, ...]] = {
    "road": ("road", "roads", "road transport"),
    "lorry": ("truck", "trucks", "lorry", "lorries", "hgv", "heavy goods vehicle", "lkw", "lastwagen",
              "lastkraftwagen", "sattelzug", "semi trailer", "road freight"),
    "sea": ("sea", "ocean", "ship", "ships", "vessel", "sea freight", "ocean freight", "overseas", "container ship",
            "seefracht", "containerschiff", "schiff", "ferry", "ferries"),
    "air": ("air", "plane", "planes", "airplane", "aeroplane", "aircraft", "air freight", "luftfracht", "flugzeug",
            "flight", "flights", "flug"),
    "rail": ("train", "trains", "rail", "railway", "rail freight", "bahn", "güterzug", "zug"),
    "inland waterway": ("barge", "barges", "inland waterway", "inland waterways", "river barge", "binnenschiff"),
    "van": ("van", "vans", "delivery van", "light commercial vehicle", "lieferwagen"),
    "car": ("car", "cars", "passenger car", "car ride", "pkw", "auto"),
    "bus": ("bus", "buses", "coach", "coaches", "trolleybus"),
    "tram": ("tram", "trams", "straßenbahn", "strassenbahn"),
}

#: Mode → the front of a German compound whose back is a transport word ("Bahn|transport", "Zug|fahrt").
#: "Auto" is not here: an "Autotransport" carries cars.
COMPOUND_HEADS: dict[str, tuple[str, ...]] = {
    "road": ("straßen", "strassen"),
    "lorry": ("lkw", "lastwagen", "lastkraftwagen"),
    "sea": ("schiffs", "schiff", "see", "hochsee"),
    "air": ("luft", "flug"),
    "rail": ("bahn", "eisenbahn", "zug", "schienen"),
    "bus": ("bus", "reisebus"),
    "tram": ("straßenbahn", "strassenbahn", "tram"),
    "car": ("pkw",),
}

#: The modes "road" covers.
ROAD = frozenset({"lorry", "van", "car", "bus"})

#: Mode → words in a dataset name that place a service there; checked in this order, so "barge tanker" is an
#: inland waterway and not the sea.
NAME_WORDS: dict[str, tuple[str, ...]] = {
    "inland waterway": ("barge", "inland waterways", "inland waterway"),
    "sea": ("sea", "ship", "tanker", "ferry", "bulk carrier", "transoceanic", "vessel"),
    "air": ("aircraft", "airplane"),
    "rail": ("train", "rail", "railway"),
    "tram": ("tram",),
    "bus": ("bus", "coach", "trolleybus"),
    "van": ("light commercial vehicle", "van"),
    "car": ("passenger car", "passenger, car"),
    "lorry": ("lorry", "truck"),
}

#: Unit → what the service carries; "vehicle" (a vehicle-kilometre) serves freight and passenger queries alike.
UNITS: dict[str, str] = {
    "ton kilometer": "freight", "tkm": "freight",
    "person kilometer": "passenger", "pkm": "passenger",
    "kilometer": "vehicle", "vkm": "vehicle",
}

_LETTER = r"[^\W_]"

#: A query asks for a transport service. Stems match inside German compounds ("Gütertransport", "LKW-Fahrt"),
#: but not in "Transportbeton" (ready-mixed concrete) or in a vehicle's name ("delivery van").
_SERVICE = re.compile(r"transport(?!beton)|freight|fracht|güter|cargo|shipping|haul|"
                      r"deliver(?!y[\s-]+(?:vans?|trucks?|lorry|lorries|vehicles?)(?![^\W_]))|logistic|carriage|"
                      r"fahrt|verkehr|beförder|commut|travel|flight|(?<![^\W_])reise|(?<![pk])reisen?(?![^\W_])|"
                      r"(?<![^\W_])(?:ride|rides|trip|trips|flug|tkm|pkm)(?![^\W_])", re.IGNORECASE)
_FREIGHT = re.compile(r"freight|fracht|güter|cargo|goods|(?<![^\W_])tkm(?![^\W_])", re.IGNORECASE)
_PASSENGER = re.compile(r"passenger|person|fahrgast|commut|travel|flight|(?<![^\W_])reise|(?<![pk])reisen?(?![^\W_])|"
                        r"(?<![^\W_])(?:ride|rides|trip|trips|flug|pkm)(?![^\W_])", re.IGNORECASE)
#: "… for <transport>" and "…, <transport>": the words before name what is asked for, unless they ask for
#: transport themselves.
_PURPOSE = re.compile(r"(?<![^\W_])(?:for|für|fuer)(?![^\W_])|,", re.IGNORECASE)
#: The databases' own "market for …", "market group for …".
_MARKET = re.compile(r"^\s*market\s+(?:group\s+)?for\s+", re.IGNORECASE)
#: The shares of a service some databases list beside it ("Transport, aircraft, freight, Fahrzeug").
_COMPONENT = re.compile(r",\s*(?:Fahrzeug|Infrastruktur|Betrieb)\s*$", re.IGNORECASE)


def _pattern(words: tuple[str, ...]) -> re.Pattern:
    body = "|".join(re.escape(w).replace(r"\ ", r"[\s,-]+") for w in sorted(words, key=len, reverse=True))
    return re.compile(rf"(?<!{_LETTER})(?:{body})(?!{_LETTER})", re.IGNORECASE)


def _compound(heads: tuple[str, ...]) -> re.Pattern:
    body = "|".join(re.escape(h) for h in sorted(heads, key=len, reverse=True))
    return re.compile(rf"(?<!{_LETTER})(?:{body})(?=transport|fracht|güter|verkehr|fahrt|reise)", re.IGNORECASE)


_QUERY = {mode: _pattern(words) for mode, words in QUERY_WORDS.items()}
_COMPOUNDS = {mode: _compound(heads) for mode, heads in COMPOUND_HEADS.items()}
_NAME = {mode: _pattern(words) for mode, words in NAME_WORDS.items()}

#: Every single word a query may name a mode with: the honesty checks and the search signature keep them
#: however short they are ("car" and "van" are a different search).
WORDS: frozenset[str] = frozenset(w for words in QUERY_WORDS.values() for w in words if " " not in w)


class Intent(NamedTuple):
    mode: str
    kind: str | None  # "freight", "passenger", or None when the query does not say
    lift: bool  # False when the transport is only what the thing asked for is for


def _modes(text: str) -> set[str]:
    modes = {mode for mode, pattern in _QUERY.items() if pattern.search(text)}
    modes |= {mode for mode, pattern in _COMPOUNDS.items() if pattern.search(text)}
    if "road" in modes and len(modes) > 1 and modes - {"road"} <= ROAD:
        modes.discard("road")  # "road transport by truck" asks for the lorry
    return modes


def _lifts(query: str) -> bool:
    query = _MARKET.sub("", query)
    purpose = _PURPOSE.search(query)
    if not purpose:
        return True
    head = query[:purpose.start()]
    return bool(_SERVICE.search(head) or _modes(head))


def query_intent(query: str) -> Intent | None:
    """The mode a query asks a transport service of, when it names exactly one."""
    query = query or ""
    if not _SERVICE.search(query):
        return None
    modes = _modes(query)
    if len(modes) != 1:
        return None
    freight, passenger = bool(_FREIGHT.search(query)), bool(_PASSENGER.search(query))
    return Intent(modes.pop(),
                  "freight" if freight and not passenger else "passenger" if passenger and not freight else None,
                  lift=_lifts(query))


def service(meta: dict) -> tuple[str, str] | None:
    """(mode, what it carries) of a transport service — mode "" when no word names one — or None for anything
    that is not a service."""
    carries = UNITS.get(str(meta.get("unit") or "").strip().lower())
    name = meta.get("name") or ""
    if carries is None or _COMPONENT.search(name):
        return None
    for mode, pattern in _NAME.items():
        if pattern.search(name):
            return mode, carries
    return "", carries


def adjust(intent: Intent, candidates: list[dict]) -> list[dict]:
    """Services of the asked mode (and kind) up, every other service down — on the fused score, in place."""
    for c in candidates:
        if "fused" not in c:
            continue
        found = service(c)
        if found is None:
            continue
        mode, carries = found
        fits = (mode == intent.mode or (intent.mode == "road" and mode in ROAD)) and (
            intent.kind is None or carries in (intent.kind, "vehicle"))
        c["fused"] *= (UP if intent.lift else 1.0) if fits else DOWN
    return candidates
