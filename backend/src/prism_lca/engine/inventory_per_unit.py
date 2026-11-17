"""Technosphere quantities per functional unit: how much of every product one unit pulls in.

"How many grams of glycerine are in one tube?" had no answer in the toolbox: the contribution tree carries
impacts rather than quantities, `explain_result mode="flows"` is elementary flows only, and reading the
exchanges gives amounts per process, not per functional unit. Both the assistant and the review sub-agent
worked it out by hand (0.4 × 0.05406 kg), and the reviewer then raised the number it had derived itself as a
blocking finding. This is that arithmetic done once, correctly.

Two readings of the same solve:

* ``scope="all"`` lists every dataset of the supply chain with the total the functional unit pulls through it,
  the background included — the electricity row is all the electricity anywhere upstream. On a full ecoinvent
  that is some sixteen thousand rows, so it is cut to ``top_n`` and narrowed with ``query``.
* ``scope="foreground"`` is the recipe: the processes of the models and the library with their output per unit,
  and the background datasets they draw on directly, with the amount they draw. What the background itself
  uses of the same product on top is not in it; that total is the ``"all"`` row.

A quantity is in the convention of the exchanges: the scaling vector times the activity's own reference amount,
and a direct draw the consumer's runs times the exchange amount. A substitution counts as a negative draw, and a
waste sent to treatment is negative, as in the exchange that sends it. Where the foreground is a dataset's only
consumer the two figures are the same number, so the scopes agree wherever they overlap.
"""
from __future__ import annotations

import numpy as np

from prism_lca import _log
from prism_lca.engine import lca
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.model import get_activity
from prism_lca.engine.tag_scope import LIBRARY, MODEL, kind_checker
from prism_lca.errors import PrismError

SCOPES = ("all", "foreground")
#: A scaling factor or quantity below this is solver noise, not an input.
_NOISE = 1e-12
#: Foreground rows first, then what they draw from the background; within each, the largest amount first.
_KIND_ORDER = {MODEL: 0, LIBRARY: 1}


def _row(node, quantity: float) -> dict:
    return {
        "database": node.key[0],
        "code": node.key[1],
        "name": node.get("name") or "",
        "product": node.get("reference product") or "",
        "location": node.get("location") or "",
        "unit": node.get("unit") or "",
        "quantity": quantity,
    }


def _whole_chain(solved, root_id: int) -> list[dict]:
    """Every activity the solve scales, the functional unit excepted."""
    bd = get_bd()
    supply = np.asarray(solved.supply_array).ravel()
    by_col = {col: node_id for node_id, col in solved.dicts.activity.items()}
    rows: list[dict] = []
    for col, s in enumerate(supply):
        if not s or abs(float(s)) < _NOISE:
            continue
        node_id = by_col.get(col)
        if node_id is None or node_id == root_id:
            continue  # the functional unit itself is not part of its own inventory
        try:
            node = bd.get_node(id=node_id)
        except Exception as exc:  # noqa: BLE001 - a node we cannot resolve is simply not listed
            _log.swallowed(exc, "technosphere_inventory")
            continue
        rows.append(_row(node, float(s) * lca._production_amount(node)))
    return rows


def _foreground(solved, root) -> list[dict]:
    """The recipe: the model and library processes reachable from ``root``, and their direct background draws.

    Walks the exchanges from the root instead of resolving every column of the solve, so it reads a few dozen
    datasets where the whole chain reads all of them."""
    supply = np.asarray(solved.supply_array).ravel()
    cols = solved.dicts.activity
    kind = kind_checker()
    rows: list[dict] = []
    drawn: dict[int, list] = {}  # supplier id -> [supplier, quantity drawn by the foreground]
    seen: set[int] = set()
    stack = [root]
    while stack:
        node = stack.pop()
        if node.id in seen:
            continue
        seen.add(node.id)
        col = cols.get(node.id)
        runs = float(supply[col]) if col is not None else 0.0
        if abs(runs) < _NOISE:
            continue  # not run at all: nothing it draws reaches the functional unit
        if node.id != root.id:
            row = _row(node, runs * lca._production_amount(node))
            row["kind"] = kind(node.key[0])
            rows.append(row)
        for ex in node.exchanges():
            ex_type = ex.get("type")
            if ex_type not in ("technosphere", "substitution"):
                continue
            supplier = ex.input
            if kind(supplier.key[0]) in (MODEL, LIBRARY):
                stack.append(supplier)
                continue
            # A substitution enters the matrix with the opposite sign of a technosphere input.
            amount = float(ex.get("amount") or 0.0) * (-1.0 if ex_type == "substitution" else 1.0)
            drawn.setdefault(supplier.id, [supplier, 0.0])[1] += runs * amount
    for supplier, quantity in drawn.values():
        if abs(quantity) >= _NOISE:
            row = _row(supplier, quantity)
            row["kind"] = kind(supplier.key[0])
            rows.append(row)
    return rows


def technosphere_inventory(
    database: str,
    code: str,
    amount: float = 1.0,
    query: str | None = None,
    top_n: int = 40,
    scope: str = "all",
) -> dict:
    """How much of every technosphere product one functional unit pulls in — see the module docstring."""
    if scope not in SCOPES:
        raise PrismError(
            f"Unknown scope '{scope}'.",
            code="inventory_scope",
            hint="Pass scope='foreground' for the model's own processes and what they draw from the background "
            "directly, or scope='all' (the default) for the whole supply chain.",
        )
    act = get_activity(database, code)
    with lca._LCA_LOCK:
        solved = lca.get_lca({act.id: amount * lca._demand_sign(act)}, lca.inventory_method())
        rows = _foreground(solved, act) if scope == "foreground" else _whole_chain(solved, act.id)
    q = (query or "").strip().lower()
    if q:
        rows = [r for r in rows if q in r["name"].lower() or q in r["product"].lower()]
    if scope == "foreground":
        rows.sort(key=lambda r: (_KIND_ORDER.get(r["kind"], 2), -abs(r["quantity"])))
    else:
        rows.sort(key=lambda r: -abs(r["quantity"]))
    total = len(rows)
    notes = []
    if top_n and top_n > 0 and total > top_n:
        notes.append(f"{total - top_n} more not shown; narrow them with 'query' or raise 'top_n'.")
        rows = rows[:top_n]
        if scope == "all":
            notes.append(
                "These rows are the whole supply chain, background included; for the model's own recipe pass "
                "scope='foreground'."
            )
    elif q and not total:
        notes.append(f"No dataset name or reference product contains '{query.strip()}'.")
    out = {
        "activity": {"database": act.key[0], "code": act.key[1], "name": act.get("name")},
        "amount": amount,
        "scope": scope,
        "total_entries": total,
        "note": " ".join(notes) or None,
        "inventory": rows,
    }
    if scope == "foreground":
        out["reading"] = (
            "Rows of kind 'model' or 'library' are the model's processes with their output per functional unit; "
            "rows of kind 'background' are the datasets those processes draw on directly, with the amount they "
            "draw. What the background uses of the same product on top is not included — scope='all' gives "
            "the total through the whole supply chain."
        )
    return out
