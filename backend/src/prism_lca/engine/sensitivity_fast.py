"""Scores of a model under changed parameter values, computed without writing the model.

A sensitivity step used to write its values into the model, let Brightway recalculate the parameterised
exchanges and reprocess the database, and solve the whole technosphere again: about three seconds of
writing and one and a half of solving per step, with the LCA lock held for the whole run, so no other
calculation and no parameter edit could land in between. This module computes the same numbers from the
system the model already has, and holds the lock only while it reads it.

**Why it is exact, not an approximation.** A parameter of a model moves only exchanges of that model's own
processes: columns F of the technosphere A and the biosphere B. Split rows and columns into F and the rest
R. When no process in R uses a product of F (``A[F, R] = 0``; a process outside that does is taken into F,
see :func:`_block`), the demand of a model process solves as

    A_FF · x_F = f,     score = Σ_j x_j · ((c·B)_j − (u_R · A_RF)_j)

where ``u = c·B·A⁻¹`` are the cumulative impacts of one unit of every product of the unchanged system —
one transposed solve per indicator (:func:`lca._adjoint_unit_impacts`) — and its R part does not depend on
anything in F. A step changes only the model's columns, so it costs one solve over the block and a few dot
products.

**A step's columns are the ones the write would have produced, to the bit.** The model's parameters are
evaluated under the step's overrides by :func:`params.evaluate_overrides`, the parameter set the
recalculation runs; every parameterised exchange of the model's groups (:func:`params.model_groups`) is
evaluated again by the same interpreter, in the same namespace, as ``ActivityParameter.recalculate_exchanges``
does. Then the columns are assembled the way Brightway assembles them: every exchange of the model as one
entry, in single precision (the processed database keeps amounts as float32, so 0.05 sits in the matrix as
0.0500000007), sorted the way bw_processing sorts the arrays it writes (on every field, amount first — so
several exchanges on one pair are summed in an order their amounts decide), inputs negated, and summed by the
function the matrix builder uses (``matrix_utils.aggregation``). Brightway's own functions build the records
and the order (:meth:`_Entries.assemble`). Each piece was measured: computed at full precision, a step drifted
from the written result by up to 3e-8 of the score, and exchanges on one pair summed in another order by more.

**Anything outside that picture leaves the run to the write path** (:func:`build` returns None): activity
parameters with formulas, a group whose namespace chains other groups, a parameterised exchange of a process
outside the model or one that no longer exists, a model whose processes and products do not pair up. And
before a run uses the path, the starting point is checked three ways: the formulas give the stored amounts,
the rebuilt columns equal the factorised system's bit for bit, and the block's score equals the factorised
score to rounding.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from prism_lca import _log
from prism_lca.engine import lca, params
from prism_lca.errors import PrismError

#: How closely the starting point's score must agree with the factorised one — relative to the largest of
#: the terms it is summed from — before a run trusts this path. The two solvers differ in rounding only.
SELF_CHECK_RTOL = 1e-9
#: How closely the formulas, evaluated here at the starting point, must give the amounts Brightway stored.
AMOUNT_RTOL = 1e-12
#: Up to this many processes the block is solved as a dense matrix; above it, sparse.
DENSE_MAX = 800
#: The block (the model's processes and any outside process that uses one of their products) may not grow
#: past this; a model that large is written step by step.
BLOCK_MAX = 5000

#: Off: every run writes its steps into the model. The tests of the write path switch it off.
ENABLED = True


class _Unsupported(Exception):
    """The model holds something this path does not reproduce; the run writes its steps instead."""


@dataclass
class _Group:
    """One parameter group's formulas: its own interpreter, set up the way the recalculation sets it up."""

    interpreter: object
    #: The model parameters this group's formulas read from the model (its own activity parameters shadow
    #: a model parameter of the same name, as they do in the recalculation).
    overlay: list[str]
    trees: list
    #: Which of the run's parameterised exchanges these are.
    at: list[int]


