"""Removing a workspace from disk as a whole: afterwards it is gone, or nothing has changed.

Brightway deletes a project by taking its row out of ``projects.db`` and then removing its folder file
by file. Where one of those files cannot be removed — on Windows every file some process has open: a
virus scan, a backup, a preview — that stops half-way: the workspace has left the list, part of its folder
is still there, and a workspace created under the same name afterwards starts in what was left.

So the folder goes first, and in one step: it is renamed to a name of ours beside it. Windows refuses to
rename a folder while a file in it is open, which makes the rename the test — it fails before anything
has changed, and the caller hears that the workspace is in use. Only then the row is deleted, and the
files last.

The folder's name says how far a deletion got, so a process that dies in the middle loses nothing:

* ``.removing-…`` — renamed, the row not deleted yet. The workspace is still listed and this is all of its
  data: :func:`recover` puts the folder back.
* ``.removed-…`` — the row is gone, only files are left, where no workspace will ever look.
  :func:`recover` removes them.

:func:`recover` runs when the app starts. What it cannot put back then stays where it is, and nothing
opens that workspace meanwhile: opening a listed workspace creates its folder, and after that nobody
could tell an interrupted deletion from a workspace that was created again under the name of a deleted
one. So every place that opens a workspace asks :func:`put_back` first, and every place that creates one
asks :func:`free_name`.
"""
from __future__ import annotations

import os
import re
import shutil
import time
import uuid
from pathlib import Path

from prism_lca import _log
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

#: The folder of a workspace that is being deleted, before and after its row went. Brightway's own folder
#: names are a slug and a hash and never start with a dot, so no workspace can have such a name.
_REMOVING = ".removing-"
_REMOVED = ".removed-"
#: ``<prefix><8 hex digits>-<the folder's own name>``
_ASIDE = re.compile(r"^\.remov(?:ing|ed)-[0-9a-f]{8}-(?P<folder>.+)$")

#: Seconds to wait before each further attempt to rename the folder. Some readers hold a file for a moment
#: only — our own search warm-up reads the workspace it was started in for a second or two after a switch —
#: and a delete that comes in just then should not be refused for it.
_RETRY_AFTER: tuple[float, ...] = (0.25, 0.5, 1.0, 1.5)


def _in_use(name: str, exc: OSError, what: str = "was not deleted: its folder is") -> PrismError:
    reason = exc.strerror or type(exc).__name__
    return PrismError(
        f"Workspace '{name}' {what} in use or cannot be changed ({reason}).",
        code="workspace_in_use",
        status_code=409,
        hint="Nothing was removed. Usually another program has one of the workspace's files open — a "
        "virus scan or a backup can be that program. Try again in a moment.",
    )


def _move_aside(folder: Path, name: str) -> Path:
    """Rename ``folder`` to a name of ours in the same directory; refuse when the system does."""
    aside = folder.with_name(f"{_REMOVING}{uuid.uuid4().hex[:8]}-{folder.name}")
    waits = iter(_RETRY_AFTER)
    while True:
        try:
            os.rename(folder, aside)
            return aside
        except OSError as exc:
            wait = next(waits, None)
            if wait is None:
                raise _in_use(name, exc) from exc
            time.sleep(wait)


def remove(name: str) -> None:
    """Delete the workspace ``name``: its row and its folder.

    The caller holds the project locks, has made another workspace the active one and has let go of
    everything this process itself keeps open in the folder. Raises a ``PrismError`` and changes nothing
    when the folder is in use.
    """
    from bw2data.project import ProjectDataset

    projects = get_bd().projects
    row = ProjectDataset.get(ProjectDataset.name == name)
    folder = Path(projects._project_dir(row))
    aside = _move_aside(folder, name) if folder.is_dir() else None
    try:
        ProjectDataset.delete().where(ProjectDataset.name == name).execute()
    except BaseException:
        if aside is not None:
            try:
                os.rename(aside, folder)  # the row is still there, so its folder has to be as well
            except OSError as exc:  # it stays set aside, and `put_back` guards the workspace until it is back
                _log.swallowed(exc, "workspace_removal.remove")
        raise
    if aside is None:
        return
    # The deletion is recorded; the name says so. Should even this rename be refused, the folder keeps
    # its first name, and `recover` knows it by the missing row.
    removed = aside.with_name(_REMOVED + aside.name[len(_REMOVING):])
    try:
        os.rename(aside, removed)
        aside = removed
    except OSError as exc:
        _log.swallowed(exc, "workspace_removal.remove")
    shutil.rmtree(aside, ignore_errors=True)
    if aside.exists():
        _log.swallowed(OSError(f"{aside} could not be removed completely"), "workspace_removal.remove")


