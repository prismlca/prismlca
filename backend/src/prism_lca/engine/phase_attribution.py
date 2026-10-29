"""Exact attribution of a result to tag values — the per-phase breakdown.

A tag acts on the whole supply chain below the place it sits, until a nearer tag takes over. It sits on a
process of a model or on one input (exchange) of such a process (see :mod:`prism_lca.engine.tag_scope`). At
every step from a consumer X over an input e to a supplier Y the effective value is
``tag(e) or own_tag(Y) or value(X)``.

The contribution tree used to carry this rule. It is pruned (cutoff, depth) and stops at a repeated node, so
its *total* was exact but its *split* was not: a foreground cycle booked the repeated node's remainder to one
phase, and a tag below a pruned subtree was never seen. Here the foreground is solved instead. The unknowns
are the runs of every (activity, value) state reachable from the root; inputs from the background are lumped
through the adjoint unit impacts the caller already has, so the background costs nothing extra. A foreground
has a few dozen processes and a handful of values, so the system is small and solved densely.

The zone that is solved is every model and the library: the library carries no tags, but its processes pass
on the value of the model that uses them and may lead back into a model. Background inventories are lumped.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from prism_lca.engine.tag_scope import LIBRARY, MODEL, kind_checker
from prism_lca.engine.tags import TagStore
from prism_lca.errors import PrismError

#: The group of everything no tag reaches. Same spelling as the tree's residual group.
UNTAGGED = "(untagged)"
#: A group below this share of the score is noise. A process's own part is its cumulative impact minus its
#: inputs' (``direct_per_run``); for a process that emits nothing itself — a functional-unit node — the
#: difference is solver noise of about 1e-8 of the score, and shown as a group it reads as "something is
#: untagged" in a model where everything is tagged. One part in a million is below anything a chart can show.
NOISE_SHARE = 1e-6
#: Beyond this the state system is too close to singular for its split to mean anything.
MAX_CONDITION = 1e12


@dataclass
class _Input:
    supplier: object  # a bw2data activity
    #: Product units per run of the consumer, signed as the matrix sees them: a substitution counts as a
    #: negative input, so a process's direct part is its own emissions and nothing else.
    amount: float
    uid: str | None


@dataclass
class _Node:
    act: object
    production: float
    inputs: list[_Input] = field(default_factory=list)


class Foreground:
    """The zone reachable from a root, read once and reused for every dimension and method.

    ``unit_impacts(activity_id)`` returns the cumulative impact of one product unit, one entry per method
    (the adjoint lookup of :mod:`prism_lca.engine.lca`). ``production_amount`` is the reference-flow amount
    of an activity (negative for treatments), the same helper the tree uses.
    """

    def __init__(self, root, unit_impacts: Callable, production_amount: Callable, tag_map: dict | None = None):
        self.root = root
        self.unit_impacts = unit_impacts
        self.tag_map = TagStore().load_map() if tag_map is None else tag_map
        self.kind = kind_checker()
        self.nodes: dict[int, _Node] = {}
        if self.solved(root):
            stack = [root]
            while stack:
                act = stack.pop()
                if act.id in self.nodes:
                    continue
                node = self._read(act, production_amount)
                for inp in node.inputs:
                    if self.solved(inp.supplier) and inp.supplier.id not in self.nodes:
                        stack.append(inp.supplier)
                self.nodes[act.id] = node

    def solved(self, act) -> bool:
        return self.kind(act.key[0]) in (MODEL, LIBRARY)

    def _read(self, act, production_amount: Callable) -> _Node:
        node = _Node(act=act, production=production_amount(act))
        products = 0
        for ex in act.exchanges():
            kind = ex.get("type")
            amount = float(ex.get("amount") or 0.0)
            if kind == "production":
                products += amount != 0.0
            elif kind == "technosphere":
                node.inputs.append(_Input(ex.input, amount, ex.get("prism_uid")))
            elif kind == "substitution":
                node.inputs.append(_Input(ex.input, -amount, ex.get("prism_uid")))
        if products > 1:
            raise PrismError(
                f"'{act.get('name')}' has {products} production exchanges; the breakdown by tag needs one "
                "reference product per process.",
                code="phase_split_multi_output",
                hint="Split the process into one process per product, or allocate it, before breaking the "
                "result down by tag.",
                status_code=422,
            )
        return node

    def own_tag(self, act, dimension: str) -> str | None:
        if self.kind(act.key[0]) != MODEL:
            return None
        return TagStore.value_from(self.tag_map, act.key[0], act.key[1], dimension)

    def input_tag(self, consumer, uid: str | None, dimension: str) -> str | None:
        if not uid or self.kind(consumer.key[0]) != MODEL:
            return None
        code = TagStore.exchange_code(consumer.key[1], uid)
        return TagStore.value_from(self.tag_map, consumer.key[0], code, dimension)

    def unit(self, act_id: int) -> np.ndarray:
        return np.asarray(self.unit_impacts(act_id), dtype=float)

    def direct_per_run(self, node: _Node) -> np.ndarray:
        """What one run of ``node`` causes beyond its inputs: its own emissions. Taken from the same unit
        impacts the inputs are, so the breakdown adds up to the score by construction."""
        out = node.production * self.unit(node.act.id)
        for inp in node.inputs:
            out = out - inp.amount * self.unit(inp.supplier.id)
        return out


@dataclass
class Attribution:
    """One dimension, solved: the impact per value, the runs per (activity id, value) state, and per value
    the lumped background demand (product units per background activity id)."""

    groups: dict[str, np.ndarray]
    runs: dict[tuple[int, str | None], float]
    background_demand: dict[str | None, dict[int, float]]
    #: Impact per uid of the root model's direct inputs from outside it, summed over all values — what a
    #: canvas box of those inputs carries (one entry per method).
    inputs: dict[str, np.ndarray]


def attribute(fg: Foreground, dimension: str | None, root_amount: float, n_methods: int) -> Attribution:
    """Split the score of ``root_amount`` product units of the root by the values of ``dimension``.

    ``dimension=None`` solves the runs without any split (one state per activity). Raises when the system is
    singular or the parts do not add up to the score: a wrong split must never be shown as a result.
    """
    root = fg.root
    total = root_amount * fg.unit(root.id)
    if root.id not in fg.nodes:  # a background dataset as the root: one lump, no tags can reach it
        return Attribution({UNTAGGED: total}, {}, {None: {root.id: root_amount}}, {})

    def tag_in(consumer, inp) -> str | None:
        return fg.input_tag(consumer, inp.uid, dimension) if dimension else None

    def own(act) -> str | None:
        return fg.own_tag(act, dimension) if dimension else None

    index: dict[tuple[int, str | None], int] = {}
    order: list[tuple[int, str | None]] = []
    links: list[tuple[int, int, float]] = []  # (parent state, child state, child runs per parent run)
    #: Inputs of the root model that come from another solved database (library, other model):
    #: (state, supplier id, product amount per run, uid) — their canvas box carries the supplier's chain.
    solved_inputs: list[tuple[int, int, float, str]] = []
    ends: list[tuple[int, str | None, int, float, str | None]] = []  # (state, value, bg id, amount, uid)

    def state(act_id: int, value: str | None) -> int:
        key = (act_id, value)
        if key not in index:
            index[key] = len(order)
            order.append(key)
        return index[key]

    root_db = root.key[0]
    start = state(root.id, own(root))
    i = 0
    while i < len(order):
        act_id, value = order[i]
        node = fg.nodes[act_id]
        for inp in node.inputs:
            child_value = tag_in(node.act, inp)
            sup = inp.supplier
            if sup.id in fg.nodes:
                child_value = child_value or own(sup) or value
                links.append((i, state(sup.id, child_value), inp.amount / fg.nodes[sup.id].production))
                if inp.uid and node.act.key[0] == root_db and sup.key[0] != root_db:
                    solved_inputs.append((i, sup.id, inp.amount, inp.uid))
            else:
                ends.append((i, child_value or value, sup.id, inp.amount, inp.uid))
        i += 1

    n = len(order)
    system = np.eye(n)
    for parent, child, coef in links:
        system[child, parent] -= coef
    rhs = np.zeros(n)
    rhs[start] = root_amount / fg.nodes[root.id].production
    runs = _solve(system, rhs)

    groups: dict[str, np.ndarray] = {}
    magnitude = np.zeros(n_methods)

    def book(value: str | None, amount: np.ndarray) -> None:
        nonlocal magnitude
        key = value or UNTAGGED
        groups[key] = groups.get(key, np.zeros(n_methods)) + amount
        magnitude = magnitude + np.abs(amount)

    direct: dict[int, np.ndarray] = {}
    for k, (act_id, value) in enumerate(order):
        if act_id not in direct:
            direct[act_id] = fg.direct_per_run(fg.nodes[act_id])
        book(value, runs[k] * direct[act_id])
    demand: dict[str | None, dict[int, float]] = {}
    inputs: dict[str, np.ndarray] = {}
    for k, value, bg_id, amount, uid in ends:
        part = runs[k] * amount * fg.unit(bg_id)
        book(value, part)
        per_value = demand.setdefault(value, {})
        per_value[bg_id] = per_value.get(bg_id, 0.0) + runs[k] * amount
        if uid and fg.nodes[order[k][0]].act.key[0] == root_db:
            inputs[uid] = inputs.get(uid, np.zeros(n_methods)) + part
    for k, sup_id, amount, uid in solved_inputs:
        inputs[uid] = inputs.get(uid, np.zeros(n_methods)) + runs[k] * amount * fg.unit(sup_id)

    summed = sum(groups.values(), np.zeros(n_methods))
    tolerance = 1e-9 * np.maximum(np.abs(total), magnitude) + 1e-12
    if np.any(np.abs(summed - total) > tolerance):
        raise PrismError(
            "The breakdown by tag does not add up to the score.",
            code="phase_split_mismatch",
            hint=f"Parts {summed.tolist()} against the score {total.tolist()}. Please report this model.",
            status_code=500,
        )
    return Attribution(groups, {order[k]: float(runs[k]) for k in range(n)}, demand, inputs)


def _solve(system: np.ndarray, rhs: np.ndarray) -> np.ndarray:
    singular = PrismError(
        "The foreground cannot be split by tags: a supply loop leaves the runs undetermined.",
        code="phase_split_singular",
        hint="A process that consumes as much of itself as it makes, directly or through a loop, has no "
        "defined output on its own. Check the loop's amounts.",
        status_code=422,
    )
    try:
        if np.linalg.cond(system) > MAX_CONDITION:
            raise singular
        runs = np.linalg.solve(system, rhs)
    except np.linalg.LinAlgError as exc:
        raise singular from exc
    if np.linalg.norm(system @ runs - rhs) > 1e-9 * max(np.linalg.norm(rhs), 1e-12):
        raise singular
    return runs


def phase_flows(database: str, code: str, method, dimension: str, value: str, amount: float = 1.0,
                top_n: int = 20) -> dict:
    """The characterised elementary flows of ONE tag value, in the format of ``lca.elementary_flows``.

    The background part is one inventory of the value's lumped background demand; the foreground part is
    the own elementary flows of the states carrying the value."""
    from prism_lca.engine import lca as _lca
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.model import get_activity

    bd = get_bd()
    m = _lca.resolve_method(method)
    root = get_activity(database, code)
    target = None if value == UNTAGGED else value
    with _lca._LCA_LOCK:
        lca = _lca.get_lca({root.id: 1.0}, m)
        cf = np.asarray(lca.characterization_matrix.sum(axis=0)).ravel()
        unit_all = _lca._adjoint_unit_impacts(lca, [(m, cf)])
        prod_ix = lca.dicts.product
        fg = Foreground(root, lambda nid: unit_all[prod_ix[nid]], _lca._production_amount)
        att = attribute(fg, dimension, amount * _lca._demand_sign(root), 1)
        phase_total = float(att.groups.get(value, np.zeros(1))[0])
        bio_ix = lca.dicts.biosphere
        rows = np.zeros(len(bio_ix))
        demand = {k: v for k, v in (att.background_demand.get(target) or {}).items() if v}
        if demand:
            lca = _lca.get_lca(demand, m)
            rows += np.asarray(lca.characterized_inventory.sum(axis=1)).ravel()
        for (act_id, v), r in att.runs.items():
            if v != target or not r:
                continue
            for ex in fg.nodes[act_id].act.biosphere():
                row = bio_ix.get(ex.input.id)
                if row is not None:
                    rows[row] += r * float(ex.get("amount") or 0.0) * cf[row]
        reverse = {v: k for k, v in bio_ix.items()}
    flows = _lca.flow_rows(bd, rows, reverse, phase_total)
    return {
        "database": root.key[0],
        "code": root.key[1],
        "method": list(m),
        "unit": bd.methods[m].get("unit", ""),
        "phase": {"dimension": dimension, "value": value},
        "total": _lca._sig(phase_total),
        "count": len(flows),
        "flows": flows if top_n <= 0 else flows[:top_n],
    }
