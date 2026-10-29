"""Market vectors blended with their suppliers' — for the ranking only.

An ecoinvent market is embedded with a comment that 8 068 of its 8 084 markets share word for word. That
comment pulls every market into the same corner of the vector space, away from its product, and the
producer wins the query the market should win ("aluminium": market 0.58, a producer 0.64). Lending each
market the vectors of its biggest suppliers puts the product's meaning back. Measured: first
place 86 → 98 of 224 cases, the holdout 21 → 27 of 38 (9 better, 1 worse), capital-good, waste and
technology searches held. Suppliers as TEXT did worse than no text at all — technology words and region
codes dilute; as VECTORS they carry exactly the product.

The blended value only ORDERS. A candidate keeps its own cosine as ``dense`` — the displayed score, ``weak``,
the thresholds — so a market moves up without claiming to match better than its own text does.
Nothing is re-embedded and nothing is saved: the index files keep the raw embeddings,
the blend is kept on the loaded index object and goes with it.
"""

from __future__ import annotations

import pickle
import sqlite3
import threading
import time
from pathlib import Path

import numpy as np

from prism_lca import _log
from prism_lca.engine.bootstrap import get_bd

#: How many suppliers are mixed in, biggest first. Set, not tuned.
TOP = 3
MARKETS = ("M", "G")
#: Seconds a failed blend is not retried. Not remembering a failure at all would make every search pay the
#: read again (about a second for ecoinvent) while a file stays locked or an index no longer fits its database.
RETRY_AFTER = 60.0


class Mismatch(Exception):
    """The workspace file does not hold the database this index was built from."""


def suppliers(db_file: Path, db_name: str, codes: set[str]) -> dict[str, list[str]]:
    """Each market's suppliers within the same database, biggest first (the contract of the blend).

    A supplier sells the market's own reference product — transport and other inputs are not what the
    market sells. A waste market's reference product is negative and its treatments come in with negative
    amounts; the sign of the production exchange turns them, or a waste market would have no suppliers.

    Read from the workspace's SQLite file, read-only, without Brightway: about a second for ecoinvent,
    because only production rows and same-product inputs of markets are unpickled. Raises `Mismatch` when a
    market of the index is not in the file — the file then belongs to another workspace, and its suppliers
    must not be mixed into this index."""
    con = sqlite3.connect(f"file:{db_file}?mode=ro", uri=True)
    try:
        product = {c: (p or "").strip().casefold()
                   for c, p in con.execute("select code, product from activitydataset where database = ?",
                                           (db_name,))}
        if not codes <= product.keys():
            raise Mismatch(f"{len(codes - product.keys())} markets of the index are not in {db_name}")
        sign: dict[str, float] = {}
        found: dict[str, dict[str, float]] = {}
        for out, inp, in_db, kind, data in con.execute(
            "select output_code, input_code, input_database, type, data from exchangedataset "
            "where output_database = ? and type in ('technosphere', 'production')", (db_name,)
        ):
            if out not in codes:
                continue
            if kind == "production":
                amount = float(pickle.loads(data).get("amount") or 0)  # noqa: S301 — the user's own file
                sign[out] = -1.0 if amount < 0 else 1.0
                continue
            if inp == out or in_db != db_name or not product[out] or product.get(inp) != product[out]:
                continue
            amount = float(pickle.loads(data).get("amount") or 0)  # noqa: S301
            found.setdefault(out, {})[inp] = found.get(out, {}).get(inp, 0.0) + amount
    finally:
        con.close()
    ranked: dict[str, list[str]] = {}
    for code, amounts in found.items():
        s = sign.get(code, 1.0)
        ranked[code] = [c for a, c in sorted(((a * s, c) for c, a in amounts.items()), reverse=True) if a > 0]
    return ranked


def blend(matrix: np.ndarray, meta: list[dict], sups: dict[str, list[str]], weight: float,
          top: int = TOP) -> tuple[np.ndarray, np.ndarray]:
    """The market rows of an index and their blended vectors: the market's own vector plus ``weight`` times
    the normalised mean of its ``top`` biggest suppliers that are in the same index, renormalised.

    Suppliers contribute their RAW vectors, so a market group (whose suppliers are markets) is not blended
    with already blended markets — measured that way, and independent of row order. ``matrix`` is read,
    never written."""
    row = {m.get("code"): i for i, m in enumerate(meta)}
    rows: list[int] = []
    # Filled in place: a list of 8 000 vectors stacked afterwards held the blend twice while it was built.
    vecs = np.empty((sum(1 for m in meta if m.get("atype") in MARKETS), matrix.shape[1]), dtype="float32")
    for i, m in enumerate(meta):
        if m.get("atype") not in MARKETS:
            continue
        picked = [row[c] for c in sups.get(m.get("code"), ()) if c in row][:top]
        if not picked:
            continue
        mean = matrix[picked].mean(axis=0)
        norm = float(np.linalg.norm(mean))
        if not norm:
            continue
        v = matrix[i] + weight * mean / norm
        vn = float(np.linalg.norm(v))
        if vn:
            vecs[len(rows)] = v / vn
            rows.append(i)
    # A slice would keep the whole buffer alive; ecoinvent blends every market, so usually there is none.
    return np.asarray(rows, dtype=np.int64), vecs if len(rows) == len(vecs) else vecs[: len(rows)].copy()


