"""LCIA calculation and contribution analysis (bw2calc).

The contribution tree uses the compact ``meta + lookups + tree`` envelope ported from the
ecoinvent-bw MCP server: short field names, names carried on the node, one factorized LCA
reused via ``redo_lcia`` for every node (LCA linearity: impact(a, x) = x · impact(a, 1)).
"""
from __future__ import annotations

import logging
import math
import threading
from collections import OrderedDict

from prism_lca import _log
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.method_lookup import none_resolved, resolve_method, resolve_methods
from prism_lca.engine.model import get_activity
from prism_lca.engine.phase_attribution import NOISE_SHARE
from prism_lca.errors import PrismError

_fallback_warned = False


def _warn_scipy_fallback(exc: BaseException) -> None:
    """Say it once, loudly: without pypardiso every inventory solve runs on SciPy's SuperLU, which
    is several times slower on a full ecoinvent. The PyInstaller bundle once lacked the
    MKL libraries and nobody noticed, because this branch was silent."""
    global _fallback_warned
    if _fallback_warned:
        return
    _fallback_warned = True
    logging.getLogger("prism_lca.engine.lca").warning(
        "pypardiso unavailable (%s: %s) — falling back to SciPy SuperLU for inventory solves",
        type(exc).__name__,
        exc,
    )


def _sig(x: float, n: int = 6) -> float | None:
    """Round to n significant figures (not decimal places). ``round(x, 6)`` collapses tiny
    magnitudes such as ozone-depletion scores (~1e-8) to 0.0, leaving charts empty; significant
    figures preserve them while still trimming the payload.

    NaN/Inf become ``None`` (JSON null): ``json.dumps`` would otherwise emit literal ``NaN``,
    which is invalid JSON — and rendering a meaningless number as 0 would be a lie."""
    if not isinstance(x, (int, float)) or x == 0:
        return 0.0 if x == 0 else x
    if not math.isfinite(x):
        return None
    return float(f"{x:.{n}g}")


# --- treatment activities (negative reference flow) --------------------------
# ecoinvent models waste/wastewater treatment with a production exchange of −1 (waste-as-input
# convention; ~17 % of all datasets: "treatment of …", "market for … waste"). A naive demand of
# {act: +1} would run such a process "backwards" (scaling factor −1) and sign-flip every result.
# All calculation paths therefore normalise the demand sign — amount=1 means "treat 1 unit" —
# and tree descents convert product-flow amounts into activity runs via amount/production.


def _production_amount(act) -> float:
    """Amount of the reference-product exchange (negative for treatment activities).
    First non-zero production exchange; 1.0 when the activity has none."""
    try:
        for ex in act.production():
            amt = float(ex["amount"])
            if amt != 0.0:
                return amt
    except Exception as exc:  # pragma: no cover - defensive against odd datasets
        _log.swallowed(exc, "_production_amount")
    return 1.0


def _demand_sign(act) -> float:
    """−1 for treatment activities (negative reference flow), else +1. A GLOBAL demand factor:
    relative signs inside the model (true credits/removals) are untouched."""
    return -1.0 if _production_amount(act) < 0 else 1.0


def _LCA():
    from bw2calc import LCA

    return LCA


# --- factorised-LCA cache --------------------------------------------------
# Building + factorising the technosphere is the expensive step (~seconds) and depends ONLY on the
# set of databases — not on the demand or the LCIA method. So we cache one factorised LCA per
# database-set and reuse it for every solve: a different demand via lca.lcia(demand=...) (fast
# back-substitution), a different method via lca.switch_method(...) (rebuilds only the cheap
# characterisation matrix). This makes multi-indicator, multi-subject results pages cheap — one
# factorisation feeds them all. The object is stateful, so callers hold _LCA_LOCK for the whole
# computation; the cache is dropped on any model/parameter change (see invalidate_lca_cache).
_LCA_CACHE: OrderedDict[tuple, dict] = OrderedDict()
_LCA_CACHE_MAX = 4
_LCA_LOCK = threading.RLock()
# Logical-invalidation generation: entries record the generation they were built under and are
# ignored once it moves on. Bumping an int is atomic under the GIL, so invalidation never has to
# wait on _LCA_LOCK (a mutation on the event loop must not block behind a long traversal in the
# threadpool) — and an entry built from pre-mutation matrices that lands *after* the bump is
# stamped with the old generation, so it can never be served as fresh.
_CACHE_GEN = 0
# The MODEL generation: what the user's model actually is, as opposed to what the matrices
# currently hold. A scenario compute applies parameter overrides, solves, and restores the baseline
# under _LCA_LOCK — the factorisation caches MUST drop twice for that (the matrices really change),
# but the model afterwards is bit-for-bit what it was before. Keying long-lived caches on _CACHE_GEN
# made every such window a permanent invalidation: on a report comparing two scenarios, every data
# snapshot bumped the counter ≥4 while being built, so the NEXT build could never hit — every brief,
# gate and staleness check paid the full ~100 s recompute, serialised on the LCA lock. That is where
# a 48-minute "Write all" went (V131). Model-state consumers key on this one instead.
_MODEL_GEN = 0


def get_lca(demand: dict, method: tuple):
    """Factorised LCA for the current databases, set to `demand` and `method`. Hold _LCA_LOCK."""
    m = tuple(method)
    bd = get_bd()
    gen = _CACHE_GEN  # capture before building; see _CACHE_GEN comment
    # Key by PROJECT + database names. Database names alone collide across projects (both can
    # hold 'biosphere3' + the same ecoinvent), and activity ids are per-project autoincrements —
    # so a project switch would silently reuse the other project's factorised technosphere and
    # return numerically-plausible but wrong scores.
    key = (str(bd.projects.current), frozenset(bd.databases))
    entry = _LCA_CACHE.get(key)
    if entry is not None:
        lca = entry["lca"]
        try:
            # Reuse only if still the current generation and the demand's nodes exist in the
            # cached technosphere; else it's stale.
            if entry["gen"] == _CACHE_GEN and all(nid in lca.dicts.activity for nid in demand):
                _LCA_CACHE.move_to_end(key)
                if entry["method"] != m:
                    lca.switch_method(m)  # rebuild characterisation only; keep the factorisation
                    entry["method"] = m
                lca.lcia(demand=demand)
                return lca
        except Exception as exc:  # pragma: no cover - defensive: treat as stale
            _log.swallowed(exc, "get_lca")
        # Don't pop the (possibly still hot) entry here: build the replacement first — the
        # assignment below overwrites it only once the rebuild has actually succeeded.
    lca = _LCA()(demand, method=m)
    lca.lci()   # build + factorise the technosphere (the expensive part)
    lca.lcia()  # build the characterisation matrix + first score
    _LCA_CACHE[key] = {"lca": lca, "method": m, "gen": gen}
    while len(_LCA_CACHE) > _LCA_CACHE_MAX:
        _LCA_CACHE.popitem(last=False)
    return lca


