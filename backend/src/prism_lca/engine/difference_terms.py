"""The difference between two results, split exactly onto the matrix entries that differ.

Two results — the reference ``h0 = c0·B0·x0`` and the subject ``h1 = c1·B1·x1``, each system solved as
``A·x = f`` — differ by

    h1 − h0 = Σ c0_k·ΔB_kj·x1_j  −  Σ u0_i·ΔA_ij·x1_j  +  u0·(f1 − f0)  +  Σ Δc_k·(B1·x1)_k

with ``u0 = c0·B0·A0⁻¹``, the reference's cumulative impact of one unit of every product (one transposed
solve per indicator, :func:`lca._adjoint_unit_impacts`), and ``x1`` how often every process runs for the
subject. The identity needs nothing but ``u0·A0 = c0·B0`` and ``A1·x1 = f1``: write ``h0`` as ``u0·f0``,
add and take away ``u0·A1·x1`` and ``c0·B1·x1``, and the rest cancels. So every entry of the technosphere
or the biosphere that differs between the two systems is one term, and the terms add up to the difference
without anything being approximated. A term is the change valued at what one unit costs in the reference,
times how often its process runs in the subject — with every other change already in place. That is why
the terms add up, and why a term is not what its change would do on its own.

The entries are read from the two factorised systems the scores came from, never from the amounts as
typed: Brightway keeps amounts in single precision and sums several exchanges on one pair, and the split
has to be the split of the numbers that were scored. What the terms leave over is the solvers' rounding
and anything the two systems do not have in common that :class:`Placing` could not place; the rest is
therefore computed and reported, never assumed to be zero.

**The subject in another model** (a copy of the reference): its processes are first put in the reference's
places. A process paired with one of the reference's takes that one's column and row, and the reference's
own column of it is set aside. A process the reference does not have gets a place of its own, an empty
column in the reference, whose unit impact is zero; its own inputs and emissions then carry its whole
impact, and the link to it carries none. An elementary flow only the subject's system has (nothing in the
reference's system emits it, so its inventory has no row for it) gets a row of its own the same way, characterised
in the reference as in the subject: its emissions then carry their impact, and no factor counts as changed.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from prism_lca.errors import PrismError

#: The rest of the split counts as rounding up to this share of the larger of the two scores and of the
#: summed size of the terms (cancelling terms can be far larger than either score).
EXACT_RTOL = 1e-9


@dataclass
class Side:
    """One result's system, read while it was the factorised one: what the split needs of it."""

    technosphere: object
    biosphere: object
    supply: np.ndarray
    demand: dict[int, float]
    activity: dict[int, int]  # node id → column
    product: dict[int, int]  # node id → technosphere row
    flow: dict[int, int]  # node id → biosphere row
    cf: dict[tuple, np.ndarray] = field(default_factory=dict)
    score: dict[tuple, float] = field(default_factory=dict)
    unit: dict[tuple, np.ndarray] = field(default_factory=dict)
    system_id: int = 0

    @classmethod
    def read(cls, system) -> Side:
        """Copies, not references: the cached system is solved again for the next demand, and nothing
        may change what was read before the split is done. The supply is given its shape: the solver
        squeezes a one-process system's to a 0-d scalar, which the split could not index."""
        return cls(
            technosphere=system.technosphere_matrix.tocsc(copy=True),
            biosphere=system.biosphere_matrix.tocsc(copy=True),
            supply=np.array(system.supply_array, dtype=np.float64).reshape(system.technosphere_matrix.shape[1]),
            demand={int(k): float(v) for k, v in dict(system.demand).items()},
            activity={int(k): int(v) for k, v in dict(system.dicts.activity).items()},
            product={int(k): int(v) for k, v in dict(system.dicts.product).items()},
            flow={int(k): int(v) for k, v in dict(system.dicts.biosphere).items()},
            system_id=id(system),
        )


class Recorder:
    """Reads one side from :func:`lca.compute_lcia`'s ``observe`` hook — the matrices and the supply once,
    the characterisation and the score per indicator, and for the reference the unit impacts too, while its
    system is the factorised one (later they would cost a factorisation of their own)."""

    def __init__(self, reference: bool) -> None:
        self.reference = reference
        self.side: Side | None = None

    def __call__(self, system, method: tuple) -> None:
        from prism_lca.engine import lca

        if self.side is None:
            self.side = Side.read(system)
        elif self.side.system_id != id(system):
            raise PrismError(
                "The model changed while its result was being read, so the two results cannot be split.",
                code="difference_moved",
                hint="Ask again once the model has stopped changing.",
            )
        m = tuple(method)
        cf = np.asarray(system.characterization_matrix.sum(axis=0), dtype=np.float64).ravel().copy()
        self.side.cf[m] = cf
        self.side.score[m] = float(system.score)
        if self.reference:
            self.side.unit[m] = np.array(lca._adjoint_unit_impacts(system, [(m, cf)])[:, 0], dtype=np.float64)


