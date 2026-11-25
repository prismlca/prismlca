"""The life cycle inventory of a compared subject: every elementary flow its functional unit exchanges with the
environment, summed over the whole supply chain.

Read off the solved system a subject's score comes from (``lca.compute_lcia``'s ``observe``): the same demand,
and for a scenario subject the same applied parameter window, so the inventory and the scores beside it are one
calculation and the inventory costs no solve of its own. It does not depend on the LCIA method.
"""
from __future__ import annotations

from collections.abc import Iterable

import numpy as np

from prism_lca.engine.bootstrap import get_bd

#: Node ids per query when the flows are named: well below SQLite's limit on bound variables.
_CHUNK = 500


def inventory_of(system) -> dict[int, float]:
    """Amount of every elementary flow the demand ``system`` is solved for draws or emits, keyed by the flow's
    node id. Flows the system does not touch are left out. Call while the system holds the demand — under the
    LCA lock, as ``compute_lcia``'s ``observe`` is."""
    # The solver squeezes: a one-process system's supply comes back as a 0-d scalar, which a sparse matrix will
    # not multiply. Its length is known — one entry per activity — so it is stated rather than guessed.
    supply = np.asarray(system.supply_array, dtype=float).reshape(system.biosphere_matrix.shape[1])
    totals = np.asarray(system.biosphere_matrix @ supply).ravel()
    node_of = {row: node for node, row in system.dicts.biosphere.items()}
    return {int(node_of[i]): float(totals[i]) for i in np.flatnonzero(totals) if i in node_of}


def flow_details(ids: Iterable[int]) -> dict[int, dict]:
    """Name, compartment and unit of each elementary flow, read in a few queries rather than one per flow — an
    ecoinvent system touches a few thousand of them. Node ids belong to one workspace: call it under the lock the
    amounts were read under."""
    from bw2data.backends.schema import ActivityDataset

    get_bd()
    wanted = sorted({int(i) for i in ids})
    out: dict[int, dict] = {}
    for start in range(0, len(wanted), _CHUNK):
        chunk = wanted[start : start + _CHUNK]
        rows = (
            ActivityDataset.select(ActivityDataset.id, ActivityDataset.name, ActivityDataset.data)
            .where(ActivityDataset.id.in_(chunk))
            .tuples()
        )
        for node_id, name, data in rows:
            data = data if isinstance(data, dict) else {}
            out[node_id] = {
                "name": name or data.get("name") or str(node_id),
                "categories": [str(c) for c in (data.get("categories") or [])],
                "unit": data.get("unit") or "",
            }
    for node_id in wanted:
        # A flow the solved matrix knows but the database no longer does: named by its id rather than dropped,
        # so its amount still shows.
        out.setdefault(node_id, {"name": str(node_id), "categories": [], "unit": ""})
    return out
