"""The search's hard filters: which index rows a search admits, and what the filters kept out of an answer.

A filter is a choice the caller made, and the answer honours it absolutely: activity types, SEVERAL regions,
units. A row outside it is not demoted but absent. That is why the second half of this module exists: a search
that comes back without the dataset the query named, or with nothing at all, has to say whether a filter is the
reason, and which one.

ONE region on its own is not a filter. It is a ranking preference (the region first, then its proxies; see
`ranking.finalize_hybrid`) and stays outside this module: `Filters.geos` is only ever set for two or more.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass


def fold(s: object) -> str:
    """Case and whitespace folded, for exact-name comparisons."""
    return " ".join(str(s or "").lower().split())


@dataclass(frozen=True)
class Filters:
    """The activity types (P/M/G), regions and units a hit must have. An empty set does not filter."""

    types: frozenset[str] = frozenset()
    geos: frozenset[str] = frozenset()
    units: frozenset[str] = frozenset()

    @classmethod
    def of(cls, activity_types: Iterable[str] | None = None, geographies: Iterable[str] | None = None,
           units: Iterable[str] | None = None) -> Filters:
        """From a request's lists. A single geography is left out: it is the ranking's preference, not a filter."""
        geos = list(geographies or ())
        return cls(
            types=frozenset(activity_types or ()),
            geos=frozenset(geos) if len(geos) > 1 else frozenset(),
            units=frozenset(units or ()),
        )

    def __bool__(self) -> bool:
        return bool(self.types or self.geos or self.units)

    def excluded_by(self, meta: dict) -> str | None:
        """Which filter keeps this index row out ("type", "geography" or "unit", asked in that order), or None."""
        if self.types and meta.get("atype") not in self.types:
            return "type"
        if self.geos and (meta.get("geo") or "") not in self.geos:
            return "geography"
        if self.units and (meta.get("unit") or "") not in self.units:
            return "unit"
        return None

    def passes(self, meta: dict) -> bool:
        return self.excluded_by(meta) is None


NO_FILTERS = Filters()


def unit_counts(meta: Iterable[dict]) -> list[dict]:
    """The units an index's rows carry, each with its number of rows, most frequent first (ties by name).

    The count orders the unit filter's suggestions, so kilogram and kilowatt hour lead and the rare ones
    follow; the panel does not show it."""
    counts = Counter(m.get("unit") or "" for m in meta)
    counts.pop("", None)
    return [{"unit": u, "count": n} for u, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def filter_notes(query: str, entries, filters: Filters, hits: list[dict]) -> dict:
    """What the filters kept out of this answer, as the answer's keys; empty when there is nothing to say.

    - ``outside_geography_filter``: a dataset the query names exactly that a region filter hid, or that the
      region preference and the limit pushed out of the list.
    - ``outside_unit_filter``: one that only the unit filter hid. Said apart from the regions, because
      "outranked by the region preference" would be the wrong reason for someone who chose a unit.
    - ``units_not_in_databases``: selected units no searched database has a row in. A selection survives a
      change of the ticked databases, so without this an empty list reads as a bad search.
    """
    # What the list shows, by database, name and product: a collapsed hit stands for all its geo-variants,
    # listed or cut (variants_total says so), so a code comparison would misreport a cut variant. With the
    # database, a hit from one background does not silence the note about the other.
    shown = {(h.get("database"), fold(h.get("name")), fold(h.get("product"))) for h in hits}
    regions, units = [], []
    for name, index in entries:
        region_note, unit_note = _named_but_hidden(query, index.meta, filters, name, shown)
        if region_note:
            regions.append(region_note)
        if unit_note:
            units.append(unit_note)
    out: dict = {}
    if regions:
        out["outside_geography_filter"] = " ".join(regions)
    if units:
        out["outside_unit_filter"] = " ".join(units)
    if filters.units:
        present = {m.get("unit") or "" for _, index in entries for m in index.meta}
        if missing := sorted(filters.units - present):
            out["units_not_in_databases"] = missing
    return out


def _named_but_hidden(
    query: str, meta: list[dict], filters: Filters, db_name: str, shown: set | None = None,
) -> tuple[str | None, str | None]:
    """Datasets the query NAMES exactly that the answer does not show, as (note about regions, note about units).

    Three ways to miss one: a multi-select geography filter excludes its regions; a unit filter excludes its
    unit; or (with one region as a ranking signal, or none) the neighbours of the preferred region outrank it
    and the limit cuts it. Exact on the folded name or reference product (with or without the market prefix),
    deliberately not fuzzy: "tap water", "steel, chromium steel 18/8" and "wastewater, average" each named a
    market exactly and came back without it and without a word (an MCP session). Linear over the index
    metadata: 26 000 rows is a millisecond."""
    wanted = fold(query)
    if not wanted:
        return None, None

    # The datasets a query NAMES: the activity called exactly that, or the market (group) for a product
    # called exactly that. Not every dataset that merely PRODUCES the product: forty "tap water production, …"
    # variants are neighbours, not the thing asked for, and a note about them would fire on every product-word
    # search.
    canonical = {wanted, f"market for {wanted}", f"market group for {wanted}"}
    geos = filters.geos
    elsewhere: dict[str, int] = {}
    in_other_units: dict[str, int] = {}
    for m in meta:
        name = fold(m.get("name"))
        if name not in canonical:
            continue
        if filters.excluded_by(m) == "unit":  # type and region would have let it in
            unit = m.get("unit") or "no unit"
            in_other_units[unit] = in_other_units.get(unit, 0) + 1
            continue
        geo = m.get("geo") or ""
        if geos:
            if geo in geos:
                continue
        elif shown is not None and (db_name, name, fold(m.get("product"))) in shown:
            continue
        elsewhere[geo] = elsewhere.get(geo, 0) + 1
    return _region_note(query, db_name, geos, elsewhere), _unit_note(query, db_name, in_other_units)


def _region_note(query: str, db_name: str, geos: frozenset[str], elsewhere: dict[str, int]) -> str | None:
    if not elsewhere:
        return None
    n = sum(elsewhere.values())
    geo_names = sorted(g for g in elsewhere if g)
    where = ", ".join(geo_names[:8]) + (f" … ({len(geo_names)} regions)" if len(geo_names) > 8 else "")
    if not geos:
        return (
            f"{n} dataset{'s' if n != 1 else ''} named exactly '{query.strip()}' (or its market) "
            f"exist{'s' if n == 1 else ''} in {db_name} ({where}) but {'is' if n == 1 else 'are'} not in this "
            "list — outranked by the region preference or cut by the limit. If that is the dataset you meant, "
            "search its exact name with activity_types=\"M\" or a larger limit, or pass its region in geographies."
        )
    return (
        f"{n} dataset{'s' if n != 1 else ''} named exactly '{query.strip()}' exist{'s' if n == 1 else ''} in "
        f"{db_name} outside the requested geographies ({', '.join(sorted(geos))}): {where}. The filter "
        "hid them. If that is the dataset you meant, search again with one of those locations or "
        "without geographies, and record the geography proxy in the exchange comment."
    )


def _unit_note(query: str, db_name: str, in_other_units: dict[str, int]) -> str | None:
    """Only the search panel sets a unit filter, so this is written for a person, not for the assistant."""
    if not in_other_units:
        return None
    n = sum(in_other_units.values())
    units = ", ".join(sorted(in_other_units))
    return (
        f"{n} dataset{'s' if n != 1 else ''} named exactly '{query.strip()}' (or its market) "
        f"exist{'s' if n == 1 else ''} in {db_name} in {units} — hidden by the unit filter."
    )
