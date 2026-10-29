"""Local catalogues of airports and sea ports for the distance lookups — no key, no request.

Two sources, both read from files that ship with the app (docs/DATENHERKUNFT.md has the rows):

* **Airports** — ``assets/transport/airports.json``, built by ``scripts/build_airports.py`` from
  OurAirports (Public Domain): large and medium airports with an IATA code.
* **Ports** — the port list that ships inside the ``searoute`` package (``searoute/data/ports.geojson``,
  UN/LOCODE codes), read at runtime and never copied or altered. The package is Apache-2.0; where the
  list itself comes from is not documented upstream — that gap is recorded in the
  provenance row rather than guessed at.

The rule both resolvers follow: a catalogue answers only when the text SAYS it means a terminal — a
code (``FRA``, ``EDDF``, ``DEHAM``) or a name with an airport/port word in it. "Hamburg" alone stays
a place for the geocoder; "Port of Hamburg" is the port. An ambiguous name is an error that lists the
candidates with their codes, never a silent pick — only entries lying within a few kilometres of
each other (one terminal listed twice) count as one answer.
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

from prism_lca.engine.geodesy import geodesic_km

_ASSETS = Path(__file__).resolve().parent.parent / "assets" / "transport"

Kind = Literal["airport", "port"]


@dataclass(frozen=True)
class Terminal:
    kind: Kind
    code: str
    name: str
    country: str
    lat: float
    lon: float
    #: Airports: a large airport. Ports: flagged as a terminal port in the searoute list.
    major: bool
    #: Airports only: the ICAO code and the city, both matchable.
    icao: str = ""
    city: str = ""

    @property
    def label(self) -> str:
        place = f", {self.city}" if self.city and self.city.lower() not in self.name.lower() else ""
        return f"{self.name}{place} ({self.code}, {self.country})"


class AmbiguousTerminal(ValueError):
    """The name matches several terminals; the message names them with their codes."""


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


_AIRPORT_WORDS = {
    "airport", "airports", "international", "intl", "int", "airfield", "aerodrome",
    "flughafen", "aeroport", "aeropuerto", "aeroporto", "luchthaven", "lotnisko", "letiste",
}
_PORT_WORDS = {
    "port", "ports", "harbour", "harbor", "hafen", "seaport", "porto", "puerto", "haven",
    "havn", "hamn", "terminal", "container",
}
_FILLER = {"of", "the", "de", "del", "di", "du", "la", "le", "am", "an", "der"}


def _tokens(s: str) -> list[str]:
    return _fold(s).split()


@lru_cache(maxsize=1)
def airports() -> tuple[Terminal, ...]:
    data = json.loads((_ASSETS / "airports.json").read_text(encoding="utf-8"))
    return tuple(
        Terminal("airport", a[0], a[2], a[4], float(a[5]), float(a[6]), bool(a[7]), icao=a[1], city=a[3])
        for a in data["airports"]
    )


@lru_cache(maxsize=1)
def airport_source() -> str:
    data = json.loads((_ASSETS / "airports.json").read_text(encoding="utf-8"))
    return f"OurAirports (Public Domain), retrieved {data['retrieved']}"


@lru_cache(maxsize=1)
def ports() -> tuple[Terminal, ...]:
    import searoute  # noqa: PLC0415 — same deferred import as the sea endpoint

    path = Path(searoute.__file__).resolve().parent / "data" / "ports.geojson"
    features = json.loads(path.read_text(encoding="utf-8"))["features"]
    out = []
    for f in features:
        p = f.get("properties") or {}
        code = str(p.get("port") or "").upper()
        lon, lat = (f.get("geometry") or {}).get("coordinates") or (None, None)
        if not code or lat is None or lon is None:
            continue
        # UN/LOCODE: the first two letters are the ISO country code.
        out.append(Terminal("port", code, str(p.get("name") or code), code[:2], float(lat), float(lon), bool(p.get("t"))))
    return tuple(out)


PORT_SOURCE = "searoute 1.6 port list (UN/LOCODE)"

_LATLON = re.compile(r"^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$")
_IATA = re.compile(r"^[A-Z]{3}$")
_ICAO = re.compile(r"^[A-Z]{4}$")
_LOCODE = re.compile(r"^([A-Z]{2})\s?([A-Z0-9]{3})$")
# "Frankfurt (FRA)" or a panel label "Hamburg (DEHAM, DE)": the code opens the parentheses.
_IN_PARENS = re.compile(r"\(([A-Z]{2}\s?[A-Z0-9]{3}|[A-Z]{3,4})(?:,[^)]*)?\)")


#: Entries sharing a code this close together are one terminal listed twice; further apart, the
#: code alone does not say which place is meant.
_SAME_TERMINAL_KM = 10.0


def _by_code(kind: Kind, code: str) -> Terminal | None:
    """The terminal a code names. The searoute list reuses 38 of its codes, 16 of them for places far
    apart (USPWM is Portland, Maine AND Portland, Oregon) — a first match would silently sail from the
    wrong coast, so such a code is refused with its candidates."""
    code = code.replace(" ", "")
    hits = [t for t in (airports() if kind == "airport" else ports()) if t.code == code or (t.icao and t.icao == code)]
    if not hits:
        return None
    spread = max(geodesic_km(a.lat, a.lon, b.lat, b.lon) for a in hits for b in hits)
    if spread <= _SAME_TERMINAL_KM:
        return next((t for t in hits if t.major), hits[0])
    listed = "; ".join(f'"{t.label}"' for t in hits)
    raise AmbiguousTerminal(
        f"The code {code} stands for several places in the {kind} list: {listed}. Pass the one you mean by that exact label."
    )


def _by_label(kind: Kind, text: str) -> Terminal | None:
    """A label exactly as the panel's suggestion printed it — the one way to name an entry whose code
    is shared, so a picked suggestion keeps its own coordinates."""
    hits = [t for t in (airports() if kind == "airport" else ports()) if t.label == text]
    return hits[0] if len(hits) == 1 else None


def _is_code(kind: Kind, text: str) -> bool:
    if kind == "airport":
        return bool(_IATA.match(text) or _ICAO.match(text))
    return bool(_LOCODE.match(text))


def resolve(kind: Kind, text: str, country: str | None = None) -> Terminal | None:
    """The terminal the text names, None when it names none (then the geocoder is asked).

    Codes are matched case-sensitively — "FRA" is Frankfurt, "Fra" is not a code — so an ordinary
    word never turns into an airport. Raises ``AmbiguousTerminal`` for a name several terminals share.
    """
    clean = text.strip()
    if not clean:
        return None
    m = _LATLON.match(clean)
    if m:
        # A coordinate pair names a terminal only when it lies ON one (a label's own coordinates).
        return at_entry(kind, float(m.group(1)), float(m.group(2)))
    labelled = _by_label(kind, clean)
    if labelled:
        return labelled
    if _is_code(kind, clean):
        return _by_code(kind, clean)
    m = _IN_PARENS.search(clean)
    if m and _is_code(kind, m.group(1)):
        hit = _by_code(kind, m.group(1))
        if hit:
            return hit
    words = _AIRPORT_WORDS if kind == "airport" else _PORT_WORDS
    toks = _tokens(clean)
    if not any(t in words for t in toks):
        return None
    query = [t for t in toks if t not in words and t not in _FILLER]
    if not query:
        return None
    cc = (country or "").strip().upper()
    pool = [t for t in (airports() if kind == "airport" else ports()) if not cc or t.country == cc]
    exact, partial = [], []
    for t in pool:
        name_toks = [x for x in _tokens(t.name) if x not in words and x not in _FILLER]
        hay = set(name_toks) | set(_tokens(t.city))
        if name_toks == query:
            exact.append(t)
        elif all(q in hay for q in query):
            partial.append(t)
    # An exact name wins only when it is the only candidate at all: "London Airport" is also the
    # name of an airport in Ontario, and taking it would send a Heathrow leg to Canada.
    cands = exact + partial
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]
    # Candidates that are one terminal listed twice (within a few km) are one answer; anything
    # further apart is a guess, even inside one country — "La Palma Airport" is not Palma de Mallorca,
    # 2 238 km away, however major PMI is.
    spread = max(geodesic_km(a.lat, a.lon, b.lat, b.lon) for a in cands for b in cands)
    if spread <= _SAME_TERMINAL_KM:
        return next((t for t in cands if t.major), cands[0])
    # Major terminals first: for "London airport" the list must show Heathrow and Gatwick, not an
    # airstrip that happens to sort earlier.
    cands.sort(key=lambda t: (not t.major, t.name))
    listed = ", ".join(t.label for t in cands[:6]) + (f" and {len(cands) - 6} more" if len(cands) > 6 else "")
    raise AmbiguousTerminal(f'"{clean}" matches several {kind}s: {listed}. Pass the code instead.')


def suggest(kind: Kind, text: str, *, major_only: bool = False, limit: int = 10) -> list[Terminal]:
    """Typeahead for the panel: every query word must start a word of the name, city or code."""
    q = _tokens(text)[:6]
    if not q:
        return []
    words = _AIRPORT_WORDS if kind == "airport" else _PORT_WORDS
    q = [t for t in q if t not in words] or q
    out: list[tuple[int, str, Terminal]] = []
    for t in airports() if kind == "airport" else ports():
        if major_only and not t.major:
            continue
        hay = _tokens(f"{t.name} {t.city} {t.code} {t.icao}")
        if all(any(h.startswith(x) for h in hay) for x in q):
            starts = 0 if _fold(t.name).startswith(" ".join(q)) or t.code.lower() == " ".join(q) else 1
            out.append((starts + (0 if t.major else 2), t.name, t))
    out.sort(key=lambda r: (r[0], r[1]))
    return [t for _, _, t in out[:limit]]


#: Landlocked countries (ISO alpha-2). Their "terminal" ports in the searoute list are river or
#: Caspian ports (Bratislava, Asuncion, Giurgiulesti, Turkmenbasy, and Harare, which is no port at all):
#: never the DEFAULT sea port for a place — Prague's nearest terminal by straight line was Bratislava.
#: Still resolvable when named.
_LANDLOCKED = frozenset(
    "AD AF AM AT AZ BF BI BO BT BW BY CF CH CZ ET HU KG KZ LA LI LS LU MD MK ML MN MW NE NP PY RS "
    "RW SK SM SS SZ TD TJ TM UG UZ VA XK ZM ZW".split()
)


#: A port further than this from the shipping-lane network is never picked AUTOMATICALLY: the gap
#: between it and the network is sailed on a river or a coastal approach the network does not carry,
#: and would stay unmodelled — Wuhan (535 km up the Yangtze), Manaus (1 084 km up the Amazon). 139 of
#: the 803 terminal ports lie beyond 50 km, most of them coastal ports the coarse network passes at a
#: distance; still nameable, and the answer then flags the gap.
AUTO_PORT_MAX_NETWORK_KM = 100.0

_network_km: dict[str, float] = {}


def port_network_km(t: Terminal) -> float:
    """Great-circle distance from a port to its nearest shipping-lane node (searoute's own lookup)."""
    key = f"{t.code}|{t.lat}|{t.lon}"
    if key not in _network_km:
        node = _marnet().kdtree.query((t.lon, t.lat))
        _network_km[key] = geodesic_km(t.lat, t.lon, node[1], node[0])
    return _network_km[key]


@lru_cache(maxsize=1)
def _marnet():  # noqa: ANN202 — searoute's graph type
    import searoute  # noqa: PLC0415

    return searoute.setup_M()


#: A coordinate this close to a catalogue entry IS that entry (a label's own coordinates, pasted
#: back): it must not be re-routed to the nearest MAJOR terminal (Portland, Maine's
#: coordinates became Boston).
AT_ENTRY_KM = 0.2


def at_entry(kind: Kind, lat: float, lon: float) -> Terminal | None:
    """The catalogue entry lying at this point, major or not; None when there is none."""
    for t in airports() if kind == "airport" else ports():
        if abs(t.lat - lat) < 0.01 and abs(t.lon - lon) < 0.01 and geodesic_km(lat, lon, t.lat, t.lon) <= AT_ENTRY_KM:
            return t
    return None


def nearest(kind: Kind, lat: float, lon: float) -> tuple[Terminal, float] | None:
    """The nearest MAJOR terminal to a point — a large airport, or a port the searoute list flags as
    a terminal — and its great-circle distance in km. The default end of an access leg when the user
    named a place, not a terminal; the answer says which one was taken so it can be overridden.
    By straight line, so for an inland place it is a first guess: hinterland freight often runs to a
    bigger port further away (Munich → Hamburg, not Venice) — which is why the caller says so."""
    best: tuple[Terminal, float] | None = None
    for t in airports() if kind == "airport" else ports():
        if not t.major or (kind == "port" and t.country in _LANDLOCKED):
            continue
        if kind == "port" and port_network_km(t) > AUTO_PORT_MAX_NETWORK_KM:
            continue
        d = geodesic_km(lat, lon, t.lat, t.lon)
        if best is None or d < best[1]:
            best = (t, d)
    return best
