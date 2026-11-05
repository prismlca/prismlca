"""Carrying PrismLCA's workspaces over from a Brightway directory an earlier version shared.

Up to 0.9.9 the app followed an inherited ``BRIGHTWAY2_DIR`` and kept its workspaces among the projects
of the user's own Brightway installation; it no longer opens that directory (``engine/brightway_dir.py``).
On the first start in its own directory, the workspaces PrismLCA worked in over there are copied across,
so nothing looks lost.

Copied, never moved: a workspace there may just as well be an Activity Browser project the user opened
in PrismLCA, and the other installation keeps it. Nothing in the old directory is written, and nothing
there is opened by anything but a plain file read — not by bw2data, and not by SQLite, which in read-only
mode may still create a WAL database's ``-shm`` file or trip over a journal left behind. ``projects.db``
(with any journal beside it) is copied byte for byte first, and only the copy is opened.

Which projects: those whose folder holds ``prism_meta/`` or ``prism_search/``, the two folders PrismLCA
writes into a project it works in (its stores and audit log, its search index). A project PrismLCA only
listed has neither, and stays where it is.

Each copy records where it came from (``prism_meta/carried-over.json``) — in the copy: the original keeps
no mark of ours. The order makes it restartable: each project is copied under a temporary name and renamed when complete,
and ``projects.db`` comes last — a SQLite backup of the old one with every other project deleted. Its
existence is what "carried over" means, so an interrupted start simply copies again.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from prism_lca.engine.data_version import DATA_SCHEMA, read_schema

#: The folders PrismLCA writes into a Brightway project it works in.
MARKERS = ("prism_meta", "prism_search")
PROJECTS_DB = "projects.db"
#: In a carried-over workspace's ``prism_meta``: the folder it was copied from, and when.
ORIGIN_FILE = "carried-over.json"
_PARTIAL = ".carry-over-"
_CHUNK = 16 * 1024 * 1024
#: Room left over after the copy — an ecoinvent import or a report needs some, and a disk filled to the
#: last byte fails the next write instead of this one.
_HEADROOM = 512 * 1024 * 1024


@dataclass(frozen=True)
class Workspace:
    name: str
    #: The project's folder in the Brightway directory, as bw2data names it.
    folder: str
    size: int


def _gb(size: int) -> str:
    return f"{size / 1e9:.1f} GB"


def _size(folder: Path) -> int:
    return sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())


def _copy_projects_db(old: Path, new: Path) -> Path:
    """Copy ``projects.db`` and whatever journal lies beside it into ``new``; the copy's path.

    SQLite opens the copy and finishes a transaction the journal left open there, in our directory.
    """
    copy = new / f"{PROJECTS_DB}{_PARTIAL}tmp"
    for suffix in ("", "-journal", "-wal", "-shm"):
        Path(f"{copy}{suffix}").unlink(missing_ok=True)
        source = old / f"{PROJECTS_DB}{suffix}"
        if source.is_file():
            shutil.copyfile(source, f"{copy}{suffix}")
    return copy


def workspaces_in(old: Path, projects_db: Path) -> list[Workspace]:
    """PrismLCA's workspaces in another Brightway directory, from a copy of its ``projects.db``."""
    from bw_processing.filesystem import safe_filename  # how bw2data names a project's folder

    con = sqlite3.connect(projects_db)
    try:
        rows = con.execute("SELECT name, full_hash FROM projectdataset").fetchall()
    finally:
        con.close()
    found = []
    for name, full_hash in rows:
        folder = safe_filename(name, full=bool(full_hash))
        if any((old / folder / marker).is_dir() for marker in MARKERS):
            found.append(Workspace(name, folder, _size(old / folder)))
    return found


def _copy_tree(src: Path, dst: Path, on_bytes: Callable[[int], None]) -> None:
    """``shutil.copytree`` with a word after every chunk, because one ecoinvent database is a file of
    over a gigabyte and the shell gives up on a backend that stays silent for a minute."""
    for root, _dirs, files in os.walk(src):
        target = dst / Path(root).relative_to(src)
        target.mkdir(parents=True, exist_ok=True)
        for name in files:
            with open(Path(root) / name, "rb") as fin, open(target / name, "wb") as fout:
                while chunk := fin.read(_CHUNK):
                    fout.write(chunk)
                    on_bytes(len(chunk))
            shutil.copystat(Path(root) / name, target / name)


