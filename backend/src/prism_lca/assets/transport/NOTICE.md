# Transport catalogues

Data files that ship with PrismLCA for the distance lookups. Provenance for every foreign source,
including the ones read at runtime from installed packages, is kept in `docs/DATENHERKUNFT.md`.

| File | Source | Licence | Retrieved | Checksum of the source file |
|---|---|---|---|---|
| `airports.json` | OurAirports, `airports.csv` (<https://davidmegginson.github.io/ourairports-data/airports.csv>) — large and medium airports with an IATA code; fields: IATA, ICAO, name, municipality, country, latitude, longitude, large | Public Domain (<https://ourairports.com/data/>) | 2026-09-29 | SHA-256 `e5b485bd1453002071231563dcc54fbf1efacb7c3cbaa486c73247b3aa1b2398` |

Rebuild with `backend/scripts/build_airports.py` (see its docstring). The file holds reference data
only — no routes, schedules or frequencies.

Sea ports are **not** copied here: they are read at runtime, unmodified, from the port list inside the
`searoute` package (Apache-2.0), whose own origin upstream does not document.