def _adjoint_unit_impacts(lca, cf_by_method: list[tuple]):
    """Cumulative LCIA score of ONE unit of EVERY activity, per method — via a single
    TRANSPOSED solve per method instead of one forward solve per visited tree node
    (adjoint trick: uᵀ = cf·B·A⁻¹  ⇔  Aᵀu = Bᵀ·cfᵀ). This is what makes contribution
    trees and stacked bars fast: the traversal afterwards is pure array lookups.

    ``cf_by_method``: [(method_tuple, cf_vector)] with cf aligned to the biosphere rows.
    Returns an (n_activities × n_methods) ndarray in the given method order. Solved columns
    are cached on the lca object itself, so they live and die with the factorisation cache.
    """
    import numpy as np

    cache = getattr(lca, "_prism_adjoint", None)
    if cache is None:
        cache = {}
        lca._prism_adjoint = cache
    missing = [(m, cf) for m, cf in cf_by_method if m not in cache]
    if missing:
        rhs = np.column_stack([lca.biosphere_matrix.T.dot(np.asarray(cf).ravel()) for _, cf in missing])
        try:
            from pypardiso import ps as pypardiso_solver  # the instance bw2calc's spsolve uses

            # Aᵀ as CSC is A's CSR arrays under another name, so pardiso solves the transposed system
            # with the factorisation the forward solves already hold. Handed `A.T.tocsr()`, the solver
            # (which keeps ONE factorisation) factorised Aᵀ, and the next forward solve factorised A
            # again — about a second each on ecoinvent, twice per indicator of every breakdown.
            technosphere = lca.technosphere_matrix
            # Sorted on A itself first: the solver sorts an unsorted matrix in place, and on the view
            # that would reorder A's values under indices SciPy may have copied (it narrows int64 ones).
            if not technosphere.has_sorted_indices:
                technosphere.sort_indices()
            transposed = technosphere.T
            if not pypardiso_solver._is_already_factorized(transposed):
                # Through `factorize`, never a bare solve: only `factorize` records which matrix
                # the factors belong to, and a stale record would serve them for the wrong matrix.
                pypardiso_solver.factorize(transposed)
            u = np.asarray(pypardiso_solver.solve(transposed, rhs))
        except ImportError as exc:  # pragma: no cover - the bundle ships MKL (prism_backend.spec)
            _warn_scipy_fallback(exc)
            from scipy.sparse.linalg import splu

            u = np.asarray(splu(lca.technosphere_matrix.tocsc()).solve(rhs, trans="T"))
        # Solvers squeeze: a 1×1 system with one method comes back as a 0-d scalar, which no
        # `ndim` fix-up can index (a fresh one-process model). The shape is known —
        # activities × methods — so state it instead of guessing from what came back.
        u = u.reshape(lca.technosphere_matrix.shape[0], len(missing))
        for j, (m, _) in enumerate(missing):
            cache[m] = u[:, j]
    return np.column_stack([cache[m] for m, _ in cf_by_method])


def invalidate_lca_cache(model_change: bool = True) -> None:
    """Drop cached factorisations. Call after any technosphere change (model edits, parameter
    recalculation) — otherwise scores would be computed against a stale matrix. Lock-free: see
    the _CACHE_GEN comment (a mutation must never wait behind an in-flight traversal).

    ``model_change=False`` is for the reversible windows (scenario apply→restore, sensitivity
    sweeps): the matrices change and change back, so the factorisation caches must drop, but the
    MODEL is the same afterwards — see the _MODEL_GEN comment for what keying on the wrong counter
    cost."""
    global _CACHE_GEN, _MODEL_GEN
    _CACHE_GEN += 1
    if model_change:
        _MODEL_GEN += 1


def release_cached(project: str) -> None:
    """Drop the cached factorisations of ``project`` and close the ZIP files their datapackages keep open.
    bw2calc reads a database's processed arrays from ZIP files for as long as its LCA lives, and Windows
    refuses to delete an open file: a project directory cannot be removed while one of its LCAs is cached."""
    with _LCA_LOCK:
        for key in [k for k in _LCA_CACHE if k[0] == project]:
            for package in getattr(_LCA_CACHE.pop(key)["lca"], "packages", None) or []:
                if getattr(package, "fs", None) is not None:
                    package.fs.close()


def inventory_method() -> tuple:
    """A registered LCIA method to solve the technosphere with, for a read that needs the inventory only.

    A cached LCA is built per (demand, method), so any method gives the same supply vector; one already in
    the cache keeps such a read from forcing a second factorisation of the whole matrix. Only a method of THIS
    project's cache: the cache outlives a project switch, and the previous project's custom method is unknown
    here — the inventory then failed on a method it never needed.
    """
    bd = get_bd()
    here = str(bd.projects.current)
    method = next((e for k, e in _LCA_CACHE.items() if k[0] == here and e.get("method")), {}).get("method")
    if method is None:
        method = next(iter(bd.methods), None)
    if method is None:
        raise PrismError(
            "No LCIA method is registered, so the technosphere cannot be solved.",
            code="no_methods",
            hint="Import impact methods for this workspace first.",
        )
    return tuple(method)