def _record_origin(copy: Path, source: Path) -> None:
    """Where a carried-over workspace came from — written into the copy, never beside the original."""
    meta = copy / "prism_meta"
    meta.mkdir(exist_ok=True)
    record = {"copied_from": str(source), "copied_at": datetime.now(UTC).isoformat(timespec="seconds")}
    (meta / ORIGIN_FILE).write_text(json.dumps(record, indent=1), encoding="utf-8")


def _finish_projects_db(copy: Path, new: Path, keep: list[str]) -> None:
    """The copy becomes the new ``projects.db``, every project but the carried ones deleted from it."""
    con = sqlite3.connect(copy)
    try:
        marks = ",".join("?" * len(keep))
        con.execute(f"DELETE FROM projectdataset WHERE name NOT IN ({marks})", keep)
        con.commit()
    finally:
        con.close()
    for suffix in ("-journal", "-wal", "-shm"):  # settled into the file by the close above
        Path(f"{copy}{suffix}").unlink(missing_ok=True)
    os.replace(copy, new / PROJECTS_DB)


def carry_over(
    old: Path, new: Path, progress: Callable[[str], None], log: Callable[[str], None]
) -> str | None:
    """Copy PrismLCA's workspaces from ``old`` into ``new`` once; None, or why the start must stop.

    Does nothing when ``new`` already has its ``projects.db`` — the app has been working there.
    """
    if (new / PROJECTS_DB).exists():
        return None
    schema, writer = read_schema(old)
    if schema is not None and schema > DATA_SCHEMA:
        log(f"Not copying the workspaces in {old}: PrismLCA {writer or 'a newer version'} wrote them.")
        return None
    if not (old / PROJECTS_DB).is_file():
        log(f"No Brightway projects in {old}; nothing to copy.")
        return None
    new.mkdir(parents=True, exist_ok=True)
    try:
        copy = _copy_projects_db(old, new)
        workspaces = workspaces_in(old, copy)
    except (OSError, sqlite3.Error) as exc:
        return (
            f"PrismLCA could not read the list of projects in {old} ({exc}). Nothing there was changed. "
            "Close other Brightway programs such as the Activity Browser and start again."
        )
    if not workspaces:
        Path(copy).unlink(missing_ok=True)
        log(f"No PrismLCA workspaces in {old}; nothing to copy.")
        return None
    total = sum(w.size for w in workspaces)
    free = shutil.disk_usage(new).free
    if free < total + _HEADROOM:
        Path(copy).unlink(missing_ok=True)
        return (
            f"PrismLCA no longer works inside {old}, which belongs to your Brightway installation, and "
            f"needs to copy {len(workspaces)} workspace(s) ({_gb(total)}) from there into {new}. Only "
            f"{_gb(free)} is free on that drive. Free some space and start again — or start PrismLCA with "
            f"PRISM_BRIGHTWAY_DIR={old} to keep working in the old directory."
        )
    copied = 0
    last = 0.0

    def tick(n: int, name: str) -> None:
        nonlocal copied, last
        copied += n
        now = time.monotonic()
        if now - last >= 0.5:
            last = now
            progress(f"Copying workspace '{name}' into PrismLCA's own folder… {copied * 100 // max(total, 1)}%")

    for ws in workspaces:
        target = new / ws.folder
        if target.exists():  # renamed into place by an earlier, interrupted start
            copied += ws.size
            continue
        partial = new / f"{_PARTIAL}{ws.folder}"
        shutil.rmtree(partial, ignore_errors=True)
        try:
            _copy_tree(old / ws.folder, partial, lambda n, name=ws.name: tick(n, name))
            _record_origin(partial, old / ws.folder)
        except OSError as exc:
            shutil.rmtree(partial, ignore_errors=True)
            return (
                f"Copying the workspace '{ws.name}' from {old} failed ({exc}). Nothing there was "
                "changed; the next start tries again."
            )
        os.replace(partial, target)
    _finish_projects_db(copy, new, [w.name for w in workspaces])
    log(
        f"Copied {len(workspaces)} workspace(s) ({_gb(total)}) from {old} into {new}: "
        + ", ".join(w.name for w in workspaces)
        + f". {old} itself is unchanged."
    )
    return None
