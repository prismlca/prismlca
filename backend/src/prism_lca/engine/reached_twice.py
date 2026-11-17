"""A foreground process that takes one input twice: directly, and again through another step of its own chain.

Vertrieb consumes the wheelbarrow's tray, and Vertrieb also consumes Endmontage, which consumes the tray as
well. Each link checks out, the model computes, and the tray is in the result twice. It is what re-wiring
leaves behind when a step is put in between (or a process is moved up) and the old link is not removed:
a total at twice its value that still looks plausible.

A part used at two levels on purpose has the same shape: screws in the final assembly and in the wheel
beneath it. What tells the leftover apart is the amount. A link left standing beside its new route carries
the same quantity as that route, because it *is* the same quantity; a part really used twice almost never
matches to the last digit. So only a direct link whose amount equals what the route through the other step
brings per run of the upper process counts — the route's amounts multiplied down the chain, each step scaled
by its own output, so an inserted step that makes two wheels per barrow still compares like with like.

Only processes of the model itself: a background dataset taken at several levels (electricity in the
assembly and in the subassembly) is ordinary and is never a route of the model's own.
"""
from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass

from prism_lca import _log
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.model import _db_or_404

#: Relative difference under which two amounts are the same quantity — typed 0.333 against a computed 1/3.
REL_TOL = 1e-3


@dataclass
class Flows:
    """The model's links between its own processes, with their amounts."""

    #: consumer -> provider -> [(exchange uid, amount)]; providers of the model only, no link to itself.
    links: dict[tuple, dict[tuple, list[tuple[str | None, float]]]]
    #: process -> how much of its reference product one run makes, less what it consumes of it itself.
    output: dict[tuple, float]


@dataclass(frozen=True)
class Twice:
    """`upper` takes `provider` directly and, with the same amount, through `through`."""

    upper: tuple
    through: tuple
    provider: tuple
    #: The direct links that make the matching amount — one, or all of them when only their sum matches.
    uids: tuple[str | None, ...]
    amount: float
    #: The links from `through` to the provider.
    through_uids: tuple[str | None, ...]
    #: upper → … → through, the shortest way down.
    route: tuple[tuple, ...]


def flows_of(database: str, activities: Iterable[tuple[tuple, Iterable]]) -> Flows:
    """Read the links from ``(activity key, exchanges)`` pairs — the linter's context or the database."""
    links: dict[tuple, dict[tuple, list[tuple[str | None, float]]]] = {}
    output: dict[tuple, float] = {}
    for akey, exchanges in activities:
        akey = tuple(akey)
        mine = links.setdefault(akey, {})
        made, used = None, 0.0
        for ex in exchanges:
            kind = ex.get("type")
            if kind == "production":
                made = float(ex.get("amount") or 0) if made is None else made
                continue
            key = ex.get("input")
            if kind != "technosphere" or not key or key[0] != database:
                continue
            if tuple(key) == akey:
                # Consuming its own product: the matrix nets it off the output, and so do we — a step
                # that eats half of what it makes has to run twice per unit handed on.
                used += float(ex.get("amount") or 0)
                continue
            mine.setdefault(tuple(key), []).append((ex.get("prism_uid"), float(ex.get("amount") or 0)))
        output[akey] = (1.0 if made is None else made) - used
    return Flows(links=links, output=output)


def read_flows(database: str) -> Flows:
    db = get_bd().Database(database)
    return flows_of(database, ((act.key, act.exchanges()) for act in db))


def _runs_below(top: tuple, flows: Flows) -> dict[tuple, float] | None:
    """How often each process under `top` runs per run of `top`, over every route; None if a loop is below."""
    order: list[tuple] = []
    state = {top: 1}  # 1 = on the way down, 2 = done
    stack = [(top, iter(flows.links.get(top, {})))]
    while stack:
        node, children = stack[-1]
        child = next(children, None)
        if child is None:
            stack.pop()
            state[node] = 2
            order.append(node)
        elif state.get(child) == 1:
            return None  # the circular-link check speaks for it
        elif child not in state:
            state[child] = 1
            stack.append((child, iter(flows.links.get(child, {}))))
    runs: dict[tuple, float] = {top: 1.0}
    for node in reversed(order):  # every process after all of its consumers
        here = runs.get(node, 0.0)
        if not here:
            continue
        for child, rows in flows.links.get(node, {}).items():
            out = flows.output.get(child, 1.0)
            if out:
                runs[child] = runs.get(child, 0.0) + here * sum(a for _, a in rows) / out
    return runs


