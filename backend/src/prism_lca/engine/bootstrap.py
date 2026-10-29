"""Brightway initialisation.

``BRIGHTWAY2_DIR`` MUST be set before ``bw2data`` is imported for the first time — that is
why all Brightway access goes through the lazy accessors here instead of a module-level
``import bw2data``.
"""
from __future__ import annotations

import os
from types import ModuleType

from prism_lca.config import get_settings

_bd: ModuleType | None = None


def _ensure_env() -> None:
    if "BRIGHTWAY2_DIR" not in os.environ:
        data_dir = get_settings().data_dir / "brightway"
        data_dir.mkdir(parents=True, exist_ok=True)
        os.environ["BRIGHTWAY2_DIR"] = str(data_dir)
    # Deterministic, ASCII-safe output on Windows consoles.
    os.environ.setdefault("PYTHONUTF8", "1")


def get_bd() -> ModuleType:
    """Return the ``bw2data`` module, importing it only after the data dir is configured."""
    global _bd
    if _bd is None:
        _ensure_env()
        import bw2data as bd  # noqa: E402 - env must be set before import

        _bd = bd
    return _bd


def get_bi() -> ModuleType:
    """Return the ``bw2io`` module (order-safe: ensures bw2data is initialised first)."""
    get_bd()
    import bw2io as bi  # noqa: E402

    return bi