class MarketVectors:
    """The blended market rows of each loaded background index, kept on the index object.

    On the object rather than under the ``project/database`` cache key: a key computed at search time names
    the CURRENT workspace, and a switch between loading an index and blending it would pair one workspace's
    vectors with another's suppliers. An index loaded anew is a new object; one changed
    in place moves its ``generation``."""

    def __init__(self, service) -> None:
        self._svc = service
        #: One blend is built at a time. The warm-up thread and a first search would otherwise both read the
        #: file and hold ~100 MB each, and a late failure could replace the other's success.
        #: Never held while PROJECT_LOCK is taken: `source` runs before it.
        self._build = threading.Lock()

    def source(self, name: str) -> Path | None:
        """The workspace file holding a BACKGROUND database, or None for every other database: the library
        changes with each import and its markets' suppliers live elsewhere. Determined under PROJECT_LOCK —
        the switch routes hold it for the whole switch — and read outside it. The eval harness replaces this
        method: it has no Brightway projects, only the file."""
        from prism_lca.engine.backgrounds.common import is_background
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK:
            if not is_background(name):
                return None
            return Path(get_bd().projects.dir) / "lci" / "databases.db"

    def warm(self, names: list[str], started_in: str) -> None:
        """Blend on the warm-up thread — the second the first search would otherwise pay."""
        for name in names:
            if get_bd().projects.current != started_in:
                return
            self._blended(name, self._svc._require_index(name))

    def order(self, name: str, index, cosines: np.ndarray, qvec) -> np.ndarray:
        """The values the ranking orders this index's rows by: its cosines, the market rows taken from the
        blended vectors. ``cosines`` is not changed."""
        blended = self._blended(name, index)
        if blended is None or not len(blended[0]):
            return cosines
        rows, vecs = blended
        out = cosines.copy()
        out[rows] = vecs @ np.asarray(qvec, dtype="float32")
        return out

    def _blended(self, name: str, index) -> tuple[np.ndarray, np.ndarray] | None:
        weight = float(self._svc._settings.search_market_blend)
        if weight <= 0 or not len(index.meta):
            return None
        stamp = (index.generation, len(index.meta), weight)
        if (hit := _memo(index, stamp)) is not _MISS:
            return hit
        try:
            db_file = self.source(name)
        except Exception as exc:  # noqa: BLE001 — no blend is today's search, not an error
            _log.swallowed(exc, "MarketVectors.source")
            db_file = None
        with self._build:
            if (hit := _memo(index, stamp)) is not _MISS:
                return hit  # built while this one waited
            if db_file is None:
                # Not a background — or not one of the workspace that is current right now, when a switch
                # happens mid-search. Kept briefly either way, or a workspace switched back to would never
                # blend this index again.
                index._prism_market_blend = (stamp, None, time.monotonic() + RETRY_AFTER)
                return None
            try:
                codes = {m.get("code") for m in index.meta if m.get("atype") in MARKETS}
                result = blend(index.matrix, index.meta, suppliers(db_file, name, codes), weight) if codes else None
            except Exception as exc:  # noqa: BLE001 — no blend is today's search, not an error
                # Kept only briefly: "database is locked" while the app writes is a moment, and a file of
                # another workspace is a switch in progress — a search a minute later tries again.
                _log.swallowed(exc, "MarketVectors")
                index._prism_market_blend = (stamp, None, time.monotonic() + RETRY_AFTER)
                return None
            if index.generation == stamp[0]:  # rows changed while blending: the result describes old rows
                index._prism_market_blend = (stamp, result, None)
            return result


_MISS = object()


def _memo(index, stamp: tuple):
    """What is kept on the index for this stamp — or `_MISS` when nothing is, or a failure's minute is over."""
    cached = getattr(index, "_prism_market_blend", None)
    if cached and cached[0] == stamp and (cached[2] is None or time.monotonic() < cached[2]):
        return cached[1]
    return _MISS