def cache_generation() -> int:
    """How often the MATRICES changed, for the factorisation caches. Includes the reversible
    scenario/sensitivity windows — do not key anything long-lived on this; use
    :func:`model_generation`."""
    return _CACHE_GEN


def model_generation() -> int:
    """How many times the USER'S MODEL changed, as a number anything long-lived may key a cache on.

    Every mutation that can move a score bumps this (the command bus around each command and each
    undo/redo, real parameter edits, method edits, an ecoinvent import, a repository write) — but a
    reversible scenario/sensitivity window does not: it restores the baseline before anyone else
    can compute, so the model afterwards IS the model from before. A caller that stores something
    derived from the model records this generation and knows, for free, whether it is still talking
    about the same model.
    """
    return _MODEL_GEN


def _direct_impact(lca, act) -> float:
    """The score carried by the activity's OWN biosphere exchanges — its column of the characterised
    inventory — as opposed to everything its inputs bring. A gas boiler is ~80 % direct, a market ~0 %."""
    col = lca.dicts.activity[act.id]
    return float(lca.characterized_inventory[:, col].sum())


def _own_impact_of(lca, database: str) -> float:
    """The score the processes of ``database`` carry with their OWN biosphere exchanges for the lca's current
    demand: their columns of the characterised inventory, summed. Read off the solved system, so every process
    the demand runs counts, however deep in the chain, however small its share, and every round of a loop."""
    from bw2data.backends.schema import ActivityDataset

    columns = lca.dicts.activity
    ids = ActivityDataset.select(ActivityDataset.id).where(ActivityDataset.database == database).tuples()
    cols = [columns[i] for (i,) in ids if i in columns]
    return float(lca.characterized_inventory[:, cols].sum()) if cols else 0.0


def _split(total: float, direct: float) -> dict:
    return {
        "direct": _sig(direct),
        "upstream": _sig(total - direct),
        "direct_share": _sig(direct / total) if total else 0.0,
    }


def compute_lcia(
    database: str, code: str, method, amount: float = 1.0, direct_split: bool = False, observe=None
) -> dict:
    """``observe(system, method)`` is called while the factorised system holds this demand and method —
    for a reader that needs more of it than the score (engine/difference_terms.py)."""
    bd = get_bd()
    m = resolve_method(method)
    act = get_activity(database, code)
    with _LCA_LOCK:
        lca = get_lca({act.id: amount * _demand_sign(act)}, m)
        score = float(lca.score)
        direct = _direct_impact(lca, act) if direct_split else None
        if observe is not None:
            observe(lca, m)
    out = {
        # The activity's OWN database name, not the one the caller typed: names resolve forgivingly
        # now, so echoing the input would answer "cling film cradle-to-gate" to a question about
        # "Cling film — cradle-to-gate" and leave the caller unsure which model it computed.
        "activity": {"database": act.key[0], "code": act.key[1], "name": act.get("name")},
        "amount": amount,
        "method": list(m),
        "unit": bd.methods[m].get("unit", ""),
        "score": score,
    }
    if direct is not None:
        # Direct vs. upstream: the gate-to-gate check (is the process itself the emitter, or its
        # supply chain?) that until now needed the whole contribution tree for one number.
        out.update(_split(score, direct))
    return out


def compute_multi(
    database: str,
    code: str,
    methods: list,
    amount: float = 1.0,
    direct_split: bool = False,
    partial: bool = False,
) -> dict:
    """The scores of one activity for several methods.

    ``partial``: a method that does not resolve is named under ``not_computed`` with its way out instead of
    failing the call, and the others are computed; only when none resolves is it an error. Off by default,
    because a caller such as the report pipeline reads a 404 from here as "the process is gone".
    """
    not_computed: list[dict] = []
    if partial:
        methods, not_computed = resolve_methods(methods)
        if not methods:
            raise none_resolved(not_computed)
    results = [compute_lcia(database, code, m, amount, direct_split) for m in methods]
    keys = ("method", "unit", "score") + (("direct", "upstream", "direct_share") if direct_split else ())
    out = {
        "activity": results[0]["activity"] if results else {"database": database, "code": code},
        "amount": amount,
        "results": [{k: r[k] for k in keys if k in r} for r in results],
    }
    if not_computed:
        out["not_computed"] = not_computed
    return out


def contribution_matrix(
    database: str,
    code: str,
    methods: list,
    amount: float = 1.0,
    cutoff: float = 0.01,
    top_n: int = 40,
    should_cancel=None,
) -> dict:
    """Hotspot matrix: each process's OWN impact (its emissions, not its supply chain) × indicators.

    One factorisation, one characterisation per indicator. A process is included when its share reaches
    ``cutoff`` in AT LEAST ONE indicator, and an included process carries its full vector — a process at
    0.3 % of climate change but 40 % of land use stands in the matrix with both numbers. Per-indicator
    top lists lose exactly those cells, and with them the trade-off a materials decision turns on.

    Rows are direct contributions (the characterised inventory summed per activity column), so a column
    adds up to the indicator's total; ``rest`` is what the rows below the cutoff carry together.
    """
    import numpy as np

    bd = get_bd()
    root = get_activity(database, code)
    ms = [resolve_method(m) for m in (methods or [])]
    if not ms:
        raise PrismError("Pass at least one LCIA method.", code="invalid_request",
                         hint="Method tuples come from list_methods.")
    demand = {root.id: amount * _demand_sign(root)}
    totals: list[float] = []
    cols = []
    units: list[str] = []
    with _LCA_LOCK:
        lca = None
        for m in ms:
            if should_cancel and should_cancel():
                raise CalcCancelled()
            lca = get_lca(demand, m)  # switches the characterisation, keeps the factorisation
            totals.append(float(lca.score))
            cols.append(np.asarray(lca.characterized_inventory.sum(axis=0)).ravel())
            units.append(bd.methods[m].get("unit", ""))
        by_col = {v: k for k, v in lca.dicts.activity.items()}
    values = np.column_stack(cols)  # n_activities × n_methods
    shares = np.column_stack([c / t if t else np.zeros_like(c) for c, t in zip(cols, totals, strict=True)])
    keep = np.where((np.abs(shares) >= cutoff).any(axis=1))[0]
    order = keep[np.argsort(-np.abs(shares[keep]).max(axis=1))] if len(keep) else keep
    n_included = int(len(order))
    order = order[:top_n]
    isic_lookup: dict[str, str] = {}
    cpc_lookup: dict[str, str] = {}
    rows: list[dict] = []
    for ix in order:
        act = bd.get_node(id=by_col[int(ix)])
        isic, cpc, cpc_name = _classify_activity(act)
        if isic:
            isic_lookup.setdefault(isic, _ISIC_SECTION_NAMES.get(isic, isic))
        if cpc:
            cpc_lookup.setdefault(cpc, cpc_name or cpc)
        rows.append(
            {
                "db": act.key[0],
                "c": act.key[1],
                "n": act.get("name"),
                "g": act.get("location") or "",
                "isic": isic,
                "cpc": cpc,
                "values": [_sig(float(v)) for v in values[ix]],
                "shares": [_sig(float(v)) for v in shares[ix]],
            }
        )
    shown = values[order].sum(axis=0) if len(order) else np.zeros(len(ms))
    return {
        "meta": {
            "database": root.key[0],
            "code": root.key[1],
            "name": root.get("name"),
            "amount": amount,
            "cutoff": cutoff,
            "top_n": top_n,
            "n_included": n_included,
            "n_shown": len(rows),
            "methods": [
                {"method": list(m), "unit": u, "total": _sig(t)} for m, u, t in zip(ms, units, totals, strict=True)
            ],
        },
        "lookups": {"isic": isic_lookup, "cpc": cpc_lookup},
        "rows": rows,
        "rest": [
            {"value": _sig(float(t - sv)), "share": _sig(float((t - sv) / t)) if t else 0.0}
            for t, sv in zip(totals, shown, strict=True)
        ],
    }


