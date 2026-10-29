"""Build the bundled airport catalogue from OurAirports (Public Domain). Offline once run.

The `distances` tool resolves IATA/ICAO codes and exact airport names in air mode from this file,
without a geocoding request — Pelias resolved "Shanghai Pudong Airport" to a hotel next to it in an early
test. OurAirports releases its data into the Public Domain
(https://ourairports.com/data/); we still record source, retrieval date and checksum, in the file
itself and in ``assets/transport/NOTICE.md`` (docs/DATENHERKUNFT.md has the row).

Kept: large and medium airports with an IATA code — the ones freight flies from. Nothing else is
derived: no routes, no successors, no frequencies.

    cd backend
    curl -sL -o /tmp/airports.csv https://davidmegginson.github.io/ourairports-data/airports.csv
    uv run python scripts/build_airports.py /tmp/airports.csv --retrieved 2026-09-29
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path

SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
OUT = Path(__file__).resolve().parents[1] / "src" / "prism_lca" / "assets" / "transport" / "airports.json"
KEPT_TYPES = {"large_airport", "medium_airport"}


def build(csv_path: Path, retrieved: str) -> dict:
    raw = csv_path.read_bytes()
    rows = list(csv.DictReader(raw.decode("utf-8").splitlines()))
    airports = []
    for r in rows:
        iata = (r.get("iata_code") or "").strip().upper()
        if r.get("type") not in KEPT_TYPES or len(iata) != 3 or not iata.isalpha():
            continue
        try:
            lat = round(float(r["latitude_deg"]), 5)
            lon = round(float(r["longitude_deg"]), 5)
        except (KeyError, ValueError):
            continue
        icao = (r.get("icao_code") or "").strip().upper()
        airports.append(
            [iata, icao if len(icao) == 4 else "", r["name"].strip(), (r.get("municipality") or "").strip(),
             (r.get("iso_country") or "").strip().upper(), lat, lon, 1 if r["type"] == "large_airport" else 0]
        )
    airports.sort(key=lambda a: a[0])
    return {
        "source": "OurAirports",
        "url": SOURCE_URL,
        "licence": "Public Domain (https://ourairports.com/data/)",
        "retrieved": retrieved,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "filter": "type in {large_airport, medium_airport} and a three-letter IATA code",
        "fields": ["iata", "icao", "name", "municipality", "country", "lat", "lon", "large"],
        "airports": airports,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", type=Path, help="airports.csv as downloaded from OurAirports")
    ap.add_argument("--retrieved", required=True, help="download date, YYYY-MM-DD")
    args = ap.parse_args()
    data = build(args.csv, args.retrieved)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(data['airports'])} airports -> {OUT}")


if __name__ == "__main__":
    main()
