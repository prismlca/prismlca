"""A deleted model's own data, kept while the step that deleted it can still be taken back.

Undoing a bundle import deletes the model, and the delete cascade takes every per-model store with it:
its chats, reports, views and the rest. A redo re-creates only what the bundle brought. So the undo
reads each store's share first, and the redo puts it back over what the bundle wrote. Both walk the
one registry of per-model stores (``_store.per_model_stores``), like the rename and delete cascades:
a store that registers is set aside with the others.

The shares live in memory, on the step: they go when the step goes (a new change clears the redo
stack, a workspace switch clears both, a restart ends them), so nothing gathers on disk. A share
remembers the workspace it was read in and is never written into another one.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from prism_lca.engine._store import per_model_stores, prism_meta_dir


@dataclass(eq=False)
class ModelAside:
    """One model's shares of the per-model stores, by store name."""

    database: str
    where: Path
    shares: dict[str, Any]


def set_aside(database: str) -> ModelAside:
    """Read the model's share of every per-model store. Writes nothing: the delete follows."""
    return ModelAside(
        database, prism_meta_dir(), {store.name: store.snapshot(database) for store in per_model_stores()}
    )


def put_back(aside: ModelAside, database: str) -> bool:
    """Make the set-aside shares the data of ``database`` again — the same model, possibly under another
    name if its old one was taken meanwhile. False, and nothing written, outside the workspace it came from."""
    if aside.where != prism_meta_dir():
        return False
    for store in per_model_stores():
        if store.name in aside.shares:
            store.restore(database, aside.shares[store.name])
    return True