def _classifier(aggregate_by: str | None):
    """Return a fn activity -> group key, for `aggregate_by` = 'geo' | 'isic' | 'cpc' | None.
    (The 'tag:<dim>' case never reaches here — contribution() handles it path-based upfront.)"""
    if aggregate_by == "geo":
        return lambda act: act.get("location") or "(no geo)"
    if aggregate_by == "isic":
        return lambda act: _classify_activity(act)[0] or "(no ISIC)"
    if aggregate_by == "cpc":
        return lambda act: _classify_activity(act)[1] or "(no CPC)"
    return None


# ISIC Rev.4 section letter → English name (used to colour/label the contribution tree).
_ISIC_SECTION_NAMES = {
    "A": "Agriculture, forestry and fishing",
    "B": "Mining and quarrying",
    "C": "Manufacturing",
    "D": "Electricity, gas, steam and air conditioning",
    "E": "Water supply; sewerage and waste management",
    "F": "Construction",
    "G": "Wholesale and retail trade",
    "H": "Transportation and storage",
    "I": "Accommodation and food service",
    "J": "Information and communication",
    "K": "Financial and insurance",
    "L": "Real estate",
    "M": "Professional, scientific and technical",
    "N": "Administrative and support service",
    "O": "Public administration and defence",
    "P": "Education",
    "Q": "Human health and social work",
    "R": "Arts, entertainment and recreation",
    "S": "Other service activities",
    "T": "Household activities",
    "U": "Extraterritorial organizations",
}


def _isic_section(division: int) -> str | None:
    """Map an ISIC Rev.4 division number (1–99) to its section letter (A–U)."""
    ranges = [
        (1, 3, "A"), (5, 9, "B"), (10, 33, "C"), (35, 35, "D"), (36, 39, "E"),
        (41, 43, "F"), (45, 47, "G"), (49, 53, "H"), (55, 56, "I"), (58, 63, "J"),
        (64, 66, "K"), (68, 68, "L"), (69, 75, "M"), (77, 82, "N"), (84, 84, "O"),
        (85, 85, "P"), (86, 88, "Q"), (90, 93, "R"), (94, 96, "S"), (97, 98, "T"),
        (99, 99, "U"),
    ]
    for lo, hi, sec in ranges:
        if lo <= division <= hi:
            return sec
    return None


def _classify_activity(act) -> tuple[str, str, str]:
    """(ISIC section letter, CPC code, CPC name) from an ecoinvent activity's classifications.

    ecoinvent stores ``classifications`` as e.g. ('ISIC rev.4 ecoinvent', '2811:...') and
    ('CPC', '43310: ...'). Missing/odd entries degrade to empty strings.
    """
    isic, cpc, cpc_name = "", "", ""
    for cls in (act.get("classifications") or []):
        if not isinstance(cls, (list, tuple)) or len(cls) < 2:
            continue
        system, value = str(cls[0]).upper(), str(cls[1]).strip()
        if "ISIC" in system and not isic:
            num = ""
            for ch in value:
                if ch.isdigit():
                    num += ch
                else:
                    break
            if len(num) >= 2:
                isic = _isic_section(int(num[:2])) or ""
        elif "CPC" in system and not cpc:
            parts = value.split(":", 1)
            cpc = parts[0].strip()
            cpc_name = parts[1].strip() if len(parts) > 1 else ""
    # PrismLCA overrides (set by the user on foreground activities) win over parsed classifications,
    # so a hand-built process can be classified for the ISIC/CPC stacked breakdown.
    ov_isic = act.get("prism_isic")
    if ov_isic:
        isic = str(ov_isic)
    ov_cpc = act.get("prism_cpc")
    if ov_cpc:
        cpc = str(ov_cpc)
        cpc_name = act.get("prism_cpc_name") or cpc_name
    return isic, cpc, cpc_name


class CalcCancelled(Exception):
    """Raised inside a traversal when a newer request has superseded this one."""


