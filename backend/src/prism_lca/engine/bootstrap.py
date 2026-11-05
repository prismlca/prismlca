"""Brightway initialisation.

``BRIGHTWAY2_DIR`` MUST be set before ``bw2data`` is imported for the first time — that is
why all Brightway access goes through the lazy accessors here instead of a module-level
``import bw2data``.

The app sets it at start-up from its own settings (``engine/brightway_dir.py``). Here it is only
filled in when nobody set it — the case of scripts and tests, which point Brightway's variable at
a throwaway directory and must keep it.
"""
from __future__ import annotations

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


def get_bd() -> ModuleType:
    """Return the ``bw2data`` module, importing it only after the data dir is configured."""
    global _bd
    if _bd is None:
        # Brightway evaluates formulas; their namespace is restricted before Brightway is first used.
        from prism_lca.engine import formula_namespace

        formula_namespace.restrict()
        _ensure_env()
        import bw2data as bd  # noqa: E402 - env must be set before import

        _bd = bd
    return _bd


def get_bi() -> ModuleType:
    """Return the ``bw2io`` module (order-safe: ensures bw2data is initialised first)."""
    get_bd()
    import bw2io as bi  # noqa: E402

    return bi