@dataclass
class Placing:
    """Where the subject's rows and columns stand among the reference's: index ``n + p`` is the p-th process
    or product the reference does not have."""

    col: np.ndarray  # subject column → place, −1: set aside
    row: np.ndarray  # subject technosphere row → place
    flow: np.ndarray  # subject biosphere row → biosphere place (past the reference's rows: a flow it lacks)
    size: int
    flow_size: int
    #: place → the subject's node id, for every place a subject column or row went to.
    col_node: dict[int, int]
    row_node: dict[int, int]
    #: biosphere place past the reference's rows → the subject's flow node id
    flow_node: dict[int, int]
    #: How often the reference's own processes, set aside in the subject's system, run there: not zero only
    #: when the subject uses the reference's processes themselves, and then the split cannot be whole.
    set_aside_runs: float = 0.0


def place(ref: Side, sub: Side, paired: dict[int, int] | None = None) -> Placing:
    """Put the subject's system on the reference's places. ``paired``: subject node id → reference node id
    for a subject in another model; every other node keeps its own id (the background, a library, the
    model itself when the subject is a scenario of it)."""
    paired = paired or {}
    taken = set(paired.values())
    n = ref.technosphere.shape[0]
    extra: dict[int, int] = {}

    def target(node: int, index: dict[int, int]) -> int:
        if node in paired:
            node_ref = paired[node]
        elif node in taken:
            return -1
        else:
            node_ref = node
        at = index.get(node_ref)
        if at is None:
            at = extra.setdefault(node, n + len(extra))
        return at

    col_of = {c: node for node, c in sub.activity.items()}
    row_of = {r: node for node, r in sub.product.items()}
    col = np.full(sub.technosphere.shape[1], -1, dtype=np.int64)
    row = np.full(sub.technosphere.shape[0], -1, dtype=np.int64)
    col_node: dict[int, int] = {}
    row_node: dict[int, int] = {}
    for c, node in col_of.items():
        col[c] = target(node, ref.activity)
        if col[c] >= 0:
            col_node[int(col[c])] = node
    for r, node in row_of.items():
        if node in taken and node not in paired:
            # A row of the reference's own process inside the subject's system stays where it is: only the
            # subject's use of that process itself puts anything there. It names nothing — the place belongs
            # to the subject's process paired with it, whichever of the two comes first here.
            row[r] = ref.product.get(node, -1)
            continue
        row[r] = target(node, ref.product)
        row_node[int(row[r])] = node
    flows = ref.biosphere.shape[0]
    flow = np.full(sub.biosphere.shape[0], -1, dtype=np.int64)
    flow_node: dict[int, int] = {}
    for node, k in sub.flow.items():
        at = ref.flow.get(node)
        if at is None:
            at = flows + len(flow_node)
            flow_node[at] = node
        flow[k] = at
    set_aside = np.flatnonzero(col < 0)
    runs = float(np.abs(sub.supply[set_aside]).sum()) if len(set_aside) else 0.0
    return Placing(col=col, row=row, flow=flow, size=n + len(extra), flow_size=flows + len(flow_node),
                   col_node=col_node, row_node=row_node, flow_node=flow_node, set_aside_runs=runs)


@dataclass
class Moved:
    """The subject's matrices on the reference's places, and the differences — shared by every indicator."""

    placing: Placing
    tech: object  # subject technosphere, placed
    bio: object
    d_tech: object  # placed subject − reference, zeros dropped
    d_bio: object
    runs: np.ndarray  # how often each place runs in the subject
    ref_tech: object
    ref_bio: object


def move(ref: Side, sub: Side, placing: Placing) -> Moved:
    from scipy.sparse import coo_matrix

    size = placing.size
    a = sub.technosphere.tocoo()
    keep = (placing.col[a.col] >= 0) & (placing.row[a.row] >= 0)
    tech = coo_matrix((a.data[keep], (placing.row[a.row[keep]], placing.col[a.col[keep]])), shape=(size, size)).tocsc()
    b = sub.biosphere.tocoo()
    keep_b = (placing.col[b.col] >= 0) & (placing.flow[b.row] >= 0)
    bio = coo_matrix(
        (b.data[keep_b], (placing.flow[b.row[keep_b]], placing.col[b.col[keep_b]])),
        shape=(placing.flow_size, size),
    ).tocsc()
    ref_tech = _pad(ref.technosphere, size, size)
    ref_bio = _pad(ref.biosphere, placing.flow_size, size)
    d_tech = (tech - ref_tech).tocsc()
    d_tech.eliminate_zeros()
    d_bio = (bio - ref_bio).tocsc()
    d_bio.eliminate_zeros()
    runs = np.zeros(size)
    placed = placing.col >= 0
    runs[placing.col[placed]] = sub.supply[placed]
    return Moved(placing=placing, tech=tech, bio=bio, d_tech=d_tech, d_bio=d_bio, runs=runs,
                 ref_tech=ref_tech, ref_bio=ref_bio)