def contribution(
    database: str,
    code: str,
    method,
    amount: float = 1.0,
    cutoff: float = 0.005,
    max_depth: int = 8,
    aggregate_by: str | None = None,
    should_cancel=None,
) -> dict:
    bd = get_bd()
    m = resolve_method(method)
    root = get_activity(database, code)
    unit = bd.methods[m].get("unit", "")
    n_nodes = [0]
    # A tag breakdown is not read off the tree: the tree is pruned (cutoff, depth, repeated nodes) and
    # its split would be wrong exactly where it is pruned. It is solved exactly in phase_attribution
    # after the traversal; the tree stays the display. Geo/ISIC/CPC stay per-node from the tree.
    tag_dim: str | None = aggregate_by[4:] if aggregate_by and aggregate_by.startswith("tag:") else None
    classify = None if tag_dim is not None else _classifier(aggregate_by)
    groups: dict[str, float] = {}
    isic_lookup: dict[str, str] = {}
    cpc_lookup: dict[str, str] = {}

    with _LCA_LOCK:
        import numpy as np

        lca = get_lca({root.id: 1.0}, m)
        prod_cache: dict[int, float] = {}

        # One transposed solve gives the cumulative unit impact of EVERY activity at once
        # (see _adjoint_unit_impacts) — the traversal below then never solves again.
        cf = np.asarray(lca.characterization_matrix.sum(axis=0)).ravel()
        unit_all = _adjoint_unit_impacts(lca, [(m, cf)])[:, 0]
        # u is indexed by matrix ROWS = products ("demand 1 unit of X" is a product demand);
        # for chimaera nodes (ecoinvent + our foreground) product and activity ids coincide.
        prod_ix = lca.dicts.product

        def unit_impact(node_id: int) -> float:
            return float(unit_all[prod_ix[node_id]])

        def prod_amount(a) -> float:
            if a.id not in prod_cache:
                prod_cache[a.id] = _production_amount(a)
            return prod_cache[a.id]

        fg_db = root.key[0]
        # Demand-sign normalisation: for a treatment root (production −1), amount=1 means
        # "treat 1 unit", so the effective product-flow demand is amount·sign (see _demand_sign).
        root_amt = amount * _demand_sign(root)
        total = root_amt * unit_impact(root.id)
        # What the model's processes emit THEMSELVES. The tree's "dir" is not that — it is what the cutoff
        # and the depth limit left unexplained under a node, which for the root is the whole truncated
        # remainder; printed as "x % arise directly in the foreground processes" it read 0.7 % for a
        # foreground with no elementary flows at all (V411). Nor is it a sum over the tree's nodes, which
        # misses every process the tree does not open: below the cutoff, past the depth limit, a loop's
        # second round. So it is read off the solved system. Only the root's model counts: for the background
        # the question is the database's, and the per-node "dir" stays what the tree viewer draws.
        fg_direct = root_amt * _own_impact_of(lca, fg_db)

        def build(act, amt: float, depth: int, ancestors: frozenset) -> dict:
            n_nodes[0] += 1
            if should_cancel and (n_nodes[0] & 63) == 0 and should_cancel():
                raise CalcCancelled()
            cumulative = amt * unit_impact(act.id)
            children: list[dict] = []
            child_sum = 0.0    # recursed children — the TREE's "dir" keeps truncated subtrees
            skipped_sum = 0.0  # below-cutoff children — attributed to their OWN group instead
            if depth < max_depth and act.id not in ancestors:
                # `amt` is in product-flow units; one "run" of the activity produces
                # production_amount units — so inputs scale with amt/prod, NOT with amt alone
                # (prod=−1 for treatments flips the sign; foreground prods may be ≠ ±1).
                runs = amt / prod_amount(act)
                for ex in act.technosphere():
                    inp = ex.input
                    child_amt = runs * (ex.get("amount") or 0.0)
                    cimp = child_amt * unit_impact(inp.id)
                    # Zero-total edge case: prune exactly-zero children (otherwise a zero-CF
                    # method would recurse the full tree to max_depth — thousands of solves).
                    if cutoff and (abs(cimp) < abs(total) * cutoff or (total == 0 and cimp == 0)):
                        # Below cutoff: don't recurse, but attribute the child's cumulative
                        # impact to ITS group, not the parent's.
                        if classify is not None:
                            groups[classify(inp)] = groups.get(classify(inp), 0.0) + cimp
                            skipped_sum += cimp
                        continue
                    child_sum += cimp
                    child = build(inp, child_amt, depth + 1, ancestors | {act.id})
                    if act.key[0] == fg_db and ex.get("prism_uid"):
                        child["x"] = ex.get("prism_uid")  # which input this is — a canvas box sums its own
                    children.append(child)
            direct = cumulative - child_sum
            # The group contribution excludes what was re-attributed to skipped children above.
            if classify is not None:
                groups[classify(act)] = groups.get(classify(act), 0.0) + (direct - skipped_sum)
            isic, cpc, cpc_name = _classify_activity(act)
            if isic:
                isic_lookup.setdefault(isic, _ISIC_SECTION_NAMES.get(isic, isic))
            if cpc:
                cpc_lookup.setdefault(cpc, cpc_name or cpc)
            node = {
                # db + c identify the activity; codes alone can collide across databases
                # (e.g. foreground vs. background), so consumers must key on the pair.
                "db": act.key[0],
                "c": act.key[1],
                "n": act.get("name"),
                "g": act.get("location") or "",
                "a": _sig(amt),
                "u": act.get("unit") or "",
                "imp": _sig(cumulative),
                "dir": _sig(cumulative - child_sum),
                "shr": _sig(cumulative / total) if total else 0.0,
                "isic": isic,
                "cpc": cpc,
            }
            if children:
                node["ch"] = children
            return node

        tree = build(root, root_amt, 0, frozenset())
        from prism_lca.engine.phase_attribution import Foreground, attribute

        if tag_dim is not None:  # a model the breakdown cannot split fails loudly here
            fg = Foreground(root, lambda nid: (unit_impact(nid),), _production_amount)
            groups = {k: float(v[0]) for k, v in attribute(fg, tag_dim, root_amt, 1).groups.items()}
        # Exact impact per direct input from outside the model, by exchange uid — what a canvas box
        # (one or more such inputs) carries, independent of what the pruned tree shows. Optional: a
        # model the split cannot handle still gets its tree, the canvas then has no per-box share.
        try:
            fg = Foreground(root, lambda nid: (unit_impact(nid),), _production_amount)
            inputs = {uid: _sig(float(v[0])) for uid, v in attribute(fg, None, root_amt, 1).inputs.items()}
        except PrismError:
            inputs = {}

    result = {
        "meta": {
            "database": root.key[0],
            "method": list(m),
            "total": _sig(total),
            "unit": unit,
            "direct": _sig(tree["dir"]),
            "upstream": _sig(total - tree["dir"]),
            # The model's own emissions, exact whatever the tree's cutoff and depth — the figure a sentence
            # about "directly in the foreground processes" may quote. `direct`/`upstream` keep the tree's
            # reading for the viewers that draw it.
            "foreground_direct": _sig(fg_direct),
            "n_nodes": n_nodes[0],
            "cutoff": cutoff,
            "max_depth": max_depth,
            "inputs": inputs,
        },
        "lookups": {"isic": isic_lookup, "cpc": cpc_lookup},
        "tree": tree,
    }
    if classify is not None or tag_dim is not None:
        eps = max(abs(total) * NOISE_SHARE, 1e-18)  # drop float-noise groups (see compare_stacked)
        result["aggregation"] = {
            "dimension": aggregate_by,
            "groups": [
                {"key": k, "impact": _sig(v), "share": _sig(v / total) if total else 0.0}
                for k, v in sorted(groups.items(), key=lambda kv: abs(kv[1]), reverse=True)
                if v == 0.0 or abs(v) >= eps
            ],
        }
    return result


