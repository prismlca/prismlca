"""The geography proxy chain: which regions stand in for a target region, and in what order.

One chain serves the search ranking, the order of a collapsed hit's variants, the substance-number search
and provider linking: exact region first, then the regions that contain it, then the global proxies —
``DE → RER → Europe without Switzerland → GLO → RoW``, ``US → RNA → GLO → RoW``,
``CA-QC → CA → RNA → GLO → RoW``.

Which country lies on which continent comes from the Unicode CLDR (``assets/geo/regions.json``, built by
``scripts/build_regions.py``; licence in ``assets/geo/NOTICE.md``), never from an ecoinvent file. Only the
continental location codes (RNA, RLA, RAS, RAF, OCE) are named here, as the codes datasets carry.
"""

from __future__ import annotations

import json
import re
from functools import cache
from pathlib import Path

_REGIONS_FILE = Path(__file__).resolve().parents[1] / "assets" / "geo" / "regions.json"

# European geographies (ISO codes as used by ecoinvent, plus the European aggregates):
# only these get the RER / "Europe without Switzerland" proxies inserted into their chain —
# a Chinese or Brazilian target must fall back to its own continent, then GLO/RoW, not to European datasets.
_EUROPEAN = frozenset({
    "AL", "AT", "BA", "BE", "BG", "BY", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
    "FR", "GB", "GR", "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MD", "ME",
    "MK", "MT", "NL", "NO", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "UA", "XK",
    "RER", "Europe without Switzerland", "Europe without Austria", "UCTE", "ENTSO-E",
})

#: CLDR/M49 region → the continental location code datasets carry. Europe is not here: European targets
#: have their own, longer chain above.
_CONTINENT_CODES = {
    "021": "RNA",  # Northern America
    "419": "RLA",  # Latin America and the Caribbean
    "142": "RAS",  # Asia
    "002": "RAF",  # Africa
    "009": "OCE",  # Oceania
}

#: A sub-national code: "CA-QC", "US-NPCC", "IN-GA", "BR-South-eastern/Mid-western grid".
_SUBNATIONAL = re.compile(r"^([A-Z]{2})-.+")


@cache
def _continent_of() -> dict[str, str]:
    """Country code → continental location code, from the bundled CLDR table."""
    regions = json.loads(_REGIONS_FILE.read_text(encoding="utf-8"))["regions"]
    return {
        country: code
        for m49, code in _CONTINENT_CODES.items()
        for country in regions.get(m49, {}).get("countries", [])
    }


def _parent_country(target: str) -> str | None:
    """The country a sub-national code belongs to — only when that prefix IS a country ("UN-SAMERICA" is not)."""
    found = _SUBNATIONAL.match(target)
    if not found:
        return None
    country = found.group(1)
    return country if country in _EUROPEAN or country in _continent_of() else None


def geo_chain(target: str | None) -> list[str]:
    """Proxy chain for a target region: exact match, its country (for a sub-national target), the regions
    that contain it (RER for European targets, the continent for the others), then the global proxies."""
    if not target:
        return []
    chain = [target]
    country = _parent_country(target)
    if country:
        chain.append(country)
    home = country or target
    if home in _EUROPEAN:
        chain += ["RER", "Europe without Switzerland"]
    elif home in _continent_of():
        chain.append(_continent_of()[home])
    chain += ["GLO", "RoW"]
    seen: list[str] = []
    for g in chain:
        if g not in seen:
            seen.append(g)
    return seen


#: ecoinvent's "Europe minus a few countries": "RER w/o RU", "RER w/o CH+DE", "RER w/o DE+NL+RU". Read
#: from the code itself, so a new combination needs no list entry.
_RER_WITHOUT = re.compile(r"^RER w/o ([A-Z]{2}(?:\+[A-Z]{2})*)$")


def _europe_proxy_rank(loc: str | None, target: str, chain: list[str]) -> int | None:
    """Where a "RER w/o …" region stands for a European target: beside RER, unless it leaves the target
    out. Without this it ranked as a distant region — behind RoW — and ecoinvent 3.13 moved the
    formaldehyde market from RER to "RER w/o RU", so a German search put the rest-of-world market
    first."""
    found = _RER_WITHOUT.match(loc or "")
    home = _parent_country(target) or target
    if not found or home not in _EUROPEAN or home in found.group(1).split("+"):
        return None
    # Beside RER — but never level with the target itself when the target IS RER.
    return chain.index("Europe without Switzerland") if target == "RER" else chain.index("RER")


def geo_rank(loc: str | None, target: str | None) -> int:
    chain = geo_chain(target)
    if loc in chain:
        return chain.index(loc)
    proxy = _europe_proxy_rank(loc, target, chain) if target else None
    return proxy if proxy is not None else len(chain) + 1
