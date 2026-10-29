"""What a project must not accumulate — run at startup and on every project switch.

Everything here is about files PrismLCA itself leaves behind on a user's machine, found in a sweep
of a long-lived development project. Each entry says where the residue used to come
from and how it is prevented now; the sweep itself only covers what a previous version has already
left, because a file that exists cannot be prevented any more.

* **bw2data's full-text index.** ``Activity.save()`` maintains an SQLite FTS index per database
  unless the database's metadata says ``searchable: False`` — and a database that was only
  ``register()``-ed says nothing, which bw2data reads as *yes*. PrismLCA searches its own index
  (``prism_search``) and never calls ``Database.search``, so that index was a write per save and
  132 MB of dead weight (115 MB for ecoinvent alone). Every place that creates a database now
  registers it ``searchable=False``; :func:`retire_search_indices` sets the flag on databases that
  predate this and removes the ``search/`` directory once.
* **The files bw2data keeps beside SQLite and never removes.** A database's processed arrays
  (``processed/<name>.<hash>.zip``, what bw2calc loads) survive ``Database.delete()`` and stay under
  the old name after ``rename()``; a method's zip and its ``intermediate/`` pickle survive
  ``deregister()`` — its docstring says so. Those files are needed while the object lives, so they
  cannot be prevented, only taken along: :func:`database_files` names them before the bw2data call,
  :func:`remove_files` removes them after, and :func:`deregister_method` does both for a method.
* **Attachments nobody cites any more.** Files a user hands the assistant live in
  ``prism_meta/sources/``, deduplicated across the project, so no model's deletion may take them.
  What may: the last chat message that names them going away. :func:`prune_attachments` is the
  same call the chat-delete route and the model-delete cascade make, here for what those missed.
* **Exchanges without a uid.** Imported models and library datasets were written without the
  ``prism_uid`` the editor addresses an exchange by; the importers set it now, and
  :func:`backfill_exchange_uids` gives one, once, to what earlier versions left.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from prism_lca import _log
from prism_lca.engine import attachments
from prism_lca.engine.bootstrap import get_bd


def retire_search_indices() -> int:
    """Turn bw2data's FTS index off for every database of the active project; remove what exists.

    Returns how many databases had the flag set. Idempotent: a project touched once costs a metadata
    read on the next start and nothing else.
    """
    bd = get_bd()
    changed = 0
    for name in list(bd.databases):
        if bd.databases[name].get("searchable") is not False:
            bd.databases[name]["searchable"] = False
            changed += 1
    if changed:
        bd.databases.flush()
    index_dir = Path(bd.projects.dir) / "search"
    if index_dir.exists():
        shutil.rmtree(index_dir, ignore_errors=True)
    return changed


def database_files(name: str) -> list[Path]:
    """The files bw2data holds for a database outside SQLite — to be named BEFORE delete or rename,
    while the name still resolves, and removed after."""
    db = get_bd().Database(name)
    return [Path(db.dirpath_processed()) / db.filename_processed()]


def _method_files(key: tuple) -> list[Path]:
    bd = get_bd()
    stem = bd.Method(key).filename  # the abbreviation — only known while the method is registered
    root = Path(bd.projects.dir)
    return [root / "processed" / f"{stem}.zip", root / "intermediate" / f"{stem}.pickle"]


def remove_files(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            _log.swallowed(exc, "hygiene.remove_files")  # a stray file, not a broken model


def deregister_method(key: tuple) -> None:
    """``Method.deregister()`` plus the two files it leaves behind."""
    files = _method_files(key)
    get_bd().Method(key).deregister()
    remove_files(files)


def prune_attachments() -> list[str]:
    """Attachments no stored chat message names any more — see ``attachments.prune_unreferenced``."""
    return attachments.prune_unreferenced()


def backfill_exchange_uids() -> int:
    """Give every exchange of every writable database a ``prism_uid``, once per database.

    Models imported from a ``.prism`` bundle and datasets from the import wizard were written
    without exchange uids in earlier versions, so their exchanges could be seen but not edited.
    The writers set them now; this heals what is already on disk. A database
    that has been through it is flagged and costs a metadata read afterwards. Backgrounds are
    read-only and never edited, so they are skipped. Returns how many exchanges got a uid.
    """
    from prism_lca.engine.commands import PROJECT_LOCK
    from prism_lca.engine.guardrails import is_read_only
    from prism_lca.engine.model import UIDS_KEY, ensure_exchange_uids

    # Unlike the other sweeps this one WRITES exchanges, and a workspace switch rebinds bw2data's
    # global database underneath any object still held: an exchange read in one workspace and saved
    # after a switch lands in the other. Activation runs hygiene after it
    # has released the lock, so the sweep takes it itself — a switch then waits for it to finish.
    with PROJECT_LOCK:
        bd = get_bd()
        given = 0
        flagged = False
        for name in list(bd.databases):
            meta = bd.databases[name]
            if meta.get(UIDS_KEY) or is_read_only(name):
                continue
            given += ensure_exchange_uids(name)
            bd.databases[name][UIDS_KEY] = True
            flagged = True
        if flagged:
            bd.databases.flush()
    return given


def run() -> None:
    """Every sweep, each failing on its own: hygiene must never keep the app from starting."""
    for step in (retire_search_indices, prune_attachments, backfill_exchange_uids):
        try:
            step()
        except Exception as exc:  # noqa: BLE001 - housekeeping, not the model
            _log.swallowed(exc, f"hygiene.{step.__name__}")