def compare_stacked(
    subjects: list[dict], methods: list, dimensions: list[str],
    cutoff: float = 0.03, max_depth: int = 6, should_cancel=None, store=None,
) -> dict:
    """For each subject return, per method, the impact broken down by EVERY dimension in
    ``dimensions`` ('isic' | 'cpc' | 'geo' | 'tag:<group>').

    ONE tree traversal per subject serves ALL selected methods: the expensive step per node is the
    linear solve (``redo_lci``), and the resulting inventory is method-independent — so we solve it
    once per node and characterise it against each method's CF vector (a cheap dot product). This
    costs `nodes` solves instead of `nodes × methods`. The per-dimension bucketing is nearly free
    too, so split-by is instant client-side. Coarser cutoff/depth than a full tree since only group
    totals matter. Totals are exact (independent of cutoff/depth)."""
    import numpy as np

    from prism_lca.engine.phase_attribution import Foreground, attribute
    from prism_lca.engine.tags import TagStore

    bd = get_bd()
    tag_store = TagStore().load_map()  # one read for all subjects x methods
    # Tag dimensions are solved exactly (phase_attribution); the tree only serves ISIC/CPC/geo.
    tag_dims = {d: d[4:] for d in dimensions if d.startswith("tag:")}
    tree_dims = [d for d in dimensions if d not in tag_dims]
    keys_by_dim: dict[str, list[str]] = {d: [] for d in dimensions}
    cpc_names: dict[str, str] = {}  # cpc code -> human name, collected across the traversal
    out_subjects: list[dict] = []
    resolved = [(resolve_method(m), m) for m in methods]  # (canonical tuple, original list)
    n_methods = len(resolved)

    def classify(act, isic, cpc, dim):
        if dim == "isic":
            return isic or "(no ISIC)"
        if dim == "cpc":
            return cpc or "(no CPC)"
        if dim == "geo":
            return act.get("location") or "(no geo)"
        return "?"

    def _subject_buckets(root, amount: float):
        """Totals + per-dimension buckets for ONE subject. A function scope (not the subject
        loop's body) so the traversal closures bind these locals — a closure over loop variables
        would silently read the *next* subject's state if anything ever deferred a call (B023)."""
        n_nodes = [0]
        # One bucket set per method: buckets[i][dimension][key] -> summed direct impact.
        buckets: list[dict[str, dict[str, float]]] = [{d: {} for d in dimensions} for _ in resolved]
        with _LCA_LOCK:
            lca = get_lca({root.id: 1.0}, resolved[0][0])
            # A characterisation vector per method, aligned to the biosphere row order (the CF matrix
            # is diagonal, so its column sums are the CFs). Node inventory is method-independent.
            cf_by_method = []
            for m, _orig in resolved:
                lca.switch_method(m)
                cf_by_method.append(np.asarray(lca.characterization_matrix.sum(axis=0)).ravel())
            lca.switch_method(resolved[0][0])  # restore so get_lca's cached method stays accurate

            prod_cache: dict[int, float] = {}

            # One transposed solve per method covers EVERY node's unit impact at once
            # (see _adjoint_unit_impacts) — the multi-dimension traversal never solves again.
            unit_all = _adjoint_unit_impacts(
                lca, [(m, cf) for (m, _orig), cf in zip(resolved, cf_by_method, strict=True)]
            )
            prod_ix = lca.dicts.product  # rows = products; see contribution()

            def unit_impacts(node_id: int) -> np.ndarray:
                """Per-method impact of one unit of `node_id` (adjoint lookup, no solve)."""
                return unit_all[prod_ix[node_id]]

            def prod_amount(a) -> float:
                if a.id not in prod_cache:
                    prod_cache[a.id] = _production_amount(a)
                return prod_cache[a.id]

            # Demand-sign normalisation for treatment roots (see contribution()).
            root_amt = amount * _demand_sign(root)
            totals = root_amt * unit_impacts(root.id)  # one total per method

            def build(act, amt: float, depth: int, ancestors: frozenset) -> None:
                n_nodes[0] += 1
                if should_cancel and (n_nodes[0] & 63) == 0 and should_cancel():
                    raise CalcCancelled()
                cumulative = amt * unit_impacts(act.id)
                child_sum = np.zeros(n_methods)
                if depth < max_depth and act.id not in ancestors:
                    # Product-flow units → activity runs (see contribution(): amt/prod).
                    runs = amt / prod_amount(act)
                    for ex in act.technosphere():
                        inp = ex.input
                        child_amt = runs * (ex.get("amount") or 0.0)
                        cimp = child_amt * unit_impacts(inp.id)
                        # Recurse if the child is significant for AT LEAST ONE method, so every
                        # method's breakdown is resolved (small slices for the others just add in).
                        # Zero-total methods can't judge shares — recurse on any non-zero impact
                        # (previously all-zero totals pruned EVERYTHING, collapsing the breakdown).
                        keep = any(
                            (totals[i] and abs(cimp[i]) >= abs(totals[i]) * cutoff)
                            or (totals[i] == 0 and cimp[i] != 0)
                            for i in range(n_methods)
                        )
                        if not keep:
                            # Below cutoff: attribute the child's cumulative impact to ITS own
                            # classification, not the parent's.
                            c_isic, c_cpc, c_cpc_name = _classify_activity(inp)
                            if c_cpc and c_cpc_name:
                                cpc_names.setdefault(c_cpc, c_cpc_name)
                            for d in tree_dims:
                                ckey = classify(inp, c_isic, c_cpc, d)
                                for i in range(n_methods):
                                    buckets[i][d][ckey] = buckets[i][d].get(ckey, 0.0) + float(cimp[i])
                            child_sum = child_sum + cimp
                            continue
                        child_sum = child_sum + cimp
                        build(inp, child_amt, depth + 1, ancestors | {act.id})
                direct = cumulative - child_sum
                isic, cpc, cpc_name = _classify_activity(act)
                if cpc and cpc_name:
                    cpc_names.setdefault(cpc, cpc_name)
                for d in tree_dims:
                    key = classify(act, isic, cpc, d)
                    for i in range(n_methods):
                        buckets[i][d][key] = buckets[i][d].get(key, 0.0) + float(direct[i])

            if tree_dims:
                build(root, root_amt, 0, frozenset())
            if tag_dims:
                fg = Foreground(root, unit_impacts, prod_amount, tag_store)
                for d, grp in tag_dims.items():
                    for key, vec in attribute(fg, grp, root_amt, n_methods).groups.items():
                        for i in range(n_methods):
                            buckets[i][d][key] = float(vec[i])
        return totals, buckets

    for s in subjects:
        if should_cancel and should_cancel():
            raise CalcCancelled()
        root = get_activity(s["database"], s["code"])
        amount = s.get("amount", 1.0)
        if store is not None and s.get("scenario"):
            # Break down the subject UNDER a scenario: apply its parameter overrides, traverse,
            # restore. _LCA_LOCK is an RLock, so _subject_buckets re-acquiring it is fine.
            from prism_lca.engine import param_window as _pw
            from prism_lca.engine import params as _params
            from prism_lca.engine import scenarios as _scen

            with _LCA_LOCK:
                baseline = _params.snapshot_all(s["database"])  # model-scoped parameters
                scenario = store.get(s["scenario"], s["database"])
                applied = _scen.plan(scenario, _params.snapshot_formulas(s["database"]))
                # Marked like every other window (engine/param_window.py): a traversal per subject
                # is a long span, and this one runs deep inside a report render.
                frame = _pw.open_window(
                    s["database"], "scenario", scenario["name"], baseline, applied.numbers, applied.replaced
                )
                try:
                    _params.apply_values(s["database"], {**baseline, **applied.numbers}, applied.formulas)
                    _scen.check_applied(s["database"], applied, scenario["name"])
                    totals, buckets = _subject_buckets(root, amount)
                except (CalcCancelled, PrismError):
                    raise
                except Exception as exc:  # noqa: BLE001 - clear message instead of an opaque 500
                    from prism_lca.errors import scenario_calc_error
                    raise scenario_calc_error(s.get("label") or s.get("scenario") or "?", exc) from exc
                finally:
                    _pw.restore_and_close(s["database"], baseline, frame)
        else:
            totals, buckets = _subject_buckets(root, amount)

        per_method: dict[str, dict] = {}
        for i, (m, orig) in enumerate(resolved):
            mkey = " · ".join(orig)
            unit = bd.methods[m].get("unit", "")
            total = float(totals[i])
            # Numerical-noise guard: bucket sums are float accumulations, and the tag split's own parts
            # are differences of cumulative impacts, so a group that is zero in reality can end up at
            # 1e-8 of the total ("(untagged)" ghosts, NOISE_SHARE). A tiny NEGATIVE sliver would drag
            # chart axes below zero although every real bar is positive. EXACT zeros stay: they are
            # legitimate (e.g. a classified activity whose impact is all upstream) and cannot skew an axis.
            eps = max(abs(total) * NOISE_SHARE, 1e-18)
            dims_out: dict[str, list[dict]] = {}
            for d in dimensions:
                groups = [
                    {"key": k, "impact": _sig(v), "share": _sig(v / total) if total else 0.0}
                    for k, v in sorted(buckets[i][d].items(), key=lambda kv: abs(kv[1]), reverse=True)
                    if v == 0.0 or abs(v) >= eps
                ]
                dims_out[d] = groups
                for g in groups:
                    if g["key"] not in keys_by_dim[d]:
                        keys_by_dim[d].append(g["key"])
            per_method[mkey] = {"total": _sig(total), "unit": unit, "dims": dims_out}
        out_subjects.append({"label": s.get("label"), "code": s["code"], "methods": per_method})
    # Human labels per key: ISIC section letters and CPC codes get their names appended so the
    # legend reads "C — Manufacturing" / "01341 — Apples" instead of a bare letter/code.
    labels_by_dim: dict[str, dict[str, str]] = {}
    for d in dimensions:
        lab: dict[str, str] = {}
        for k in keys_by_dim[d]:
            if d == "isic" and k in _ISIC_SECTION_NAMES:
                lab[k] = f"{k} — {_ISIC_SECTION_NAMES[k]}"
            elif d == "cpc" and cpc_names.get(k):
                lab[k] = f"{k} — {cpc_names[k]}"
            else:
                lab[k] = k
        labels_by_dim[d] = lab
    return {"subjects": out_subjects, "keys": keys_by_dim, "labels": labels_by_dim, "dimensions": dimensions}


