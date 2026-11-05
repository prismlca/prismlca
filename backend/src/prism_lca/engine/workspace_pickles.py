"""The parts of a workspace folder that bw2data reads with ``pickle``, checked to hold plain data only.

bw2data keeps activities, exchanges and parameters as pickled columns of ``lci/databases.db`` and
``parameters.db``, and some of its metadata as ``*.pickle`` files. A folder from elsewhere is untrusted input:
before it becomes a workspace, every one of these values must load with an unpickler that resolves no globals.
"""
from __future__ import annotations

import io
import os
import pickle
import pickletools
import sqlite3
from pathlib import Path

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
#: Up to this size a pickle is loaded; a larger one is only read opcode by opcode, which keeps memory flat.
LOAD_LIMIT = 4 * 1024 * 1024
#: Far above any real activity, exchange, parameter or LCIA method.
MAX_PICKLE = 64 * 1024 * 1024
#: Opcodes that name or call a global, or build an object through one.
_OBJECT_OPCODES = frozenset({
    "GLOBAL", "STACK_GLOBAL", "INST", "OBJ", "REDUCE", "BUILD", "NEWOBJ", "NEWOBJ_EX",
    "EXT1", "EXT2", "EXT4", "PERSID", "BINPERSID",
})


class _NotPlain(Exception):
    pass


class _PlainUnpickler(pickle.Unpickler):
    def find_class(self, module: str, name: str):
        raise _NotPlain(f"{module}.{name}")


def _check(data: bytes) -> None:
    """``data`` unpickles to plain values: None, bool, int, float, str, bytes, and lists, tuples, dicts
    and sets of them."""
    if len(data) <= LOAD_LIMIT:
        _PlainUnpickler(io.BytesIO(data)).load()
        return
    for opcode, _arg, _pos in pickletools.genops(data):
        if opcode.name in _OBJECT_OPCODES:
            raise _NotPlain(opcode.name)


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
            rows = con.execute(
                f'SELECT typeof("{column}"), length("{column}"), '
                f'CASE WHEN length("{column}") <= ? THEN "{column}" END FROM "{table}"',
                (MAX_PICKLE,),
            )
            for kind, size, value in rows:
                if kind == "null":
                    continue
                if kind != "blob" or size > MAX_PICKLE:
                    raise _NotPlain(table)
                _check(value)
    finally:
        con.close()


def assert_plain(folder: Path) -> None:
    """Refuse ``folder`` unless every value bw2data unpickles from it is plain data."""
    for dirpath, _dirnames, filenames in os.walk(folder):
        for filename in filenames:
            path = Path(dirpath, filename)
            rel = path.relative_to(folder).as_posix()
            key = rel.casefold()
            try:
                if key.endswith(".pickle"):
                    if path.stat().st_size > MAX_PICKLE:
                        raise _NotPlain(rel)
                    _check(path.read_bytes())
                elif key in PICKLE_COLUMNS:
                    _check_store(path, PICKLE_COLUMNS[key])
            except Exception as exc:  # noqa: BLE001 - anything that does not load as plain data is refused
                raise _refuse(rel) from exc
