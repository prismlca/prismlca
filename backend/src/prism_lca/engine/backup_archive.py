"""Reading a workspace backup (bw2io's ``.tar.gz`` of one workspace folder) into a folder of ours.

A backup file is untrusted input: only regular files and folders are unpacked, every name stays inside the
target folder, and the member count and the bytes written are capped before anything is written.
"""
from __future__ import annotations

import json
import os
import shutil
import tarfile
import zlib
from dataclasses import dataclass
from pathlib import Path

from prism_lca.errors import PrismError

#: Far above any real workspace (its folder holds a few files per database and per LCIA method).
MAX_MEMBERS = 100_000
#: The name file bw2io writes is a few bytes of JSON.
MAX_NAME_FILE = 64 * 1024
#: Left free on every disk a restore writes to.
RESERVE = 512 * 1024 * 1024

_HINT = "Choose a .tar.gz written by Back up this workspace."
_LINKS = "This file holds links or special files, which a workspace backup does not."
_OUTSIDE = "This file holds entries outside its own folder, which a workspace backup does not."
_READ_ERRORS = (tarfile.TarError, OSError, EOFError, zlib.error)


def _unreadable(message: str = "This file is not a workspace backup.") -> PrismError:
    return PrismError(message, code="backup_unreadable", hint=_HINT)


def _gb(size: int) -> str:
    return f"{size / 1e9:.1f} GB"


def _too_many() -> PrismError:
    return _unreadable(
        f"This file holds more than {MAX_MEMBERS:,} entries, more than a workspace backup does."
    )


def read_name(fp: Path) -> str:
    """The workspace name stored in the backup (bw2io's ``.project-name.json``)."""
    try:
        with tarfile.open(fp, "r:gz") as tar:
            for count, member in enumerate(tar, 1):
                if count > MAX_MEMBERS:
                    raise _too_many()
                if (member.name.endswith("project-name.json") and member.isreg() and not member.issparse()
                        and member.size <= MAX_NAME_FILE):
                    handle = tar.extractfile(member)
                    if handle is not None:
                        return str(json.load(handle)["name"])
    except (*_READ_ERRORS, KeyError, ValueError, TypeError) as e:
        raise _unreadable() from e
    raise _unreadable()


def room_on(where: Path) -> int:
    """Bytes a restore may write to the disk holding ``where``."""
    return shutil.disk_usage(where).free - RESERVE


def assert_room(size: int, where: Path) -> None:
    room = room_on(where)
    if size > room:
        raise _no_room(size, room)


def _no_room(size: int, room: int) -> PrismError:
    return PrismError(
        f"There is not enough free space for this backup: it needs at least {_gb(size)}, "
        f"and {_gb(max(room, 0))} can be used.",
        code="backup_no_room",
        hint=f"Free some disk space and try again; {_gb(RESERVE)} stay free on the disk.",
        status_code=507,
    )


@dataclass(frozen=True)
class Unpacked:
    #: The workspace folder inside the folder the backup was unpacked into.
    folder: Path
    #: Bytes of file content written.
    size: int


def unpack(fp: Path, into: Path) -> Unpacked:
    """Unpack the backup at ``fp`` into the empty folder ``into``, member by member."""
    room = room_on(into)
    written = 0
    try:
        with tarfile.open(fp, "r:gz") as tar:
            for count, member in enumerate(tar, 1):
                if count > MAX_MEMBERS:
                    raise _too_many()
                if member.isreg() and not member.issparse():
                    written += member.size
                    if written > room:
                        raise _no_room(written, room)
                elif not member.isdir():
                    raise _unreadable(_LINKS)
                tar.extract(member, into, filter="data")
    except tarfile.FilterError as e:
        raise _unreadable(_OUTSIDE) from e
    except (tarfile.TarError, EOFError, zlib.error) as e:
        raise _unreadable() from e
    folders = [p for p in into.iterdir() if p.is_dir() and not p.is_symlink()]
    if len(folders) != 1:
        raise _unreadable()
    _assert_files_and_folders(into)
    return Unpacked(folders[0], written)


def _assert_files_and_folders(root: Path) -> None:
    """What was unpacked is regular files and folders only, whatever the platform made of the members."""
    for dirpath, dirnames, filenames in os.walk(root):
        for name in (*dirnames, *filenames):
            path = Path(dirpath, name)
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise _unreadable(_LINKS)