def elementary_flows(
    database: str,
    code: str,
    method,
    amount: float = 1.0,
    top_n: int = 20,
    raw_demand: bool = False,
    direct_split: bool = False,
) -> dict:
    """Characterised elementary (biosphere) flows contributing to the score, largest first.

    ``top_n`` caps the list; ``top_n <= 0`` returns all of them. ``count`` always reports how many there
    are, so a capped caller can say so.

    ``raw_demand=True`` treats ``amount`` as a ready matrix demand (sign included) — used by
    the contribution-tree panel, whose node amounts are already sign-normalised.

    ``direct_split=True`` adds per flow the part the activity emits ITSELF (its own column of the
    characterised inventory) next to the whole-chain figure, and the same split for the total."""
    import numpy as np

    bd = get_bd()
    m = resolve_method(method)
    act = get_activity(database, code)
    with _LCA_LOCK:
        lca = get_lca({act.id: amount if raw_demand else amount * _demand_sign(act)}, m)
        row_totals = np.asarray(lca.characterized_inventory.sum(axis=1)).ravel()
        reverse = {v: k for k, v in lca.dicts.biosphere.items()}
        total = float(lca.score)
        direct_rows = None
        if direct_split:
            col = lca.dicts.activity[act.id]
            direct_rows = np.asarray(lca.characterized_inventory[:, col].todense()).ravel()
    flows = flow_rows(bd, row_totals, reverse, total, direct_rows)
    split = _split(total, float(direct_rows.sum())) if direct_rows is not None else {}
    return {
        **split,
        "database": act.key[0],
        "code": act.key[1],
        "method": list(m),
        "unit": bd.methods[m].get("unit", ""),
        "total": _sig(total),
        # How many there are, not how many are returned: the list is capped and the total above it is the
        # whole score, so a reader needs to be told that the two do not add up — and the UI needs a number
        # to put on its "show all" button.
        "count": len(flows),
        # `top_n <= 0` means all of them. An ecoinvent process characterises a few thousand flows, which is
        # a fine thing to export and a poor thing to scroll, so the caller decides.
        "flows": flows if top_n <= 0 else flows[:top_n],
    }


