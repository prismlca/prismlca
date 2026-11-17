"""Folding an activity's regional variants into one hit: which variants belong together, which one stands for
them, and which others the hit lists.

ecoinvent holds many activities once per region — its electricity markets in 175 — and a search that listed
each region as its own row would show one activity over and over. A collapsed hit carries one variant as its
own code and geography (the representative) and the others under ``variants``.

The representative is a CHOICE, not whatever scored best. The variants of one activity share its name and
reference product, so they score almost alike and the best of them is close to random: a search for the
medium-voltage electricity market showed US-NPCC first and offered AE and AL beside it, and the model found
the German market only in a market group's supplier list. So the representative is the variant nearest to the
regions the caller prefers — the region it asked for, else the study's — along the same proxy chain the
ranking uses (search/geography.py); with no region at all it is the global or European aggregate, as most
users model for a European market. Only when no variant stands in for any of them does the best-scored one
represent the activity, as before. The choice never moves a hit in the list: the group keeps the place its
best-scored variant earned.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable

from prism_lca import _log
from prism_lca.search.geography import preference
from prism_lca.search.index import VectorIndex

#: How many geo-variants a collapsed hit carries when nothing narrowed the request. Enough to see
#: that a dataset is regionalised and to recognise the usual suspects (GLO, RoW, RER, a country or
#: two); far short of the 175 that ecoinvent's electricity markets would otherwise inline. Ask with
#: a `geographies` filter to get exactly the ones you want — that path is not capped (V235).
VARIANTS_SHOWN = 12

#: Which regions represent a hit and lead its capped variant list when the caller prefers none. The
#: order is the proxy order a practitioner would try: GLO is a real global average, RER and its
#: without-Switzerland sibling are the European aggregates, and RoW is a RESIDUAL — whatever is
#: left after the modelled regions — so it is the weakest of the four and comes last.
#:
#: There used to be no order at all: the representative first, then whatever sequence the
#: index happened to hold. That is why "market for electricity, medium voltage" could show twelve
#: of its 175 regions without Germany among them (V347) — twelve arbitrary ones say much less than
#: three chosen ones.
DEFAULT_VARIANT_ORDER = ("GLO", "RER", "Europe without Switzerland", "RoW")

RegionKey = Callable[[str | None], tuple[int, int]]


def activity(m: dict) -> tuple:
    """What makes geo-variants one activity: name, reference product, type — and unit. The unit is the
    same in every region of an ecoinvent or BAFU product; a library may differ, and a variant picked in
    another unit than the hit shows would carry the wrong unit into the model."""
    return m.get("name"), m.get("product"), m.get("atype"), m.get("unit")


def variants_map(index: VectorIndex, db_name: str) -> dict[tuple, list[dict]]:
    """Map each activity (see `activity`) → ALL of its geo-variants in the database.

    Built from the full index (not just the ranked pool), so a collapsed result lists every
    region the activity exists in — not only the handful that scored into the top results."""
    cached = getattr(index, "_prism_variants", None)
    if cached is not None:
        return cached
    m: dict[tuple, list[dict]] = {}
    for e in index.meta:
        m.setdefault(activity(e), []).append(
            {
                "code": e.get("code"),
                "geography": e.get("geo"),
                "database": e.get("database", db_name),
            }
        )
    try:
        index._prism_variants = m  # memoise on the index (replaced on reindex)
    except Exception as exc:  # pragma: no cover - slotted index → recompute next time
        _log.swallowed(exc, "variants_map")
    return m


def forget_variants(index: VectorIndex) -> None:
    """Drop the memoised geo-variant map after the index's rows changed.

    It is built once from the whole index and then kept on it. Without this, a dataset imported
    into the library is missing its region from every collapsed hit until a restart, and one
    that was deleted stays selectable in the variant list.
    """
    try:
        del index._prism_variants
    except AttributeError:
        pass


def region_key(prefer: Iterable[str] = ()) -> RegionKey:
    """How well a region suits the caller: the proxy chain of the preferred regions (:func:`preference`), or
    :data:`DEFAULT_VARIANT_ORDER` when there are none. Lower is better; regions outside both tie."""
    wanted = [g for g in prefer if g]
    if wanted:
        return preference(wanted)

    def default(geo: str | None) -> tuple[int, int]:
        order = DEFAULT_VARIANT_ORDER
        return (order.index(geo), 0) if geo in order else (len(order), 0)

    return default


def representative(variants: list[dict], best_code, region: RegionKey) -> dict | None:
    """The variant that stands for the activity: the best-suited region, and among equally suited ones the
    best-scored variant (``best_code``) — so a hit whose regions all lie outside every preference keeps the
    representative it always had."""
    if not variants:
        return None
    return min(variants, key=lambda v: (region(v.get("geography")), v.get("code") != best_code))


def order_variants(variants: list[dict], rep_code, region: RegionKey) -> list[dict]:
    """Representative first, then the regions most likely to be usable as a proxy (``region``), then
    everything else alphabetically, so the same search twice gives the same list."""
    return sorted(
        variants,
        key=lambda v: (v.get("code") != rep_code, region(v.get("geography")), v.get("geography") or ""),
    )


def collapse_hits(
    ranked: list[dict], indices: dict[str, VectorIndex], limit: int,
    geos: set | None = None, variants_cap: int | None = None, prefer: Iterable[str] = (),
) -> list[dict]:
    """Collapse geo-variants of the same activity into one result carrying its geographies, so
    the list isn't flooded with one process repeated per region; ``limit`` groups kept, each in the
    place its best-ranked variant earned. Which variant represents the group is :func:`representative`'s
    choice against ``prefer`` (the module docstring says why).

    The group key carries the DATABASE. Two databases can hold an activity of the same name and
    reference product — ecoinvent and BAFU both have electricity markets — and they are not the
    same dataset: collapsing them together would produce one hit whose listed regions came from
    two different inventories, and picking one of those regions would silently cross databases.

    The list is **capped**, and that cap is the point. ecoinvent's electricity markets exist in
    175 regions; unrolled inline, a single hit for "market for electricity, medium voltage"
    weighs 17,846 characters — more than an eight-query batch's whole budget, so the rest of the
    answer is truncated away before the second hit begins. That is what happened on a
    real run, and the assistant then mis-transcribed a 32-character code out of the wall
    of them (V235). A filtered request still gets every variant it asked for: the cap applies to
    what nobody narrowed. ``variants_total`` says what was left out, so a caller that needs the
    rest knows there is a rest to ask for.
    """
    # The cap protects the assistant's context (see above). The search panel is read by a person
    # who picks one region from a list, so it asks for the whole list (`variants_cap=0`): with the
    # cap, "market for electricity, medium voltage" offered 12 of its 175 regions and Germany was
    # not among them (V347).
    cap = VARIANTS_SHOWN if variants_cap is None else max(0, int(variants_cap))
    region = region_key(prefer)
    groups: dict[tuple, dict] = {}
    order: list[tuple] = []
    for h in ranked:
        db_name = str(h.get("database") or "")
        key = (db_name, *activity(h))
        if key in groups:
            continue
        index = indices.get(db_name)
        vmap = variants_map(index, db_name) if index is not None else {}
        variants = vmap.get(activity(h)) or [
            {"code": h.get("code"), "geography": h.get("geo"), "database": db_name}
        ]
        if geos:  # a region filter narrows the offered variants to the chosen regions
            variants = [v for v in variants if v.get("geography") in geos]
        rep = representative(variants, h.get("code"), region)
        if rep is not None and rep.get("code") != h.get("code"):
            # Name, product, type and unit are the group's own; only the code and the region change hands.
            h = {**h, "code": rep.get("code"), "geo": rep.get("geography")}
        total = len(variants)
        variants = order_variants(variants, h.get("code"), region)
        if not geos and cap and total > cap:
            variants = variants[:cap]
        groups[key] = {**h, "variants": variants, "variants_total": total}
        order.append(key)
    return [groups[k] for k in order[:limit]]