def _route(top: tuple, target: tuple, flows: Flows) -> tuple[tuple, ...]:
    came_from: dict[tuple, tuple | None] = {top: None}
    queue = [top]
    for node in queue:
        if node == target:
            break
        for child in flows.links.get(node, {}):
            if child not in came_from:
                came_from[child] = node
                queue.append(child)
    path: list[tuple] = []
    step: tuple | None = target
    while step is not None:
        path.append(step)
        step = came_from.get(step)
    return tuple(reversed(path))


def _matching(
    rows: list[tuple[str | None, float]], via: float
) -> tuple[tuple[str | None, ...], float] | None:
    """The direct links that carry the route's amount: one of them, or all together when only the sum does.

    One link alone counts only while all of them point the same way: beside a credit of -1, a +1 is not a
    second unit of anything, and naming it for removal would take the part out altogether.
    """
    candidates: list[tuple[tuple[str | None, ...], float]] = []
    if len({a > 0 for _, a in rows if a}) <= 1:
        candidates = [((uid,), a) for uid, a in rows]
    if len(rows) > 1:
        candidates.append((tuple(uid for uid, _ in rows), sum(a for _, a in rows)))
    return next((c for c in candidates if c[1] and math.isclose(c[1], via, rel_tol=REL_TOL)), None)


def reached_twice(flows: Flows) -> list[Twice]:
    """Every (upper, through, provider) whose direct link carries what the route through `through` does."""
    consumers: dict[tuple, set[tuple]] = {}
    for consumer, providers in flows.links.items():
        for provider in providers:
            consumers.setdefault(provider, set()).add(consumer)
    out: list[Twice] = []
    for upper in sorted(flows.links):
        shared = sorted(p for p in flows.links[upper] if len(consumers.get(p, ())) > 1)
        runs = _runs_below(upper, flows) if shared else None
        if not runs:
            continue
        for provider in shared:
            for through in sorted(consumers[provider] - {upper}):
                if not runs.get(through):
                    continue  # not under `upper`: two phases sharing a step, which is fine
                rows = flows.links[through][provider]
                via = runs[through] * sum(a for _, a in rows)
                hit = _matching(flows.links[upper][provider], via)
                if hit:
                    route = _route(upper, through, flows)
                    lower = tuple(uid for uid, _ in rows)
                    out.append(Twice(upper, through, provider, hit[0], hit[1], lower, route))
    return out


def _below(flows: Flows) -> dict[tuple, set[tuple]]:
    """Every process with all it reaches, itself included."""
    memo: dict[tuple, set[tuple]] = {}
    for start in flows.links:
        seen, queue = {start}, [start]
        for node in queue:
            for child in flows.links.get(node, {}):
                if child not in seen:
                    seen.add(child)
                    queue.append(child)
        memo[start] = seen
    return memo


def touched_by(twice: Twice, link: tuple[tuple, tuple], flows: Flows, below: dict[tuple, set[tuple]]) -> bool:
    """Whether `link` (consumer, provider) is the direct link of `twice` or lies on its route."""
    a, b = link
    if b == twice.provider and a in (twice.upper, twice.through):
        return True
    return (
        b in flows.links.get(a, {})
        and a in below.get(twice.upper, ())
        and twice.through in below.get(b, ())
    )


def report(database: str, touching: list[tuple[str, str]] | None = None) -> list[dict]:
    """The doubles a caller's new links are part of, by name and amount, with the uids of both links.

    `touching` holds (consumer code, provider code) pairs; empty means every double in the model.
    """
    bd = get_bd()
    database = _db_or_404(bd, database)
    flows = read_flows(database)
    found = reached_twice(flows)
    if touching:
        below = _below(flows)
        links = [((database, a), (database, b)) for a, b in touching]
        found = [t for t in found if any(touched_by(t, link, flows, below) for link in links)]

    names: dict[tuple, dict] = {}

    def node(key: tuple) -> dict:
        if key not in names:
            try:
                act = bd.get_node(database=key[0], code=key[1])
                names[key] = {"name": act.get("name") or key[1], "unit": act.get("unit") or ""}
            except Exception as exc:  # a link to a deleted process still has its code
                _log.swallowed(exc, "reached_twice.report")
                names[key] = {"name": key[1], "unit": ""}
        return names[key]

    return [
        {
            "process": node(t.upper)["name"],
            "input": node(t.provider)["name"],
            "unit": node(t.provider)["unit"],
            "amount": t.amount,
            "direct_uids": list(t.uids),
            "also_through": " → ".join(node(k)["name"] for k in (*t.route, t.provider)),
            "through_uids": list(t.through_uids),
        }
        for t in found
    ]
