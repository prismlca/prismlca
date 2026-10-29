"""One PrismLCA per data directory.

Brightway keeps a project's parameters, its scenario overrides and its metadata in SQLite files
under ``BRIGHTWAY2_DIR``. Two backends against the same directory therefore write to the same
files, and SQLite answers the loser with ``OperationalError: database is locked`` — at whatever
moment it happens to be. Once, that moment was the write that puts a scenario's overrides *back*
after a report render, and the study's baseline silently stayed the heat-pump variant (the restore
in ``scenarios._restore`` is defended now, but every other write path is not, and cannot all be).

So the second instance does not start. Not "usually loses a race" — does not start, and says why.

**An OS advisory lock, not a PID file.** A PID file has to answer "is that process still alive?",
and every answer is wrong sometimes: a killed app leaves a file nobody cleans up, and a reused PID
locks out a legitimate start. The kernel already tracks this exactly — it drops the lock when the
holder dies, however it dies — so the only stale lock possible is one whose owner is genuinely
running. The PID written into the file is for the *message*, never for the decision.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

#: Held open for the life of the process: closing the handle releases the lock.
_handle: Any = None

LOCK_NAME = ".prism-instance.lock"


def _lock_exclusive(handle: Any) -> bool:
    """Take a non-blocking exclusive lock on an open file. False if somebody else holds it."""
    try:
        import fcntl

        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except ImportError:  # pragma: no cover - Windows
        import msvcrt

        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False
    except OSError:
        return False


def acquire(data_dir: str | os.PathLike[str]) -> dict | None:
    """Claim this data directory. Returns ``None`` on success, or the holder's details.

    Best-effort in one direction only: if the lock file cannot be created at all — a read-only
    directory, an exotic filesystem without locking — the start goes ahead. Refusing to run because
    we could not *check* would turn a guard into an outage, and the thing being guarded against
    needs two copies of the app to happen at all.
    """
    global _handle
    if _handle is not None:
        return None
    path = Path(data_dir) / LOCK_NAME
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a+", encoding="utf-8")
    except OSError:
        return None
    if not _lock_exclusive(handle):
        holder: dict = {}
        try:
            handle.seek(0)
            holder = json.loads(handle.read() or "{}")
        except (OSError, ValueError):
            pass
        handle.close()
        return {"path": str(path), **(holder if isinstance(holder, dict) else {})}
    _handle = handle
    # Written after the lock is ours, so the file always describes whoever actually holds it.
    try:
        handle.seek(0)
        handle.truncate()
        handle.write(json.dumps({"pid": os.getpid()}))
        handle.flush()
    except OSError:  # pragma: no cover - the lock is what matters; the note is a courtesy
        pass
    return None


def release() -> None:
    """Give the directory up. Called on a clean exit; a crash is handled by the kernel."""
    global _handle
    if _handle is None:
        return
    try:
        _handle.close()
    except OSError:  # pragma: no cover
        pass
    _handle = None
