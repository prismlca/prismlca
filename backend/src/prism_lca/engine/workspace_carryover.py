"""Carrying PrismLCA's workspaces over from a Brightway directory an earlier version shared.

Up to 0.9.9 the app followed an inherited ``BRIGHTWAY2_DIR`` and kept its workspaces among the projects
of the user's own Brightway installation; it no longer opens that directory (``engine/brightway_dir.py``).
On the first start in its own directory, the workspaces PrismLCA worked in over there are copied across,
so nothing looks lost.

Copied, never moved: a workspace there may just as well be an Activity Browser project the user opened
in PrismLCA, and the other installation keeps it. The other directory is only ever read, and only through
``engine/foreign_read.py``: no SQLite and no bw2data there, nothing locked, nothing created, and a copy
that does not reflect one consistent moment is taken again. ``projects.db`` is copied the same way, and
only the copy is opened.

Which projects: those whose folder holds ``prism_meta/`` or ``prism_search/``, the two folders PrismLCA
writes into a project it works in (its stores and audit log, its search index). A project PrismLCA only
listed has neither, and stays where it is.

Each copy records where it came from (``prism_meta/carried-over.json``) — in the copy: the original keeps
no mark of ours. The order makes it restartable: each project is copied under a temporary name and
renamed when complete, and ``projects.db`` comes last, every project but the carried ones deleted from
its copy. Its existence is what "carried over" means, so an interrupted start continues where it stopped.
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

from prism_lca.engine import foreign_read
from prism_lca.engine.data_version import DATA_SCHEMA, read_schema

#: The folders PrismLCA writes into a Brightway project it works in.
MARKERS = ("prism_meta", "prism_search")
PROJECTS_DB = "projects.db"
#: In a carried-over workspace's ``prism_meta``: the folder it was copied from, and when.
ORIGIN_FILE = "carried-over.json"
_PARTIAL = ".carry-over-"
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
            found.append(Workspace(name, folder, foreign_read.size_of(old / folder)))
    return found


def _clear_partials(new: Path) -> None:
    """What an interrupted carry-over of ours left in our own directory."""
    for leftover in new.glob(f"*{_PARTIAL}*"):
        if leftover.is_dir():
            shutil.rmtree(leftover, ignore_errors=True)
        else:
            leftover.unlink(missing_ok=True)


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
    os.replace(copy, new / PROJECTS_DB)


def _busy(old: Path) -> str:
    return (
        f"Another program is working in {old} — an open Brightway project, perhaps in the Activity "
        "Browser — so PrismLCA cannot take a consistent copy of its earlier workspaces from there yet. "
        "Nothing there was changed. Close that program and start PrismLCA again."
    )


def _linked(old: Path, where: str) -> str:
    return (
        f"A PrismLCA workspace in {old} contains a link ({where}). PrismLCA copies only plain folders and "
        "has changed nothing there. Replace the link with the folder it points to and start again — or "
        "unset BRIGHTWAY2_DIR to start without these workspaces."
    )


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
    progress(f"Looking for earlier PrismLCA workspaces in {old}…")
    new.mkdir(parents=True, exist_ok=True)
    _clear_partials(new)
    copy = new / f"{PROJECTS_DB}{_PARTIAL}tmp"
    try:
        foreign_read.copy_stable(old / PROJECTS_DB, copy)
        workspaces = workspaces_in(old, copy)
    except foreign_read.Changing:
        return _busy(old)
    except foreign_read.Linked as exc:
        return _linked(old, str(exc))
    except (OSError, sqlite3.Error) as exc:
        copy.unlink(missing_ok=True)
        return f"PrismLCA could not read the list of projects in {old} ({exc}). Nothing there was changed."
    if not workspaces:
        copy.unlink(missing_ok=True)
        log(f"No PrismLCA workspaces in {old}; nothing to copy.")
        return None
    remaining = [w for w in workspaces if not (new / w.folder).exists()]  # renamed in by an earlier start
    total = sum(w.size for w in remaining)
    free = shutil.disk_usage(new).free
    if free < total + _HEADROOM:
        copy.unlink(missing_ok=True)
        return (
            f"PrismLCA no longer works inside {old}, which belongs to your Brightway installation, and "
            f"needs to copy {len(remaining)} workspace(s) ({_gb(total)}) from there into {new}. Only "
            f"{_gb(free)} is free on that drive. Free some space and start again, or set "
            "PRISM_BRIGHTWAY_DIR to an empty folder on a drive with more room."
        )
    copied = 0
    last = 0.0

    def tick(n: int, name: str) -> None:
        nonlocal copied, last
        copied += n
        now = time.monotonic()
        if now - last >= 0.5:
            last = now
            pct = min(99, copied * 100 // max(total, 1))
            progress(f"Copying workspace '{name}' into PrismLCA's own folder… {pct}%")

    for ws in remaining:
        partial = new / f"{_PARTIAL}{ws.folder}"
        try:
            foreign_read.copy_stable(old / ws.folder, partial, lambda n, name=ws.name: tick(n, name))
            _record_origin(partial, old / ws.folder)
        except foreign_read.Changing:
            return _busy(old)
        except foreign_read.Linked as exc:
            return _linked(old, str(exc))
        except OSError as exc:
            shutil.rmtree(partial, ignore_errors=True)
            return (
                f"Copying the workspace '{ws.name}' from {old} failed ({exc}). Nothing there was "
                "changed; the next start tries again."
            )
        os.replace(partial, new / ws.folder)
    _finish_projects_db(copy, new, [w.name for w in workspaces])
    log(
        f"Copied {len(remaining)} workspace(s) ({_gb(total)}) from {old} into {new}: "
        + ", ".join(w.name for w in remaining)
        + f". {old} itself is unchanged."
    )
    return None
