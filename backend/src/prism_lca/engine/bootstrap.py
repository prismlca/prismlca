"""Brightway initialisation.

``BRIGHTWAY2_DIR`` MUST be set before ``bw2data`` is imported for the first time — that is
why all Brightway access goes through the lazy accessors here instead of a module-level
``import bw2data``.

The app sets it at start-up from its own settings (``engine/brightway_dir.py``). Here it is only
filled in when nobody set it — the case of scripts and tests, which point Brightway's variable at
a throwaway directory and must keep it.

Loading Brightway also hooks the one thing every workspace switch needs from us: letting go of the
workspace that was left.
"""
from __future__ import annotations

import gc
import os
from pathlib import Path
from types import ModuleType

from prism_lca.config import get_settings
from prism_lca.engine.brightway_dir import BRIGHTWAY_ENV, claim, default_dir

_bd: ModuleType | None = None


def _ensure_env() -> None:
    if BRIGHTWAY_ENV not in os.environ:
        data_dir = default_dir(get_settings())
        data_dir.mkdir(parents=True, exist_ok=True)
        os.environ[BRIGHTWAY_ENV] = str(data_dir)
    # A directory bw2data is about to create is ours — marked, so the app may open it later (a script's
    # import, say). One that already holds projects keeps no mark of ours.
    claim(Path(os.environ[BRIGHTWAY_ENV]))
    # Deterministic, ASCII-safe output on Windows consoles.
    os.environ.setdefault("PYTHONUTF8", "1")


def _let_go_of_the_left_workspace(_sender: object, **_kwargs: object) -> None:
    """Close what other threads still hold open in the workspace that was just left.

    A SQLite connection belongs to the thread that opened it, and Brightway's switch closes only those of
    the thread that switches. The others close when the database object they belong to is collected, and
    the switch collects one database late: the parameter database of the workspace that was left — with the
    connection the server's event loop opened on it — stays until some later collection. Until then its
    `parameters.db` is open, and Windows refuses to delete, move or rename the folder of a workspace the
    user is no longer in, from the app as from outside it. Brightway sends this signal once every database
    has moved to the new workspace, so one collection closes them all — all but one a read in another
    thread is still using at this moment, which waits for the next collection after the read: deleting a
    workspace collects once more for it (`delete_project`).
    """
    gc.collect()


def get_bd() -> ModuleType:
    """Return the ``bw2data`` module, importing it only after the data dir is configured."""
    global _bd
    if _bd is None:
        # Brightway evaluates formulas; their namespace is restricted before Brightway is first used.
        from prism_lca.engine import formula_namespace

        formula_namespace.restrict()
        _ensure_env()
        import bw2data as bd  # noqa: E402 - env must be set before import
        from bw2data.signals import project_changed

        # Every switch, wherever it starts: a workspace opened, created, deleted, imported into, restored.
        project_changed.connect(_let_go_of_the_left_workspace, weak=False)
        _bd = bd
    return _bd


def get_bi() -> ModuleType:
    """Return the ``bw2io`` module (order-safe: ensures bw2data is initialised first)."""
    get_bd()
    import bw2io as bi  # noqa: E402

    return bi
