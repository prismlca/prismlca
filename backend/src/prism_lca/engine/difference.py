"""Why a result differs from another: each side scored, its system read, the difference split onto the
changes and the changes named, largest first.

The two sides are a model and one of its scenarios (or two scenarios), or a model and a copy of it. Both are
scored the ordinary way — :func:`lca.compute_lcia` inside the scenario window — and read while they are the
factorised system, so the split is the split of exactly the numbers a comparison shows. The arithmetic is in
:mod:`difference_terms`, the pairing of two models' processes in :mod:`difference_pairing`.
"""
from __future__ import annotations

from prism_lca.engine import difference_pairing, lca, method_lookup, scenarios
from prism_lca.engine import difference_terms as terms
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.lca import _sig
from prism_lca.engine.model import get_activity
from prism_lca.errors import PrismError

#: How many changes an indicator names before it sums the rest.
TOP_N = 10

_KIND = {"technosphere": "input", "substitution": "credit", "production": "production", "biosphere": "elementary flow"}


def explain(
    store,
    database: str,
    code: str,
    methods: list,
    *,
    amount: float = 1.0,
    scenario_ids: list[str | None] | None = None,
    against: dict | None = None,
    partial: bool = False,
    top_n: int = TOP_N,
) -> dict:
    """Split the difference of ``code`` (under each of ``scenario_ids``; None or "" is the model as it stands)
    against a reference: the same process as it stands, or ``against`` — ``{database?, code?, scenario?,
    amount?}``, where another model's process is found by pairing when its code is left out."""
    not_computed: list[dict] = []
    if partial:
        methods, not_computed = method_lookup.resolve_methods(methods)
        if not methods:
            raise method_lookup.none_resolved(not_computed)
        methods = list(dict.fromkeys(methods))
    else:
        methods = [method_lookup.resolve_method(m) for m in methods]
    if not methods:
        raise PrismError("No LCIA method specified.", code="no_method",
                         hint="Pass the indicators to split, as method tuples from list_methods.")
    act = get_activity(database, code)
    database, code = act.key
    variants = [s or None for s in (scenario_ids or [None])]
    ref_db, ref_code, ref_scenario, ref_amount, pairing = _reference(act, amount, against or {})
    if ref_db == database and ref_code == code and ref_amount == amount and all(v == ref_scenario for v in variants):
        raise PrismError(
            "Nothing to compare: the result and its reference are the same.",
            code="difference_same",
            hint='Pass a scenario of the model ("scenario"), or the model it was copied from ("against").',
        )
    store.require(database, [v for v in variants if v])
    if ref_scenario:
        store.require(ref_db, [ref_scenario])

    bd = get_bd()
    names = _Names(bd)
    generation = lca.model_generation()
    with lca._LCA_LOCK:
        reference = _read(store, ref_db, ref_code, ref_scenario, methods, ref_amount, reference=True)
        results = []
        for sid in variants:
            subject = _read(store, database, code, sid, methods, amount, reference=False)
            placing = terms.place(reference, subject, pairing.nodes if pairing else None)
            moved = terms.move(reference, subject, placing)
            blocks = []
            for m in methods:
                part = terms.split(reference, subject, moved, m)
                blocks.append(_block(part, m, bd, names, reference, moved, top_n, database))
            item = {"subject": _who(act, sid, amount, store)}
            if placing.set_aside_runs > 0:
                item["note"] = (
                    "This model uses processes of the reference model itself, so part of the difference "
                    "cannot be placed on a change."
                )
            item["indicators"] = blocks
            results.append(item)
    if lca.model_generation() != generation:
        raise PrismError(
            "The model changed while the difference was being computed.",
            code="difference_moved",
            hint="Ask again once the change has landed.",
        )
    out: dict = {"reference": _who(get_activity(ref_db, ref_code), ref_scenario, ref_amount, store)}
    if pairing is not None:
        out["pairing"] = pairing.summary()
    out["results"] = results
    if not_computed:
        out["not_computed"] = not_computed
    return out


