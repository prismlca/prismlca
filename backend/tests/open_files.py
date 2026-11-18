"""What this process still holds open below a folder: how the workspace tests see that a workspace was let go of.

Windows refuses to delete, move or rename a folder while a file in it is open, so a connection left open is a
bug there and nothing on Linux. Linux can still show it, through ``/proc``, and these tests run there too.
"""
from __future__ import annotations

import os
from pathlib import Path


def open_files_under(folder: Path) -> list[str] | None:
    """The files below ``folder`` this process still has open, or None where /proc cannot say (Windows,
    macOS). A file that was deleted while open is listed too, as ``… (deleted)``: on Linux that works, on
    Windows it is the delete that fails."""
    fds = Path("/proc/self/fd")
    if not fds.is_dir():
        return None
    still_open = []
    for fd in fds.iterdir():
        try:
            target = os.readlink(fd)
        except OSError:
            continue
        if target.startswith(str(folder)):
            still_open.append(target)
    return sorted(still_open)