def _set_aside(base: Path, folder_name: str, prefix: str = "") -> list[Path]:
    """The folders deletions have set aside for the workspace folder ``folder_name``."""
    found = []
    for aside in sorted(base.iterdir()):
        match = _ASIDE.match(aside.name)
        if match and match["folder"] == folder_name and aside.name.startswith(prefix) and aside.is_dir():
            found.append(aside)
    return found


def put_back(name: str) -> None:
    """Before the listed workspace ``name`` is opened: if a deletion that did not finish has set its
    folder aside, put it back. Raises a ``PrismError`` when that is refused — the workspace must not be
    opened then, or Brightway would give it an empty folder and its data would stay where nobody looks.
    """
    from bw2data.project import ProjectDataset

    projects = get_bd().projects
    row = ProjectDataset.get_or_none(ProjectDataset.name == name)
    if row is None:
        return
    folder = Path(projects._project_dir(row))
    if folder.exists():
        return
    for aside in _set_aside(folder.parent, folder.name, _REMOVING)[:1]:
        try:
            os.rename(aside, folder)
        except OSError as exc:
            reason = exc.strerror or type(exc).__name__
            raise PrismError(
                f"Workspace '{name}' cannot be opened yet: a deletion of it did not finish, and its folder "
                f"could not be put back ({reason}).",
                code="workspace_in_use",
                status_code=409,
                hint="Its data is complete. Usually another program has one of the workspace's files open "
                "— a virus scan or a backup can be that program. Try again in a moment.",
            ) from exc


def free_name(name: str) -> None:
    """Before a workspace called ``name`` is created: nothing a deleted workspace of that name left may
    still look unfinished. The name is not listed, so every folder set aside for it belongs to a deletion
    that went through; it gets the name that says so, or is removed. Raises a ``PrismError`` when neither
    works — created now, the new workspace would look like an interrupted deletion of the old one.
    """
    from bw2data.project import ProjectDataset

    projects = get_bd().projects
    folder = Path(projects._project_dir(ProjectDataset(name=name, full_hash=False)))
    for aside in _set_aside(folder.parent, folder.name, _REMOVING):
        try:
            os.rename(aside, aside.with_name(_REMOVED + aside.name[len(_REMOVING):]))
        except OSError as exc:
            shutil.rmtree(aside, ignore_errors=True)
            if aside.exists():
                raise _in_use(name, exc, "was not created: files of a deleted workspace of that name are") from exc


def recover() -> dict[str, int]:
    """At start-up, finish what a deletion left unfinished: put back the folder of a workspace that is
    still listed, remove the files of one that is not.

    Returns how many folders were ``restored`` and how many ``removed``. A folder that could not be put
    back stays, and :func:`put_back` tries again when its workspace is opened. One in doubt — its workspace
    is listed and has a folder already — is left alone: it may be all there is of that workspace's data.
    """
    from bw2data.project import ProjectDataset

    projects = get_bd().projects
    base = Path(projects._base_data_dir)
    listed = {Path(projects._project_dir(row)).name: row.name for row in ProjectDataset.select()}
    done = {"restored": 0, "removed": 0}
    for aside in sorted(base.iterdir()):
        match = _ASIDE.match(aside.name)
        if match is None or not aside.is_dir():
            continue
        if aside.name.startswith(_REMOVING) and match["folder"] in listed:
            if not (base / match["folder"]).exists():
                try:
                    put_back(listed[match["folder"]])
                    done["restored"] += 1
                except PrismError as exc:
                    _log.swallowed(exc, "workspace_removal.recover")
            continue
        shutil.rmtree(aside, ignore_errors=True)
        done["removed"] += not aside.exists()
    return done
