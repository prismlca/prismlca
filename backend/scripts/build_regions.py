"""Build the bundled continent table from the Unicode CLDR (Unicode License v3). Offline once run.

The search's geography chain puts a country's continent before the global proxies: a US search should
reach the North American market before the rest-of-the-world one. Which country lies on which continent
is read from CLDR's ``territoryContainment`` (the UN M49 regions as CLDR publishes them, under a licence
that permits redistribution) — not from any ecoinvent file. Kept: the countries of six regions, nothing
else. Licence text in ``assets/geo/NOTICE.md``; docs/DATENHERKUNFT.md has the row.

    cd backend
    curl -sL -o /tmp/supplementalData.xml \\
        https://raw.githubusercontent.com/unicode-org/cldr/release-48/common/supplemental/supplementalData.xml
    uv run python scripts/build_regions.py /tmp/supplementalData.xml --release release-48 --retrieved 2026-11-06
"""

from __future__ import annotations

import argparse
import hashlib
import json
import xml.etree.ElementTree as ET
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "src" / "prism_lca" / "assets" / "geo" / "regions.json"
#: The M49 regions the table keeps, by code: Africa, Northern America, Latin America and the Caribbean,
#: Asia, Europe, Oceania.
REGIONS = {
    "002": "Africa",
    "021": "Northern America",
    "419": "Latin America and the Caribbean",
    "142": "Asia",
    "150": "Europe",
    "009": "Oceania",
}


def containment(xml_path: Path) -> dict[str, list[str]]:
    """Group code → member codes, deprecated memberships left out."""
    groups: dict[str, list[str]] = {}
    for group in ET.parse(xml_path).getroot().iter("group"):
        if group.get("status") in ("deprecated", "grouping") and group.get("type") != "419":
            continue
        groups.setdefault(group.get("type", ""), []).extend((group.get("contains") or "").split())
    return groups


def countries(code: str, groups: dict[str, list[str]]) -> set[str]:
    """The two-letter territories inside a region, through its sub-regions."""
    out: set[str] = set()
    for member in groups.get(code, []):
        if member.isdigit():
            out |= countries(member, groups)
        elif len(member) == 2 and member.isalpha() and member not in ("QO", "EU", "EZ", "UN"):
            out.add(member)
    return out


def build(xml_path: Path, release: str, retrieved: str) -> dict:
    groups = containment(xml_path)
    return {
        "source": f"Unicode CLDR {release}, common/supplemental/supplementalData.xml (territoryContainment)",
        "licence": "Unicode License v3 — see NOTICE.md",
        "retrieved": retrieved,
        "sha256": hashlib.sha256(xml_path.read_bytes()).hexdigest(),
        "regions": {
            code: {"name": name, "countries": sorted(countries(code, groups))} for code, name in REGIONS.items()
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("xml", type=Path)
    ap.add_argument("--release", required=True, help="the CLDR release tag the file came from")
    ap.add_argument("--retrieved", required=True, help="date of the download, YYYY-MM-DD")
    args = ap.parse_args()
    data = build(args.xml, args.release, args.retrieved)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    sizes = {code: len(r["countries"]) for code, r in data["regions"].items()}
    print(f"wrote {OUT} — countries per region: {sizes}")


if __name__ == "__main__":
    main()
