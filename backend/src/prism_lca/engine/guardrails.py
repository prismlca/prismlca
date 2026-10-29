"""Read-only guardrail for background databases (ADR-005).

Brightway has no native per-database write lock, so PrismLCA tracks one in the database
metadata (``prism_read_only``). The default is **read-only** — a database only becomes
writable when PrismLCA explicitly registers it as a foreground database. This makes accidental
edits to ecoinvent/biosphere impossible rather than merely discouraged.
"""
from __future__ import annotations

from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

READ_ONLY_KEY = "prism_read_only"


def is_read_only(db_name: str) -> bool:
    bd = get_bd()
    meta = bd.databases.get(db_name)
    if meta is None:
        return True  # unknown database: safest default
    return bool(meta.get(READ_ONLY_KEY, True))


def set_read_only(db_name: str, read_only: bool) -> None:
    bd = get_bd()
    if db_name in bd.databases:
        bd.databases[db_name][READ_ONLY_KEY] = read_only
        bd.databases.flush()


def assert_writable(db_name: str) -> None:
    """Raise if ``db_name`` is read-only.

    The invariant, honestly stated: this is NOT called before every write. It guards the entry
    points in ``model.*`` and a set of commands directly (18 call sites); most command classes rely
    on delegating their writes through those ``model.*`` functions. A new write path must either go
    through one of the guarded entry points or call this itself — nothing enforces that mechanically.
    """
    if is_read_only(db_name):
        raise PrismError(
            f"Database '{db_name}' is read-only.",
            code="read_only_database",
            status_code=409,
            hint=(
                "Background databases (ecoinvent, BAFU, biosphere) cannot be edited. Copy the "
                "activity into your foreground database and edit the copy instead."
            ),
        )
