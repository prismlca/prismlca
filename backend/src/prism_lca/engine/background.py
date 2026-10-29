"""Background lazy-expand (M15 / ADR-012, Idea #1).

A background activity (ecoinvent) has thousands of upstream tiers; drawing them all is what
makes the Activity Browser choke. Instead the canvas shows tier 1 and expands on demand. This
returns the direct technosphere inputs of one activity — optionally scored by their impact
contribution so the UI can hide the long tail below a cutoff. Read-only; ``localize`` (a
command) is what pulls a path into the editable foreground.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import is_read_only
from prism_lca.engine.lca import (
    _LCA_LOCK,
    _demand_sign,
    _production_amount,
    _sig,
    get_lca,
    resolve_method,
)
from prism_lca.engine.model import _db_or_404, get_activity


def expand(
    database: str,
    code: str,
    amount: float = 1.0,
    method=None,
    cutoff: float = 0.0,
) -> dict:
    """Tier-1 technosphere inputs of an activity. With ``method`` set, each input carries its
    impact contribution and ``share`` of the activity's total, and inputs below ``cutoff``
    (fractional share) are dropped."""
    bd = get_bd()
    database = _db_or_404(bd, database)
    root = get_activity(database, code)

    if method is not None:
        # Scored expand: reuse the shared factorised LCA (building a fresh one re-factorises the
        # whole technosphere — seconds per click) and hold the lock for the whole scoring pass.
        m = resolve_method(method)
        with _LCA_LOCK:
            # Demand-sign normalisation for treatment roots (see engine.lca._demand_sign).
            sign = _demand_sign(root)
            lca = get_lca({root.id: amount * sign}, m)
            unit = bd.methods[m].get("unit", "")
            total = amount * sign * _unit_impact(lca, root.id, {})
            return _expand_body(bd, database, code, root, amount, method, lca, total, unit, cutoff)
    return _expand_body(bd, database, code, root, amount, method, None, None, "", cutoff)


def _expand_body(bd, database, code, root, amount, method, lca, total, unit, cutoff) -> dict:

    cache: dict[int, float] = {}
    inputs: list[dict] = []
    edges: list[dict] = []
    # Product-flow demand → activity runs: inputs scale with amount·sign/prod (prod=−1 for
    # treatment roots, so the sign cancels; foreground prods may be ≠ ±1).
    prod = _production_amount(root)
    runs = amount * _demand_sign(root) / prod if prod else amount
    for ex in root.technosphere():
        inp = ex.input
        child_amt = runs * (ex.get("amount") or 0.0)
        node = {
            "database": inp.key[0],
            "code": inp.key[1],
            "name": inp.get("name"),
            "product": inp.get("reference product"),
            "location": inp.get("location") or "",
            "unit": inp.get("unit") or "",
            "external": inp.key[0] != database,
            # read-only follows the database (background = locked), not "different db than parent":
            # an ecoinvent process's inputs are also in ecoinvent and must stay locked.
            "read_only": is_read_only(inp.key[0]),
            "upstream": sum(1 for e in inp.exchanges() if e.get("type") == "technosphere"),
        }
        if lca is not None:
            impact = child_amt * _unit_impact(lca, inp.id, cache)
            share = (impact / total) if total else 0.0
            # `total` guard: a zero total gives share 0.0 for every input — dropping them all
            # would be wrong, so the cutoff only applies when there is a total to compare against.
            if cutoff and total and abs(share) < cutoff:
                continue
            node["impact"] = _sig(impact)  # significant figures — round(x,6) zeroes tiny scores
            node["share"] = _sig(share)
        inputs.append(node)
        edges.append(
            {
                "uid": ex.get("prism_uid"),
                "amount": ex.get("amount"),
                "source": f"{inp.key[0]}/{inp.key[1]}",
                "target": f"{database}/{code}",
            }
        )

    if lca is not None:
        inputs.sort(key=lambda n: abs(n.get("impact", 0.0)), reverse=True)
    return {
        "root": {"database": database, "code": code, "name": root.get("name")},
        "amount": amount,
        "method": list(resolve_method(method)) if method is not None else None,
        "unit": unit,
        "total": _sig(total) if total is not None else None,
        "count": len(inputs),
        "inputs": inputs,
        "edges": edges,
    }


def _unit_impact(lca, node_id: int, cache: dict[int, float]) -> float:
    if node_id not in cache:
        lca.lcia(demand={node_id: 1.0})
        cache[node_id] = float(lca.score)
    return cache[node_id]