@dataclass
class _Entries:
    """One matrix's share of the model as bw2data hands it to bw_processing: a record per exchange — its stored
    fields, its row and column node ids, whether it is flipped — and one per implicit production; and where those
    node ids land in the system's matrices."""

    data: list[dict]
    ids: list[tuple[int, int, bool]]
    rows_of: dict
    cols_of: dict

    def assemble(self, amounts: dict[int, float]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """``(rows, cols, values)`` of the matrix entries the records make with ``amounts`` (record index → new
        amount) put in. Built by Brightway's own functions, in its order: the record as
        ``SQLiteBackend.exchange_data_iterator`` yields it (``as_uncertainty_dict``), the sorted float32 arrays
        ``resolve_dict_iterator`` writes (sorted on every field, so equal amounts of opposite flip keep their
        order), negated where flipped and summed by ``aggregate_with_sparse``, as matrix_utils does."""
        from bw2data.utils import as_uncertainty_dict
        from bw_processing.utils import resolve_dict_iterator
        from matrix_utils.aggregation import aggregate_with_sparse

        if not self.data:
            empty = np.array([], dtype=np.int64)
            return empty, empty, np.array([], dtype=np.float64)
        records = []
        for i, (stored, (row, col, flip)) in enumerate(zip(self.data, self.ids, strict=True)):
            fields = {**stored, "amount": amounts[i]} if i in amounts else dict(stored)
            records.append({**as_uncertainty_dict(fields), "row": row, "col": col, "flip": flip})
        amount, indices, _distributions, flip, rescale = resolve_dict_iterator(records)
        try:
            rows = np.array([self.rows_of[int(x)] for x in indices["row"]], dtype=np.int64)
            cols = np.array([self.cols_of[int(x)] for x in indices["col"]], dtype=np.int64)
        except KeyError as exc:
            raise _Unsupported("an exchange of the model is in no matrix of the system") from exc
        data = np.array(amount)  # float32, as the package holds it
        data[np.asarray(flip, dtype=bool)] *= -1
        if rescale is not None:  # a record's own factor, applied after the flip as matrix_utils applies it
            data *= np.asarray(rescale, dtype=data.dtype)
        count = max(int(rows.max()), int(cols.max())) + 1
        r, c, v = aggregate_with_sparse(rows, cols, data, count)
        return np.asarray(r), np.asarray(c), np.asarray(v, dtype=np.float64)


class FastModel:
    """One subject of one model, ready to be scored under any set of parameter overrides.

    Built under the LCA lock by :func:`build`; everything it computes with afterwards is its own copy, so
    :meth:`scores` needs no lock and leaves the model, the cache and the solver alone."""

    def __init__(self, **parts) -> None:
        self.database: str = parts["database"]
        self.reference: list[float] = parts["reference"]
        self.base_values: dict[str, float] = parts["base_values"]
        self.namespace = parts["namespace"]
        self.groups: list[_Group] = parts["groups"]
        #: The parameterised exchanges: amount as stored, and where each sits in the two matrices (-1: not).
        self.stored: np.ndarray = parts["stored"]
        self.tech_slot: np.ndarray = parts["tech_slot"]
        self.bio_slot: np.ndarray = parts["bio_slot"]
        #: The subject's production exchanges in the order ``lca._demand_sign`` reads them: (parameterised exchange
        #: index or -1, stored amount). A step that turns the first non-zero one negative turns the demand round,
        #: as the write path's demand sign does.
        self.production: list[tuple[int, float]] = parts["production"]
        self.demand: float = parts["demand"]
        self.tech: _Entries = parts["tech"]
        self.bio: _Entries = parts["bio"]
        #: Matrix row/column → place in the block, -1 outside it.
        self.row_local: np.ndarray = parts["row_local"]
        self.col_local: np.ndarray = parts["col_local"]
        #: The block and the score coefficients with the model's own columns taken out — what stays put.
        self.a_fixed = parts["a_fixed"]
        self.coef_fixed: list[np.ndarray] = parts["coef_fixed"]
        self.f: np.ndarray = parts["f"]
        self.cf: list[np.ndarray] = parts["cf"]
        self.u: np.ndarray = parts["u"]

    def scores(self, overrides: dict) -> tuple[list[float], dict[str, float]]:
        """Every indicator, and every parameter's value, with ``overrides`` in the model.

        No overrides: the model as it stands — the factorised scores themselves, as the write path reads
        them without writing anything."""
        if not overrides:
            return list(self.reference), dict(self.base_values)
        # A scenario may still name a parameter the model has since lost; the write skips it, so do we.
        live = {k: v for k, v in overrides.items() if k in self.base_values}
        values = params.evaluate_overrides(self.database, live, self.namespace)
        amounts = self._amounts(values)
        tech, bio = self._amounts_in(amounts)
        return self._score(tech, bio, self._sign(amounts)), values

    def _sign(self, amounts: np.ndarray) -> float:
        """``lca._demand_sign`` of the subject at this step: −1 when its first non-zero production is negative."""
        for i, stored in self.production:
            amount = float(amounts[i]) if i >= 0 else stored
            if amount != 0.0:
                return -1.0 if amount < 0 else 1.0
        return 1.0

    def _amounts(self, values: dict[str, float]) -> np.ndarray:
        amounts = np.empty(len(self.stored))
        for group in self.groups:
            table = group.interpreter.symtable
            for name in group.overlay:
                table[name] = values[name]
            for i, tree in zip(group.at, group.trees, strict=True):
                try:
                    amounts[i] = float(group.interpreter.eval(tree, show_errors=False, raise_errors=True))
                except Exception as exc:  # noqa: BLE001 - asteval raises the formula's own error type
                    raise PrismError(
                        f"An exchange formula of this model cannot be evaluated at this step: {exc}",
                        code="formula_error",
                        hint="Narrow the range, or check the formulas that use this parameter "
                        "(a division by a value that reaches zero, for example).",
                    ) from exc
        return amounts

    def _amounts_in(self, amounts: np.ndarray) -> tuple[dict[int, float], dict[int, float]]:
        """Which record of each matrix takes which new amount."""
        tech = {int(slot): float(amounts[i]) for i, slot in enumerate(self.tech_slot) if slot >= 0}
        bio = {int(slot): float(amounts[i]) for i, slot in enumerate(self.bio_slot) if slot >= 0}
        return tech, bio

    def _columns(self, tech: dict[int, float], bio: dict[int, float]):
        """The block and the score coefficients with the model's columns assembled from these amounts."""
        r, c, v = self.tech.assemble(tech)
        lr, lc = self.row_local[r], self.col_local[c]
        inside = lr >= 0
        if isinstance(self.a_fixed, np.ndarray):
            a = self.a_fixed.copy()
            a[lr[inside], lc[inside]] = v[inside]
        else:
            from scipy.sparse import coo_matrix

            a = (self.a_fixed + coo_matrix((v[inside], (lr[inside], lc[inside])), shape=self.a_fixed.shape)).tocsc()
        rest = ~inside
        br, bc, bv = self.bio.assemble(bio)
        blc = self.col_local[bc]
        k = len(self.f)
        coef = [
            fixed
            + np.bincount(blc, weights=self.cf[m][br] * bv, minlength=k)
            - np.bincount(lc[rest], weights=self.u[r[rest], m] * v[rest], minlength=k)
            for m, fixed in enumerate(self.coef_fixed)
        ]
        return a, coef

    def _score(self, tech: dict[int, float], bio: dict[int, float], sign: float = 1.0) -> list[float]:
        a, coef = self._columns(tech, bio)
        x = _solve(a, self.f * (self.demand * sign))
        return [float(cm @ x) for cm in coef]


def _solve(a, f: np.ndarray) -> np.ndarray:
    try:
        if isinstance(a, np.ndarray):
            x = np.linalg.solve(a, f)
        else:
            from scipy.sparse.linalg import splu

            x = splu(a).solve(f)
    except (np.linalg.LinAlgError, RuntimeError) as exc:  # RuntimeError: SuperLU "exactly singular"
        raise _singular() from exc
    if not np.all(np.isfinite(x)):
        raise _singular()
    return x


def _singular() -> PrismError:
    return PrismError(
        "The model cannot be solved at this step: the values make its processes depend on each other "
        "without a way out (a production amount of zero, for example).",
        code="sensitivity_singular",
        hint="Narrow the range of the parameter, or keep it away from the value that removes a production.",
    )


def build(database: str, code: str, methods: list[tuple], amount: float) -> FastModel | None:
    """The fast path for this subject, or None when the run has to write its steps (see the module text).

    Reads the model, the factorised system and the unit impacts of every indicator under the LCA lock;
    the cost is one forward and one transposed solve per indicator, the price of the run's first step."""
    if not ENABLED:
        return None
    with lca._LCA_LOCK:
        generation = lca.cache_generation()
        try:
            fast = _build(database, code, methods, amount)
        except _Unsupported as exc:
            _log.swallowed(exc, "sensitivity_fast.build")
            return None
        if lca.cache_generation() != generation:  # an edit landed while we read: the parts may not match
            return None
        return fast


def _build(database: str, code: str, methods: list[tuple], amount: float) -> FastModel:
    from prism_lca.engine.model import get_activity

    act = get_activity(database, code)
    demand = {act.id: amount * lca._demand_sign(act)}
    system = None
    reference: list[float] = []
    cfs: list[np.ndarray] = []
    for m in methods:
        current = lca.get_lca(demand, m)
        if system is not None and current is not system:
            raise _Unsupported("the factorised system changed between two indicators")
        system = current
        reference.append(float(system.score))
        cfs.append(np.asarray(system.characterization_matrix.sum(axis=0), dtype=np.float64).ravel().copy())
    u = np.array(lca._adjoint_unit_impacts(system, list(zip(methods, cfs, strict=True))), dtype=np.float64)
    tech_matrix = system.technosphere_matrix.tocsc()
    bio_matrix = system.biosphere_matrix.tocsc()

    rows, cols, own = _block(system, tech_matrix.tocsr(), database)
    k = len(cols)
    row_local = np.full(tech_matrix.shape[0], -1)
    row_local[rows] = np.arange(k)
    col_local = np.full(tech_matrix.shape[1], -1)
    col_local[cols] = np.arange(k)
    tech_cols = tech_matrix[:, cols]
    a_ff = tech_cols[rows, :]
    f = np.zeros(k)  # the demand's place; scaled by the amount and the step's demand sign
    f[row_local[system.dicts.product[act.id]]] = 1.0

    # What stays put through every step: the block's columns of processes outside the model, and their
    # share of the score.
    keep = np.ones(k)
    keep[:own] = 0.0
    if k <= DENSE_MAX:
        a_fixed = a_ff.toarray() * keep
    else:
        from scipy.sparse import diags

        a_fixed = (a_ff @ diags(keep)).tocsc()
        a_fixed.eliminate_zeros()
    outside = row_local < 0
    bio_cols = bio_matrix[:, cols]
    coef_fixed = [
        (np.asarray(bio_cols.T @ cfs[m]).ravel() - np.asarray(tech_cols.T @ np.where(outside, u[:, m], 0.0)).ravel())
        * keep
        for m in range(len(methods))
    ]

    base = params.snapshot_all(database)
    tech, bio, by_exchange = _entries(database, system)
    groups, exchange_ids, stored = _formulas(database, base)
    tech_slot = np.array([by_exchange.get(("tech", i), -1) for i in exchange_ids], dtype=int)
    bio_slot = np.array([by_exchange.get(("bio", i), -1) for i in exchange_ids], dtype=int)

    at = {ex: i for i, ex in enumerate(exchange_ids)}
    production = [(at.get(ex._document.id, -1), float(ex["amount"])) for ex in act.production()]
    fast = FastModel(
        database=database, reference=reference, base_values=base, namespace=params.parameter_namespace(database),
        groups=groups, stored=stored, tech_slot=tech_slot, bio_slot=bio_slot, tech=tech, bio=bio,
        row_local=row_local, col_local=col_local, a_fixed=a_fixed, coef_fixed=coef_fixed, f=f, cf=cfs, u=u,
        production=production, demand=amount,
    )
    if fast._sign(fast.stored) * amount != demand[act.id]:
        raise _Unsupported("the demand sign read here is not the one the factorised system was solved for")
    _self_check(fast, system, a_ff, cols[:own])
    return fast


def _block(system, tech, database: str) -> tuple[list[int], list[int], int]:
    """Matrix rows and columns of the block — the model's processes and their products, widened by every
    outside process that uses one of those products until none does (``A[F, R] = 0``) — and how many of
    them are the model's own (they come first). Rows and columns in the same order, so the block is square
    and its diagonal holds each process's own product."""
    from bw2data.backends.schema import ActivityDataset

    ids = [i for (i,) in ActivityDataset.select(ActivityDataset.id)
           .where(ActivityDataset.database == database).tuples()]
    act_of, product_of = system.dicts.activity, system.dicts.product
    nodes = [i for i in ids if i in act_of]
    if any(i not in product_of for i in nodes):
        raise _Unsupported("a process of the model without its own product row")
    rows = [product_of[i] for i in nodes]
    cols = [act_of[i] for i in nodes]
    own = len(cols)
    col_ids = {v: k for k, v in act_of.items()}
    while True:
        in_block = set(cols)
        sub = tech[rows, :]
        users = {int(c) for c, v in zip(sub.indices, sub.data, strict=True) if v != 0 and int(c) not in in_block}
        if not users:
            return rows, cols, own
        for c in sorted(users):
            node = col_ids[c]
            if node not in product_of:
                raise _Unsupported("an outside process using the model's products has no product row")
            rows.append(product_of[node])
            cols.append(c)
        if len(cols) > BLOCK_MAX:
            raise _Unsupported("the block grew past its limit")


def _entries(database: str, system) -> tuple[_Entries, _Entries, dict[tuple[str, int], int]]:
    """Every record the model's processed arrays are written from, gathered the way ``SQLiteBackend.process``
    gathers them: each exchange's stored fields with its node ids, technosphere inputs flipped, outputs and credits
    as they are, a production of 1 for a process that states none, the biosphere as it is — and which record
    each exchange is."""
    from bw2data.backends.schema import ActivityDataset, ExchangeDataset
    from bw2data.configuration import labels
    from peewee import JOIN

    negative = set(labels.technosphere_negative_edge_types)
    positive = set(labels.technosphere_positive_edge_types)
    biosphere = set(labels.biosphere_edge_types)
    source, target = ActivityDataset.alias(), ActivityDataset.alias()
    query = (
        ExchangeDataset.select(ExchangeDataset.id, ExchangeDataset.type, ExchangeDataset.data, source.id, target.id)
        .join(source, join_type=JOIN.LEFT_OUTER, on=(
            (ExchangeDataset.input_code == source.code) & (ExchangeDataset.input_database == source.database)))
        .switch(ExchangeDataset)
        .join(target, join_type=JOIN.LEFT_OUTER, on=(
            (ExchangeDataset.output_code == target.code) & (ExchangeDataset.output_database == target.database)))
        .where((ExchangeDataset.output_database == database)
               & (ExchangeDataset.type << sorted(negative | positive | biosphere))
               & (target.type << labels.process_node_types))
        .tuples()
    )
    tech = _Entries([], [], system.dicts.product, system.dicts.activity)
    bio = _Entries([], [], system.dicts.biosphere, system.dicts.activity)
    by_exchange: dict[tuple[str, int], int] = {}
    for ex_id, kind, data, src, tgt in query:
        if src is None or tgt is None:
            raise _Unsupported("an exchange names a node that does not exist")
        if not isinstance(data, dict) or not math.isfinite(float(data.get("amount", math.nan))):
            raise _Unsupported("an exchange without a numeric amount")
        into, name = (bio, "bio") if kind in biosphere else (tech, "tech")
        by_exchange[(name, ex_id)] = len(into.data)
        into.data.append(dict(data))
        into.ids.append((src, tgt, kind in negative))
    produced = {code for (code,) in ExchangeDataset.select(ExchangeDataset.output_code)
                .where((ExchangeDataset.output_database == database) & (ExchangeDataset.type << sorted(positive)))
                .tuples()}
    for node, node_code in (ActivityDataset.select(ActivityDataset.id, ActivityDataset.code)
                            .where((ActivityDataset.database == database)
                                   & (ActivityDataset.type << labels.implicit_production_allowed_node_types))
                            .tuples()):
        if node_code not in produced:
            tech.data.append({"amount": 1})
            tech.ids.append((node, node, False))
    return tech, bio, by_exchange


def _formulas(database: str, base: dict[str, float]) -> tuple[list[_Group], list[int], np.ndarray]:
    """The model's parameterised exchanges — the groups that evaluate them, their exchange ids and their
    stored amounts — set up as ``ActivityParameter.recalculate_exchanges`` sets them up."""
    from asteval import Interpreter
    from bw2data.backends.schema import ExchangeDataset
    from bw2data.parameters import ActivityParameter, Group, ParameterizedExchange

    groups: list[_Group] = []
    exchange_ids: list[int] = []
    stored: list[float] = []
    for name in params.model_groups(database):
        owned = list(ActivityParameter.select().where(ActivityParameter.group == name))
        if not owned:
            # The recalculation cannot set up such a group (it reads its database from an activity
            # parameter) and leaves its amounts as they are; so do we.
            continue
        if any(p.formula for p in owned):
            raise _Unsupported("activity parameters with formulas")
        group = Group.get_or_none(name=name)
        if group is not None and group.order:
            raise _Unsupported("a group whose namespace chains other groups")
        exchanges = list(ParameterizedExchange.select().where(ParameterizedExchange.group == name))
        if not exchanges:
            continue
        try:
            namespace = ActivityParameter.static(name, full=True)
        except Exception as exc:  # noqa: BLE001 - the recalculation swallows the same failure
            # and leaves the group's amounts as they are; so do we.
            _log.swallowed(exc, "sensitivity_fast._formulas")
            continue
        interpreter = Interpreter()
        for k, v in namespace.items():
            interpreter.symtable[k] = v
        own = {p.name for p in owned}
        overlay = [n for n in base if n not in own] if owned[0].database == database else []
        trees, at = [], []
        for pe in exchanges:
            ex = ExchangeDataset.get_or_none(id=pe.exchange)
            if ex is None:
                raise _Unsupported("a parameterised exchange that no longer exists")
            if ex.output_database != database:
                raise _Unsupported("a parameterised exchange of a process outside the model")
            try:
                trees.append(interpreter.parse(pe.formula))
            except Exception as exc:  # noqa: BLE001 - asteval raises its own types
                raise _Unsupported(f"an exchange formula that does not parse: {pe.formula!r}") from exc
            at.append(len(exchange_ids))
            exchange_ids.append(pe.exchange)
            stored.append(float(ex.data.get("amount", np.nan)))
        groups.append(_Group(interpreter=interpreter, overlay=overlay, trees=trees, at=at))
    return groups, exchange_ids, np.array(stored, dtype=np.float64)


def _self_check(fast: FastModel, system, a_ff, own_cols: list[int]) -> None:
    """Three checks of the starting point before a run trusts this path: every exchange formula evaluated
    here gives the amount Brightway stored; the model's columns rebuilt here are the factorised system's bit
    for bit; and the block's score is the factorised score, to the rounding of two solvers."""
    try:
        amounts = fast._amounts(params.evaluate_overrides(fast.database, {}, fast.namespace))
    except PrismError as exc:
        raise _Unsupported(f"the formulas do not evaluate at the starting point: {exc.message}") from exc
    off = ~(np.abs(amounts - fast.stored) <= AMOUNT_RTOL * np.abs(fast.stored))  # NaN counts as off
    if np.any(off):
        i = int(np.argmax(off))
        raise _Unsupported(f"an exchange formula gives {amounts[i]!r} where {fast.stored[i]!r} is stored")

    from scipy.sparse import coo_matrix

    tech: dict[int, float] = {}
    bio: dict[int, float] = {}
    for entries, amount, matrix in ((fast.tech, tech, system.technosphere_matrix),
                                    (fast.bio, bio, system.biosphere_matrix)):
        r, c, v = entries.assemble(amount)
        rebuilt = coo_matrix((v, (r, c)), shape=matrix.shape).tocsc()[:, own_cols]
        if (rebuilt != matrix.tocsc()[:, own_cols]).nnz:
            raise _Unsupported("the model's columns rebuilt here differ from the factorised system")
    a, coef = fast._columns(tech, bio)
    same = np.array_equal(a, a_ff.toarray()) if isinstance(a, np.ndarray) else not (a != a_ff).nnz
    if not same:
        raise _Unsupported("the block rebuilt here differs from the factorised system")
    x = _solve(a, fast.f * (fast.demand * fast._sign(fast.stored)))
    for cm, ref in zip(coef, fast.reference, strict=True):
        got = float(cm @ x)
        scale = max(abs(ref), abs(got), float(np.max(np.abs(cm * x), initial=0.0)))
        if abs(got - ref) > SELF_CHECK_RTOL * scale:
            raise _Unsupported(f"the starting point differs: {got!r} against {ref!r}")
