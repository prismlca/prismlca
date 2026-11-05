"""Copying files that belong to another program without getting in its way, and only when the copy is whole.

What we copy out of somebody's Brightway directory (``engine/workspace_carryover.py``) may be in use by the
Activity Browser at the same moment. Three rules:

* **Read, never anything else.** Not SQLite and not bw2data — either may lock files there or create new
  ones. Nothing is written, renamed, locked or created on the source side.
* **Stand in nobody's way.** On Windows Python's ``open`` shares reading and writing but not deleting, and a
  SQLite commit next door ends by deleting its journal: while we held the file, that commit would fail. So
  source files are opened with all three sharing modes there. Journals themselves are never opened.
* **A copy counts only if nothing changed while it was taken.** Every file's size and modification time —
  and for an SQLite database the change counter in its header, which every commit raises — are read before
  and after. A rollback-journal database must have no non-empty ``-journal`` meanwhile (a transaction in
  flight). A WAL database must have neither ``-wal`` nor ``-shm``: its change counter does not move on a
  checkpoint and Windows may not move the modification time while the writer holds the file, so the only
  safe WAL database is one nobody has open. (bw2data does not use WAL; this is for whatever else wrote
  there.) Anything else, and the copy is taken again; after a few tries the caller is told to ask the user
  to close the other program.

Linked folders and files are refused rather than followed: a link may lead to another drive or back into
itself, and skipping it would leave a copy that looks whole and is not.
"""
from __future__ import annotations

import os
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

_CHUNK = 16 * 1024 * 1024
_SQLITE_MAGIC = b"SQLite format 3\x00"
#: SQLite's files beside a database. Never copied: either a write is under way or they are empty.
_SIDE_FILES = ("-journal", "-wal", "-shm")


class Changing(Exception):
    """The source changed, or was being written, while it was read."""


class Linked(Exception):
    """The source contains a linked folder or file."""


def open_shared(path: Path) -> BinaryIO:
    """Open ``path`` for reading so that its owner may still write, rename and delete it meanwhile."""
    if os.name != "nt":
        return open(path, "rb")  # POSIX: an open file never blocks anybody else
    import ctypes
    import msvcrt
    from ctypes import wintypes

    create = ctypes.WinDLL("kernel32", use_last_error=True).CreateFileW
    create.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
    ]
    create.restype = wintypes.HANDLE
    generic_read, share_all, open_existing, attribute_normal = 0x80000000, 0x7, 3, 0x80
    handle = create(str(path), generic_read, share_all, None, open_existing, attribute_normal, None)
    if handle in (None, wintypes.HANDLE(-1).value):
        raise ctypes.WinError(ctypes.get_last_error())
    return os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), "rb")


def _fingerprint(path: Path) -> tuple[int, int, bytes | None]:
    """Size, modification time, and for an SQLite database its header (mode bytes and change counter)."""
    st = path.stat()
    header = None
    if st.st_size >= 100:
        with open_shared(path) as fh:
            head = fh.read(28)
        if head.startswith(_SQLITE_MAGIC):
            header = head[18:20] + head[24:28]
    return st.st_size, st.st_mtime_ns, header


def _check_in_flight(db: Path, header: bytes) -> None:
    """Raise :class:`Changing` when SQLite is writing ``db`` — by its journal, or by having it open in WAL."""
    wal = header[0] == 2 or header[1] == 2  # file format write/read version 2 = WAL
    journal = Path(f"{db}-journal")
    if journal.exists() and journal.stat().st_size > 0:
        raise Changing(f"{journal.name} exists")
    if wal and (Path(f"{db}-wal").exists() or Path(f"{db}-shm").exists()):
        raise Changing(f"{db.name} is open in WAL mode")


def _raise(exc: OSError) -> None:
    raise exc


def _is_link(path: Path) -> bool:
    return path.is_symlink() or (hasattr(os.path, "isjunction") and os.path.isjunction(path))


def tree_state(root: Path, only: list[str] | None = None) -> tuple[list[str], dict[str, tuple]]:
    """Folders and files under ``root`` (or just the files named in ``only``), each with its fingerprint.

    Raises :class:`Linked` for a link and :class:`Changing` for an SQLite transaction in flight.
    """
    folders: list[str] = []
    names: list[str] = []
    if only is not None:
        names = list(only)
    else:
        if _is_link(root):
            raise Linked(str(root))
        for here, dirs, files in os.walk(root, onerror=_raise):
            for d in dirs:
                if _is_link(Path(here) / d):
                    raise Linked(str(Path(here) / d))
            rel = Path(here).relative_to(root)
            folders.append(str(rel))
            names += [str(rel / f) for f in files]
    files: dict[str, tuple] = {}
    for name in names:
        path = root / name
        if path.is_symlink():
            raise Linked(str(path))
        if name.endswith(_SIDE_FILES):
            files[name] = (path.stat().st_size,)  # listed, so one appearing or going counts as a change
            continue
        files[name] = _fingerprint(path)
        if files[name][2] is not None:
            _check_in_flight(path, files[name][2])
    return folders, files


def size_of(root: Path) -> int:
    return sum(state[0] for state in tree_state(root)[1].values())


def copy_stable(
    src: Path,
    dst: Path,
    on_bytes: Callable[[int], None] = lambda _n: None,
    *,
    attempts: int = 3,
    pause: float = 1.0,
) -> None:
    """Copy the folder or file ``src`` to ``dst`` (which must not exist) as it stood at one moment.

    Raises :class:`Changing` when no try saw the source hold still, :class:`Linked` for a link,
    ``OSError`` for anything the file system refuses. ``dst`` is removed again on every failure.
    """
    single = src.is_file()
    root, only = (src.parent, [src.name]) if single else (src, None)
    for attempt in range(attempts):
        try:
            before = tree_state(root, only)
            for folder in before[0]:
                (dst / folder).mkdir(parents=True, exist_ok=True)
            for name in before[1]:
                if name.endswith(_SIDE_FILES):
                    continue  # empty or of a closed database: nothing to carry
                target = dst if single else dst / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with open_shared(root / name) as fin, open(target, "wb") as fout:
                    while chunk := fin.read(_CHUNK):
                        fout.write(chunk)
                        on_bytes(len(chunk))
            if tree_state(root, only) == before:
                return
        except Changing:  # a commit before, during or after the copy: wait, and take it again
            pass
        except BaseException:
            _remove(dst, single)
            raise
        _remove(dst, single)
        if attempt + 1 < attempts:
            time.sleep(pause)
    raise Changing(f"{src} kept changing while it was copied")


def _remove(dst: Path, single: bool) -> None:
    if single:
        dst.unlink(missing_ok=True)
    else:
        shutil.rmtree(dst, ignore_errors=True)