def _reference(act, amount: float, against: dict):
    """``(database, code, scenario, amount, pairing)`` of what the subject is compared with."""
    from prism_lca.engine.model import resolve_db_name

    database = act.key[0]
    ref_db = resolve_db_name(str(against.get("database") or database))
    ref_scenario = against.get("scenario") or None
    ref_amount = float(against.get("amount") or amount)
    if ref_db == database:
        given = against.get("code")
        if given and given != act.key[1]:
            raise PrismError(
                "The reference is another process of the same model; a difference can be split only between "
                "a model and its scenarios, or a model and its copy.",
                code="difference_unpaired",
                hint='Compare two processes with explain_result mode="tree" for each, or leave "code" out of '
                '"against".',
            )
        return database, act.key[1], ref_scenario, ref_amount, None
    if ref_db not in get_bd().databases:
        raise PrismError(f"There is no model '{ref_db}'.", code="database_not_found", status_code=404,
                         hint="Model names come from list_models.")
    pairing = difference_pairing.pair(database, ref_db)
    ref_code = against.get("code")
    if not ref_code:
        node = pairing.nodes.get(act.id)
        if node is None:
            raise PrismError(
                f"'{act.get('name')}' has no counterpart in '{ref_db}'.",
                code="difference_unpaired",
                hint=f'Name the process to compare with: "against": {{"database": "{ref_db}", "code": "…"}}.',
            )
        ref_code = get_bd().get_node(id=node).key[1]
    return ref_db, str(ref_code), ref_scenario, ref_amount, pairing


def _read(store, database: str, code: str, scenario: str | None, methods: list, amount: float,
          reference: bool) -> terms.Side:
    """Score one side for every indicator inside its scenario window, and read its system as it is scored."""
    recorder = terms.Recorder(reference=reference)
    with scenarios.applied(store, database, scenario):
        for m in methods:
            lca.compute_lcia(database, code, m, amount, observe=recorder)
    assert recorder.side is not None
    return recorder.side


def _who(act, scenario: str | None, amount: float, store) -> dict:
    out = {"database": act.key[0], "code": act.key[1], "name": act.get("name")}
    if scenario:
        out["scenario"] = store.get(scenario, act.key[0])["name"]
    out["amount"] = amount
    return out


class _Names:
    """Node names, read once each."""

    def __init__(self, bd) -> None:
        self.bd = bd
        self._nodes: dict[int, object] = {}

    def node(self, node_id: int):
        if node_id not in self._nodes:
            try:
                self._nodes[node_id] = self.bd.get_node(id=node_id)
            except Exception:  # noqa: BLE001 - a node gone since the read is named by its id
                self._nodes[node_id] = None
        return self._nodes[node_id]

    def name(self, node_id: int) -> str:
        node = self.node(node_id)
        if node is None:
            return f"#{node_id}"
        name = str(node.get("name") or node.key[1])
        categories = node.get("categories")
        if categories and node.get("type") not in (None, "process"):
            name += f" ({', '.join(categories)})"
        return name


def _block(part: terms.Split, method: tuple, bd, names: _Names, ref: terms.Side, moved: terms.Moved,
           top_n: int, subject_db: str) -> dict:
    """One indicator: the scores, the difference, its largest changes named, and what they leave over."""
    placing = moved.placing
    col_ref = {c: node for node, c in ref.activity.items()}
    row_ref = {r: node for node, r in ref.product.items()}
    flow_ref = {k: node for node, k in ref.flow.items()}

    def process(j: int) -> int:
        return placing.col_node.get(int(j), col_ref.get(int(j), -1))

    def product(i: int) -> int:
        return placing.row_node.get(int(i), row_ref.get(int(i), -1))

    def flow(k: int) -> int:
        return placing.flow_node.get(int(k), flow_ref.get(int(k), -1))

    rows: list[tuple[float, dict]] = []
    zero = 0
    ti, tj, tb, ta, tc = part.tech
    for i, j, before, after, term in zip(ti, tj, tb, ta, tc, strict=True):
        if term == 0.0:
            zero += 1
            continue
        rows.append((float(term), {"t": "tech", "process": process(j), "input": product(i), "before": float(before),
                                   "after": float(after), "runs": float(moved.runs[j]),
                                   "was": (col_ref.get(int(j), -1), row_ref.get(int(i), -1))}))
    bi, bj, bb, ba, bc = part.bio
    for k, j, before, after, term in zip(bi, bj, bb, ba, bc, strict=True):
        if term == 0.0:
            zero += 1
            continue
        rows.append((float(term), {"t": "bio", "process": process(j), "input": flow(k),
                                   "before": float(before), "after": float(after), "runs": float(moved.runs[j]),
                                   "was": (col_ref.get(int(j), -1), flow(k))}))
    for node1, node0, before, after, term in part.demand:
        if term != 0.0:
            rows.append((float(term), {"t": "demand", "process": node1 if node1 >= 0 else node0,
                                       "before": before, "after": after}))
    fk, fb, fa, fc = part.factors
    for k, before, after, term in zip(fk, fb, fa, fc, strict=True):
        if term != 0.0:
            rows.append((float(term), {"t": "factor", "input": flow(k), "before": float(before),
                                       "after": float(after)}))
    rows.sort(key=lambda r: -abs(r[0]))

    delta = part.delta
    same = abs(delta) <= terms.EXACT_RTOL * max(abs(part.reference), abs(part.subject))
    block: dict = {
        "method": list(method),
        "unit": bd.methods[method].get("unit", ""),
        "reference_score": part.reference,
        "score": part.subject,
        "delta": delta,
    }
    if part.reference:
        block["delta_pct"] = _sig(100.0 * delta / abs(part.reference), 4)
    block["changes"] = [_change(term, row, delta, same, names, subject_db) for term, row in rows[:top_n]]
    if len(rows) > top_n:
        rest = sum(term for term, _row in rows[top_n:])
        block["more"] = {"count": len(rows) - top_n, "contribution": _sig(rest)}
    block["not_explained"] = _sig(part.rest)
    block["exact"] = part.exact
    if zero:
        block["changed_without_effect"] = zero
    return block