def flow_rows(bd, row_totals, reverse: dict, total: float, direct_rows=None) -> list[dict]:
    """One row per characterised elementary flow that is not zero, largest first."""
    flows: list[dict] = []
    for i, val in enumerate(row_totals):
        v = float(val)
        if abs(v) < 1e-15:
            continue
        nid = reverse.get(i)
        node = bd.get_node(id=nid) if nid is not None else None
        row = {
            "flow": node["name"] if node else str(nid),
            "categories": list(node.get("categories") or []) if node else [],
            "unit": node.get("unit") if node else "",
            "impact": _sig(v),
            "share": _sig(v / total) if total else 0.0,
        }
        if direct_rows is not None:
            row["direct"] = _sig(float(direct_rows[i]))
        flows.append(row)
    flows.sort(key=lambda x: abs(x["impact"]), reverse=True)
    return flows


def resolve_flow_node(bd, key, cache: dict):
    """Resolve a method-CF flow key to its biosphere node. Method.load() yields int node ids on
    ecoinvent (bw25) but (db, code) tuples on hand-written methods — handle both. Cached because a
    flow is typically characterised by several of the compared methods."""
    if key in cache:
        return cache[key]
    node = None
    try:
        node = bd.get_activity(key)  # accepts an id or a (db, code) key in bw25
    except Exception as exc:  # noqa: BLE001 - fall back below, never fail the whole table for one flow
        _log.swallowed(exc, "resolve_flow_node")
        try:
            node = bd.get_node(id=key) if isinstance(key, int) else None
        except Exception as exc:  # noqa: BLE001
            _log.swallowed(exc, "resolve_flow_node")
            node = None
    cache[key] = node
    return node


def characterization_factors(methods: list, flow_query: str | None = None, limit: int = 0) -> dict:
    """Characterisation factors of up to 4 LCIA indicators, side by side.

    Returns every flow characterised by ANY of the chosen methods (their union); a method that
    doesn't characterise a given flow gets ``None`` for that cell (rendered greyed-out). Factors
    are left unrounded so the Excel export is exact.

    ``flow_query`` keeps only flows whose name or compartment contains it (case-insensitive) and
    ``limit`` caps the row count (0 = unlimited). Both live HERE rather than in a caller so that
    every client — the LCIA page, the assistant's tool, a future MCP wrapper — narrows the (very
    large) flow set the same way; ``total_flows`` reports how many matched before the cap."""
    bd = get_bd()
    if not methods:
        raise PrismError("No LCIA methods specified.", code="no_method",
                         hint="Pass 'methods' as a list of method tuples.")
    if len(methods) > 4:
        raise PrismError("Compare at most 4 indicators at once.", code="too_many_methods",
                         hint="Select up to four indicators.")
    resolved = [resolve_method(m) for m in methods]
    meta = [{"method": list(m), "name": " · ".join(m), "unit": bd.methods[m].get("unit", "")}
            for m in resolved]

    per_method: list[dict] = []
    order: list = []  # flow keys in first-seen order
    seen: set = set()
    for m in resolved:
        cfs: dict = {}
        for item in bd.Method(m).load():
            key, cf = item[0], float(item[1])
            cfs[key] = cf
            if key not in seen:
                seen.add(key)
                order.append(key)
        per_method.append(cfs)

    cache: dict = {}
    flows: list[dict] = []
    for key in order:
        node = resolve_flow_node(bd, key, cache)
        flows.append({
            "flow": node["name"] if node else str(key),
            "categories": list(node.get("categories") or []) if node else [],
            "unit": (node.get("unit") if node else "") or "",
            "factors": [cfs[key] if key in cfs else None for cfs in per_method],
        })
    flows.sort(key=lambda f: (f["flow"].lower(), f["categories"]))

    q = (flow_query or "").strip().lower()
    if q:
        flows = [f for f in flows
                 if q in f["flow"].lower() or q in " / ".join(f["categories"]).lower()]
    total = len(flows)
    if limit and limit > 0:
        flows = flows[:limit]
    return {"methods": meta, "flows": flows, "total_flows": total}

