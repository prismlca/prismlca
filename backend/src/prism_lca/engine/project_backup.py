"""A backup of the whole project — for yourself, and not to be sent to anybody.

The third of the three things people mean by "export", and the one most easily confused with the
other two. A `.prism` bundle is a **model** and carries no licensed data. The Excel sheets are an
**interchange** for Brightway. This is a **backup**: the entire project directory, which includes your
ecoinvent copy, and is therefore gigabytes and must not leave your machine.

Because that distinction is the whole point, this module states it in three places — here, in the
response, and in the UI — rather than trusting a dialog to keep saying it.

`bw2io.backup_project_directory()` does the tar; what it does not know about is `prism_meta/`, which
holds the tags, scenarios, study metadata, reports, views and the audit log. Those live *inside* the
project directory, so the tar takes them along — verified by a test, because if that ever changed the
backup would silently be missing everything PrismLCA knows and nothing would say so.
"""
from __future__ import annotations

from pathlib import Path

from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

#: Said in the response, not only in a dialog: a redesign of the UI cannot lose this.
WARNING = (
    "This archive contains the whole workspace — including your copy of the background database "
    "(ecoinvent). It is licensed data: keep the file for yourself, and do not pass it on. To share a "
    "model, export it as a .prism bundle instead, which carries references rather than data."
)


def estimate() -> dict:
    """How big the archive will be, roughly, so nobody starts a multi-gigabyte write by accident."""
    bd = get_bd()
    base = Path(bd.projects.dir)
    total = 0
    for path in base.rglob("*"):
        if path.is_file():
            try:
                total += path.stat().st_size
            except OSError:  # a file that vanished between listing and stat is not worth failing over
                continue
    return {
        "project": bd.projects.current,
        "bytes": total,
        "databases": sorted(bd.databases),
        "warning": WARNING,
    }


def write(target_dir: str | None = None) -> dict:
    """Write the archive and return where it went. Deliberately not streamed through the API.

    A project backup is measured in gigabytes; pushing that through the IPC bridge as base64 would
    triple it in memory for no gain. It lands as a file and the response says where — the one export in
    the app that hands over a path instead of bytes, for a reason that is about size, not taste.
    """
    from bw2io import backup_project_directory

    bd = get_bd()
    project = bd.projects.current
    if not project:
        raise PrismError("No workspace is active.", code="no_project")
    dest = Path(target_dir).expanduser() if target_dir else Path.home()
    if not dest.is_dir():
        raise PrismError(f"'{dest}' is not a directory.", code="backup_target_missing",
                         hint="Choose an existing folder to write the archive into.")
    out = backup_project_directory(project, dir_backup=str(dest))
    path = Path(str(out))
    return {
        "project": project,
        "path": str(path),
        "bytes": path.stat().st_size if path.exists() else 0,
        "warning": WARNING,
    }
