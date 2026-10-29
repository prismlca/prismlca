"""Search endpoints: build the index and query activities."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from prism_lca import _log
from prism_lca.api.v1.deps import require_token
from prism_lca.engine import geography_names
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError
from prism_lca.search.indexer import classify_type

router = APIRouter(prefix="/search", tags=["search"], dependencies=[Depends(require_token)])

_VALID_TYPES = {"P", "M", "G"}


class IndexRequest(BaseModel):
    database: str = "ecoinvent-3.12-cutoff"


class SearchRequest(BaseModel):
    query: str
    database: str = "ecoinvent-3.12-cutoff"
    #: Several at once — the search panel offers ecoinvent and the project's library as checkboxes.
    #: Empty falls back to `database`, so every existing caller keeps working unchanged.
    databases: list[str] | None = None
    activity_types: list[str] | None = None  # any of P / M / G (empty = all)
    geographies: list[str] | None = None  # region filter, multi-select (empty = all)
    collapse_geo: bool = True  # group geo-variants of one activity into a single result
    #: Hits for ONE background database. The backend multiplies it by how many of the searched
    #: databases are not the user's library, so ticking a second background lengthens the list
    #: instead of making both share the old one.
    limit: int = 50
    #: Ceiling for that growth, set by the caller because only it knows what a row costs: the
    #: search panel scales to 150, a single model query to 40, a batched one to 16.
    limit_cap: int | None = None
    #: Slots guaranteed to each searched database, so a small one stays visible. Clamped so the
    #: reserves can never fill the whole answer.
    reserve: int = 3
    #: How many geo-variants a collapsed hit lists; None = the assistant's cap, 0 = all of them (UI).
    variants_cap: int | None = None
    #: Search only the text as typed: no spelled-out variant for an abbreviation ("PET" → polyethylene
    #: terephthalate). The panel's "Search only for …" link and the assistant's `literal`.
    literal: bool = False


# (database, code) -> reference-product amount. The sign of that amount decides whether an exchange
# supplying this activity must be positive or negative, so it belongs in the search result rather than
# behind a per-candidate detail call: getting it wrong turns a disposal burden into a phantom credit,
# and a name like "market for waste glass" does not reveal which case it is.
#
# Valid for one project and one model generation, checked on read. A project switch changes what a
# (database, code) pair means, and a library re-import or an edited production amount changes the
# sign under the same pair — a cache that outlived either kept telling the assistant the old sign.
# Stamping it here means no writer has to remember this cache exists.
_REF_SIGN_CACHE: dict[tuple[str, str], float] = {}
_REF_SIGN_STAMP: tuple[str, int] | None = None


def _ref_sign_cache(bd) -> dict[tuple[str, str], float]:
    global _REF_SIGN_STAMP
    from prism_lca.engine import lca

    stamp = (str(bd.projects.current), lca.model_generation())
    if stamp != _REF_SIGN_STAMP:
        _REF_SIGN_CACHE.clear()
        _REF_SIGN_STAMP = stamp
    return _REF_SIGN_CACHE


def _reference_amount(bd, database: str, code: str) -> float | None:
    cache = _ref_sign_cache(bd)
    cached = cache.get((database, code))
    if cached is not None:
        return cached
    try:
        act = bd.get_node(database=database, code=code)
        for ex in act.production():
            amt = float(ex["amount"])
            if amt != 0.0:
                cache[(database, code)] = amt
                return amt
    except Exception as exc:  # noqa: BLE001 - a hit we cannot resolve simply carries no sign
        _log.swallowed(exc, "_reference_amount")
        return None
    return None


#: How many suppliers of a market are named in a search hit. Enough to see whether a market is one
#: technology or a real mix, few enough that a ten-query batch does not drown the answer.
_TOP_SUPPLIERS = 4


def _market_suppliers(bd, database: str, code: str, product: str, unit: str) -> list[dict] | None:
    """The biggest datasets a MARKET buys its own product from, largest share first.

    Why it belongs on the hit and not behind a detail call: choosing between "market for X [GLO]" and
    a regional dataset is a decision made while reading search results, and the composition is what
    decides it. In one run the assistant took four GLO markets without ever looking at
    what they mix (≈ 3 % of the result), and checked exactly the one a reviewer pointed at — where it
    found a third of the "glycerine" market coming from a petrochemical route and rebuilt the model
    around it. The information was always reachable; it was one call too late to matter.

    Only same-product inputs count. A market also buys transport, and by share the lorry beats the
    small suppliers: for `market for glycerine [RER]` it would have pushed a real 2 % feedstock out of
    the top three. Matching on the reference product does that precisely, with the unit as the
    fallback for datasets that do not declare one.
    """
    try:
        act = bd.get_node(database=database, code=code)
        rows: list[dict] = []
        for ex in act.technosphere():
            amount = float(ex["amount"] or 0)
            if amount <= 0:
                continue
            inp = ex.input
            in_product = (inp.get("reference product") or "").strip()
            in_unit = (inp.get("unit") or "").strip()
            same = in_product.casefold() == product.casefold() if (in_product and product) else in_unit == unit
            if not same:
                continue
            rows.append(
                {
                    "name": inp.get("name") or "",
                    "location": inp.get("location") or "",
                    "share": amount,
                    "code": inp.key[1],
                }
            )
    except Exception as exc:  # noqa: BLE001 - a hit we cannot resolve simply carries no composition
        _log.swallowed(exc, "_market_suppliers")
        return None
    if len(rows) < 2:
        return None  # a single supplier is not a "mix" worth spending tokens on
    rows.sort(key=lambda r: -r["share"])
    return [{**r, "share": round(r["share"], 4)} for r in rows[:_TOP_SUPPLIERS]]


#: Said once per answer, not once per market hit. It is 201 characters of identical text, and a
#: ten-query batch of sixteen hits repeated it up to eighty times — 16 000 characters explaining
#: the same thing, in an answer that was already being cut for space.
SUPPLIERS_NOTE = (
    "Each market hit's \"suppliers\" list is what that market actually mixes, biggest share first "
    "(same product only — its transport is left out). A GLO market is an average, not a global "
    "dataset: check this before using one for a regional study."
)


def _annotate_reference_sign(hits: list[dict]) -> bool:
    """Add ``treatment`` (negative reference product) to each hit, in place.

    Returns whether any hit came back with suppliers, so the caller can say once what they are."""
    from prism_lca.engine.bootstrap import get_bd

    try:
        bd = get_bd()
    except Exception as exc:  # noqa: BLE001 - no project open, nothing to annotate
        _log.swallowed(exc, "_annotate_reference_sign")
        return
    any_suppliers = False
    for h in hits:
        code, db = h.get("code"), h.get("database")
        if not code or not db:
            continue
        amt = _reference_amount(bd, db, code)
        if amt is None:
            continue
        h["treatment"] = amt < 0
        if amt < 0:
            # Spelled out only for the case that needs the warning; a positive reference product is
            # the ordinary one and needs no prose.
            h["sign_hint"] = "negative reference product — supply it with a NEGATIVE amount"
        # Markets and market groups only: a production dataset has no composition to show.
        if h.get("activity_type") in {"M", "G"}:
            suppliers = _market_suppliers(bd, db, code, h.get("product") or "", h.get("unit") or "")
            if suppliers:
                h["suppliers"] = suppliers
                any_suppliers = True
    return any_suppliers


def _status_dict(builds) -> dict:
    st = builds.status()
    return {
        "state": st.state.value,
        "database": st.database,
        "detail": st.detail,
        "count": st.count,
        "total": st.total,
        #: Databases whose build waits behind the running one, in turn order.
        "queued": builds.queued(),
    }


@router.post("/index", summary="Build the search index for a database")
def build_index(request: Request, body: IndexRequest) -> dict:
    builds = request.app.state.search.builds
    builds.build(body.database)
    return _status_dict(builds)


@router.get("/status", summary="Index build status")
def index_status(request: Request) -> dict:
    return _status_dict(request.app.state.search.builds)


@router.get("/index-info", summary="Does a database have a (fresh) search index?")
def index_info(request: Request, database: str) -> dict:
    return request.app.state.search.index_info(database)


@router.get("/geographies/{database}", summary="Distinct regions in a database (for filtering)")
def geographies(request: Request, database: str) -> list[str]:
    return request.app.state.search.geographies(database)


@router.get("/geography-names", summary="Names of the location codes, from the workspace's own release")
def geography_name_map() -> dict:
    """``{"names": {code: name}}`` — read from the user's ecoinvent release (engine/geography_names.py);
    empty in a workspace without ecoinvent, where the frontend falls back to ICU country names."""
    return {"names": geography_names.load()}


@router.get("/list", summary="Every dataset in a database, no query")
def list_datasets(request: Request, database: str, limit: int = 500) -> dict:
    """The whole contents of a database, in the shape a search result has.

    For the library: "what have I actually got in there" is a question with no search term, and
    answering it by making somebody invent one is how a library stays unused. Read straight from
    Brightway rather than from the index, so it also answers before the first index is built.

    Not offered for ecoinvent — 26 533 rows is not a list anybody reads, and the caller decides
    which databases get the affordance.
    """
    bd = get_bd()
    if database not in bd.databases:
        raise PrismError(
            f"Database '{database}' not found in the active workspace.",
            code="database_not_found",
            status_code=404,
        )
    rows = []
    for act in bd.Database(database):
        rows.append(
            {
                "code": act.get("code"),
                "name": act.get("name") or "",
                "geography": act.get("location"),
                "product": act.get("reference product") or act.get("reference_product"),
                "unit": act.get("unit"),
                "activity_type": classify_type(act.get("name") or ""),
                # No query, so no similarity — and no `weak` flag either: nothing was matched, so
                # calling anything a weak match would be inventing a judgement.
                "score": 0.0,
                "weak": False,
                "database": database,
            }
        )
    rows.sort(key=lambda r: (r["name"] or "").lower())
    total = len(rows)
    hits = rows[: max(1, min(limit, 2000))]
    out = {"database": database, "count": len(hits), "total": total, "hits": hits}
    if _annotate_reference_sign(hits):
        out["suppliers_note"] = SUPPLIERS_NOTE
    return out


@router.post("/activities", summary="Semantic + facet search over a database")
def search_activities(request: Request, body: SearchRequest) -> dict:
    bad = [t for t in (body.activity_types or []) if t not in _VALID_TYPES]
    if bad:
        raise PrismError(
            f"Invalid activity type(s): {bad}.",
            code="invalid_activity_type",
            hint="Use 'P' (production), 'M' (market) and/or 'G' (market group).",
        )
    limit = max(1, min(body.limit, 150))
    result = request.app.state.search.search_many(
        body.query,
        body.databases or [body.database],
        activity_types=body.activity_types,
        geographies=body.geographies,
        collapse_geo=body.collapse_geo,
        limit=limit,
        limit_cap=max(1, min(body.limit_cap, 150)) if body.limit_cap else None,
        reserve=max(0, body.reserve),
        variants_cap=body.variants_cap,
        literal=body.literal,
    )
    hits = result.get("hits")
    if isinstance(hits, list) and _annotate_reference_sign(hits):
        result["suppliers_note"] = SUPPLIERS_NOTE
    return result
