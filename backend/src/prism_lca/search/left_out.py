"""What an assistant's search answer leaves out: similar datasets beyond its limit, and the best ones outside its region.

An answer is a cut list, and the cut cannot be seen from inside it. With a region it is also a slanted one:
`ranking.finalize_hybrid` sorts every hit in the region ahead of every hit outside it, so a small limit fills up
with poor regional neighbours while the dataset the query meant sits one region over. Four runs read such a list
as "the database has no dataset for this" and built on a proxy; one of them moved its result by 15 %.

Two answers to that, computed only when the caller asks for them (``beyond_limit``: the assistant's tool does,
the search panel does not — a person scrolls on and picks):

- ``more``: how many further activities in the candidate pool resemble the query — at or above the
  `WEAK_TRIGGER` the per-hit ``weak`` flag uses, counted as activities rather than regional variants, the shown
  and listed ones left out. A lower bound, because the pool is one. It says nothing about whether any of them
  fits: textual similarity is not suitability.
- ``outside_region``: with a region, the best `OUTSIDE_SHOWN` activities that have no variant in it, in the
  order the search gives them without the region preference. Always, not only when they score higher — a
  higher similarity is no verdict on the material either; these rows only make sure the reader can judge.

ONE region is a ranking preference, so the pool already holds the rows outside it. Two or more are a hard
filter that kept everything else out of the pool; the outside rows then come from a second pass in which only
the geography is lifted (``wider``).
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass

from prism_lca.search.facets import Filters
from prism_lca.search.ranking import TYPE_BOOST, WEAK_TRIGGER

#: Activities listed under ``outside_region``: enough to show that something lies outside, few enough that a
#: six-query batch still fits its result budget.
OUTSIDE_SHOWN = 2


def region_label(geographies: Iterable[str] | None) -> str:
    """The requested region(s) as the answer names them: ``RER``, or ``DE/RER`` for several, in request order."""
    return "/".join(dict.fromkeys(str(g) for g in geographies or () if g))


@dataclass(frozen=True)
class Elsewhere:
    """Admits what ``base`` and ``admit`` admit, in any region but ``regions`` — the filter of the outside pass.

    Shaped like `facets.Filters` where the candidate search reads it (truth value and ``passes``), so the pass
    runs on the whole corpus and an eligible dataset surfaces however the rest ranks. ``admit`` is what keeps
    the pass from filling up with the regional twins of activities already shown: ecoinvent's markets exist in
    up to 175 regions, and a pool cut BEFORE they were thrown out could hold nothing else."""

    base: Filters
    regions: frozenset[str]
    admit: Callable[[dict], bool] = lambda meta: True

    def __bool__(self) -> bool:
        return True

    def passes(self, meta: dict) -> bool:
        return self.base.passes(meta) and (meta.get("geo") or "") not in self.regions and self.admit(meta)


def _unpreferred(row: dict) -> float:
    """The ranking's score without the region preference — `finalize_hybrid`'s ``final`` (the dense score when
    hybrid search is off)."""
    return float(row.get("fused", row.get("dense", 0.0))) * TYPE_BOOST.get(row.get("atype"), 1.0)


def _compact(row: dict) -> dict:
    """An ``outside_region`` row: enough to recognise the dataset and link it, no variant or supplier lists."""
    return {
        "name": row.get("name"),
        "geography": row.get("geo"),
        "code": row.get("code"),
        "database": row.get("database"),
        "product": row.get("product"),
        "unit": row.get("unit"),
        "score": round(float(row.get("dense", 0.0)), 4),
    }


def report(
    candidates: list[dict],
    shown: list[dict],
    *,
    filters: Filters,
    geographies: Iterable[str] | None,
    activity: Callable[[dict], tuple],
    variants: Callable[[str], dict],
    wider: Callable[[Elsewhere], list[dict]],
) -> dict:
    """``more``, ``outside_region`` and ``outside_region_note`` for an answer, each only when there is something to say.

    ``candidates`` is the pool the answer was ranked from, ``shown`` what it carries (reserved rows included —
    they are in the answer too). ``activity`` is the collapse's identity of a row and ``variants(db)`` maps it
    to the activity's regional variants in that database, so "in the region" means the ACTIVITY exists there,
    not merely this row: a region hit the limit cut is counted as one, never offered as an outside hit.

    ``wider`` runs the search again over the whole corpus with an `Elsewhere` filter that admits only
    eligible rows. A hard region filter always needs it; one region needs it when the pool held fewer than
    `OUTSIDE_SHOWN` eligible activities — the pool was cut for the regional list, not for this one. The outside
    rows then come from that pass alone: its fused scores are ranks within ITS lists and do not compare with
    the pool's.
    """
    regions = frozenset(str(g) for g in geographies or () if g)
    label = region_label(geographies)

    def key(row: dict) -> tuple:
        return (str(row.get("database") or ""), *activity(row))

    seen = {key(h) for h in shown}
    inside_cache: dict[tuple, bool] = {}

    def inside(row: dict, k: tuple) -> bool:
        if not regions:
            return False
        if k not in inside_cache:
            listed = variants(k[0]).get(activity(row)) or [{"geography": row.get("geo")}]
            inside_cache[k] = any((v.get("geography") or "") in regions for v in listed)
        return inside_cache[k]

    def eligible(meta: dict) -> bool:
        k = key(meta)
        return k not in seen and not inside(meta, k)

    similar_in: set[tuple] = set()
    similar_out: set[tuple] = set()
    best: dict[tuple, dict] = {}

    def consider(rows: list[dict]) -> None:
        for row in rows:
            k = key(row)
            if k in seen:
                continue
            similar = float(row.get("dense", 0.0)) >= WEAK_TRIGGER
            if inside(row, k):
                if similar:
                    similar_in.add(k)
                continue
            if similar:
                similar_out.add(k)
            if regions and (k not in best or _unpreferred(row) > _unpreferred(best[k])):
                best[k] = row

    outside_only = Elsewhere(Filters(types=filters.types, units=filters.units), regions, eligible)
    hard = bool(regions and filters.geos)  # nothing outside a hard filter reached the pool
    consider([*candidates, *(wider(outside_only) if hard else ())])
    if regions and not hard and len(best) < OUTSIDE_SHOWN:
        best.clear()
        consider(wider(outside_only))

    picked = sorted(best.values(), key=lambda r: (-_unpreferred(r), str(r.get("code") or "")))[:OUTSIDE_SHOWN]
    similar_out -= {key(r) for r in picked}

    out: dict = {}
    parts: list[str] = []
    if similar_in:
        parts.append(f"{len(similar_in)}+ similar in {label}")
    if similar_out:
        parts.append(
            f"{len(similar_out)}+ outside" if similar_in
            else f"{len(similar_out)}+ similar outside {label}" if regions
            else f"{len(similar_out)}+ similar"
        )
    if parts:
        out["more"] = ", ".join(parts)
    if picked:
        out["outside_region"] = [_compact(r) for r in picked]
        many = "The" if len(picked) == 1 else str(len(picked))
        out["outside_region_note"] = f"{many} best outside {label}; more may exist."
    return out