def _change(term: float, row: dict, delta: float, same: bool, names: _Names, subject_db: str) -> dict:
    kind_of = row["t"]
    out: dict = {}
    if kind_of in ("tech", "bio"):
        proc = names.node(row["process"])
        out["process"] = names.name(row["process"])
        if proc is not None:
            out["process_code"] = proc.key[1]
            if proc.key[0] != subject_db:
                out["database"] = proc.key[0]
        out["exchange"] = names.name(row["input"])
        found = _exchange(proc, row["input"]) if proc is not None else None
        # The reference's own exchange where it is another process (a copy's original): an exchange the subject
        # removed is found only there, and one whose type changed has a type on each side.
        was_found = None
        if row["was"] != (row["process"], row["input"]) and row["was"][0] >= 0:
            was = names.node(row["was"][0])
            was_found = _exchange(was, row["was"][1]) if was is not None else None
        guess = "elementary flow" if kind_of == "bio" else "production" if row["process"] == row["input"] else "input"
        kind_after = _KIND.get((found or was_found or ("",))[0], guess)
        kind_before = _KIND.get((was_found or found or ("",))[0], guess)
        out["kind"] = kind_after if kind_before == kind_after else f"{kind_before} → {kind_after}"
        before, after = row["before"], row["after"]
        if kind_of == "tech":  # a consumed amount, as the exchange states it
            before = -before if kind_before == "input" else before
            after = -after if kind_after == "input" else after
        out["before"], out["after"] = _sig(before), _sig(after)
        node = names.node(row["input"])
        if kind_of == "tech" and node is not None and node.get("location"):
            # Two suppliers of one product differ by their location only (a market for RER and one for RoW).
            out["location"] = node.get("location")
        if node is not None and node.get("unit"):
            out["unit"] = node.get("unit")
        if found and found[1]:
            out["formula"] = found[1]
        out["runs"] = _sig(row["runs"])
    elif kind_of == "demand":
        out["process"] = names.name(row["process"])
        out["kind"] = "functional unit"
        out["before"], out["after"] = _sig(row["before"]), _sig(row["after"])
    else:
        out["exchange"] = names.name(row["input"])
        out["kind"] = "characterisation factor"
        out["before"], out["after"] = _sig(row["before"]), _sig(row["after"])
    out["contribution"] = _sig(term)
    if not same:
        out["share_pct"] = _sig(100.0 * term / delta, 3)
    return out


def _exchange(proc, input_id: int) -> tuple[str, str | None] | None:
    """``(type, formula)`` of the process's one exchange from ``input_id``; None when there is none, or when
    several share the pair (the matrix holds their sum)."""
    try:
        found = [ex for ex in proc.exchanges() if ex.input.id == input_id]
    except Exception:  # noqa: BLE001 - an input the database no longer has: named without its exchange
        return None
    if len(found) != 1:
        return (found[0].get("type"), None) if found and len({ex.get("type") for ex in found}) == 1 else None
    ex = found[0]
    return ex.get("type"), (ex.get("formula") or None)