def _pad(matrix, rows: int, cols: int):
    from scipy.sparse import coo_matrix

    m = matrix.tocoo()
    return coo_matrix((m.data, (m.row, m.col)), shape=(rows, cols)).tocsc()


@dataclass
class Split:
    """One indicator's split. Each kind of term as parallel arrays; ``rest`` is what they leave over."""

    reference: float
    subject: float
    #: technosphere: place of the product row, place of the process column, entry before and after, term
    tech: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]
    #: biosphere: biosphere place, place of the process column, before, after, term
    bio: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]
    #: the demand: (subject node, reference node, before, after, term), one entry when it moved
    demand: list[tuple[int, int, float, float, float]]
    #: characterisation: biosphere place, factor before, after, term
    factors: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]

    @property
    def delta(self) -> float:
        return self.subject - self.reference

    @property
    def explained(self) -> float:
        return float(self.tech[4].sum() + self.bio[4].sum() + sum(t[4] for t in self.demand) + self.factors[3].sum())

    @property
    def rest(self) -> float:
        return self.delta - self.explained

    @property
    def exact(self) -> bool:
        size = float(np.abs(self.tech[4]).sum() + np.abs(self.bio[4]).sum() + np.abs(self.factors[3]).sum()
                     + sum(abs(t[4]) for t in self.demand))
        return abs(self.rest) <= EXACT_RTOL * max(abs(self.reference), abs(self.subject), size)


def split(ref: Side, sub: Side, moved: Moved, method: tuple) -> Split:
    m = tuple(method)
    placing = moved.placing
    u = np.zeros(placing.size)
    u[: len(ref.unit[m])] = ref.unit[m]
    flows = len(ref.cf[m])
    c0 = np.zeros(placing.flow_size)
    c0[:flows] = ref.cf[m]
    c1 = c0.copy()  # a flow the subject's inventory lacks keeps the reference's factor: its row is empty there
    c1[placing.flow] = sub.cf[m]
    c0[flows:] = c1[flows:]  # a flow the reference lacks is characterised there as in the subject
    runs = moved.runs

    d = moved.d_tech.tocoo()
    before = _entries(moved.ref_tech, d.row, d.col)
    tech = (d.row, d.col, before, before + d.data, -u[d.row] * d.data * runs[d.col])

    db = moved.d_bio.tocoo()
    before_b = _entries(moved.ref_bio, db.row, db.col)
    bio = (db.row, db.col, before_b, before_b + db.data, c0[db.row] * db.data * runs[db.col])

    # The demand: what the subject asks for, placed, against what the reference asks for.
    demand: list[tuple[int, int, float, float, float]] = []
    sub_f = {int(placing.row[sub.product[node]]): (node, amount) for node, amount in sub.demand.items()}
    ref_f = {ref.product[node]: (node, amount) for node, amount in ref.demand.items()}
    for at in sorted(set(sub_f) | set(ref_f)):
        node1, after = sub_f.get(at, (None, 0.0))
        node0, before_f = ref_f.get(at, (None, 0.0))
        if after != before_f:
            term = float(u[at]) * (after - before_f)
            demand.append((node1 if node1 is not None else -1, node0 if node0 is not None else -1,
                           before_f, after, term))

    # Characterisation factors that differ (another version of a method between the two reads).
    moved_cf = np.flatnonzero(c1 != c0)
    if len(moved_cf):
        g = np.asarray(moved.bio @ runs).ravel()
        factors = (moved_cf, c0[moved_cf], c1[moved_cf], (c1[moved_cf] - c0[moved_cf]) * g[moved_cf])
    else:
        empty = np.array([], dtype=np.float64)
        factors = (np.array([], dtype=np.int64), empty, empty, empty)
    return Split(reference=ref.score[m], subject=sub.score[m], tech=tech, bio=bio, demand=demand, factors=factors)


def _entries(matrix, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    if not len(rows):
        return np.array([], dtype=np.float64)
    return np.asarray(matrix[rows, cols], dtype=np.float64).ravel()
