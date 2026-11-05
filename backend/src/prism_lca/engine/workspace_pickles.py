"""The parts of a workspace folder that bw2data reads with ``pickle``, checked to hold plain data only.

bw2data keeps activities, exchanges and parameters as pickled columns of ``lci/databases.db`` and
``parameters.db``, and some of its metadata as ``*.pickle`` files. A folder from elsewhere is untrusted input:
before it becomes a workspace, every one of these values must be a pickle of plain values
(:mod:`prism_lca.engine.plain_pickle`), and the stores must keep the values as they were checked.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from prism_lca.engine import plain_pickle
from prism_lca.errors import PrismError

#: bw2data's ``PickleField`` columns per store, by path inside the workspace folder. Paths, tables and columns
#: are matched case-insensitively, as SQLite and some file systems resolve them.
PICKLE_COLUMNS: dict[str, tuple[tuple[str, str], ...]] = {
    "lci/databases.db": (("activitydataset", "data"), ("exchangedataset", "data")),
    "parameters.db": (
        ("projectparameter", "data"),
        ("databaseparameter", "data"),
        ("activityparameter", "data"),
        ("group_table", "order"),
    ),
}
#: Far above any real activity, exchange, parameter or LCIA method.
MAX_PICKLE = 16 * 1024 * 1024


class _NotPlain(Exception):
    pass


def _refuse(where: str) -> PrismError:
    return PrismError(
        f"This backup holds data PrismLCA does not restore, in {where}.",
        code="backup_unreadable",
        hint="Only plain values are restored from a backup. Restore one written by Back up this workspace.",
    )


def _check_store(path: Path, columns: tuple[tuple[str, str], ...]) -> None:
    # Read-write in our own folder: SQLite settles a leftover journal now, as it would for bw2data later.
    con = sqlite3.connect(path)
    try:
        con.execute("PRAGMA trusted_schema = OFF")
        # Pages and indexes agree with their tables, so every way of reading a row returns the value checked.
        if con.execute("PRAGMA integrity_check(1)").fetchone() != ("ok",):
            raise _NotPlain(path.name)
        # bw2data creates the triggers it needs whenever it opens a store; none from elsewhere is kept.
        triggers = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")]
        for trigger in triggers:
            con.execute('DROP TRIGGER "{}"'.format(trigger.replace('"', '""')))
        con.commit()
        schema: dict[str, list[tuple[str, str]]] = {}
        listed = con.execute("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view')")
        for kind, name, sql in listed:
            schema.setdefault(name.casefold(), []).append((kind, (sql or "").lstrip().upper()))
        for table, column in columns:
            entries = schema.get(table)
            if entries is None:
                continue
            # Only an ordinary table reads back the same values every time.
            if len(entries) != 1 or entries[0][0] != "table" or entries[0][1].startswith("CREATE VIRTUAL"):
                raise _NotPlain(table)
            # ...and a plain stored column without a default of its own.
            info = [r for r in con.execute(f'PRAGMA table_xinfo("{table}")') if r[1].casefold() == column]
            if len(info) != 1 or info[0][4] is not None or info[0][6] != 0:
                raise _NotPlain(f"{table}.{column}")
            rows = con.execute(
                f'SELECT typeof("{column}"), length("{column}"), '
                f'CASE WHEN length("{column}") <= ? THEN "{column}" END FROM "{table}" NOT INDEXED',
                (MAX_PICKLE,),
            )
            for kind, size, value in rows:
                if kind == "null":
                    continue
                if kind != "blob" or size > MAX_PICKLE:
                    raise _NotPlain(table)
                plain_pickle.check(value)
    finally:
        con.close()


def _files(folder: Path) -> list[tuple[Path, str]]:
    """Every file below ``folder`` with its relative path, casefolded."""
    found = []
    for dirpath, _dirnames, filenames in os.walk(folder):
        for filename in filenames:
            path = Path(dirpath, filename)
            found.append((path, path.relative_to(folder).as_posix().casefold()))
    return found


def assert_plain(folder: Path) -> None:
    """Refuse ``folder`` unless every value bw2data unpickles from it is plain data."""
    for path, key in _files(folder):
        try:
            if key.endswith(".pickle"):
                if path.stat().st_size > MAX_PICKLE:
                    raise _NotPlain(key)
                plain_pickle.check(path.read_bytes())
            elif key in PICKLE_COLUMNS:
                _check_store(path, PICKLE_COLUMNS[key])
        except Exception as exc:  # noqa: BLE001 - anything that does not load as plain data is refused
            raise _refuse(path.relative_to(folder).as_posix()) from exc
    # SQLite settled each store's journal during the check; none of them, in any spelling, goes further.
    journals = {f"{store}{suffix}" for store in PICKLE_COLUMNS for suffix in ("-journal", "-wal", "-shm")}
    for path, key in _files(folder):
        if key in journals:
            path.unlink()
