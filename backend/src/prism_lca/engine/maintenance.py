"""Robustness / operations helpers (M22): delete-preview, project backup/restore, support bundle.

These are the guardrails that keep a project recoverable: see the dependency cascade *before*
deleting, snapshot the whole project before a risky operation, and export a support bundle
(versions + health + audit, never inventory data) when something goes wrong.
"""
from __future__ import annotations

import io
import json
import shutil
import tempfile
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from prism_lca.engine import backup_archive, skills_store, workspace_pickles
from prism_lca.engine.bootstrap import get_bd, get_bi
from prism_lca.engine.guardrails import is_read_only
from prism_lca.engine.model import _db_or_404
from prism_lca.errors import PrismError

# NB: never `import bw2io`/`bw2data` at module top level — that imports bw2data eagerly, before
# bootstrap sets BRIGHTWAY2_DIR, so bw2data would initialise on its default ~/.local/share/Brightway3
# dir instead of the app data dir. Always go through the lazy get_bd()/get_bi() accessors.


def delete_preview(database: str, code: str) -> dict:
    """List every activity that consumes ``database/code`` as an input, so the user sees the
    dependency cascade a deletion would break. Scans foreground (writable) databases plus the
    activity's own database (background DBs are read-only and never edited here)."""
    bd = get_bd()
    database = _db_or_404(bd, database)
    target = (database, code)

    scan = {database} | {d for d in bd.databases if not is_read_only(d)}
    dependents: list[dict] = []
    for db_name in scan:
        for act in bd.Database(db_name):
            if act.key == target:
                continue
            for ex in act.exchanges():
                if ex.get("type") == "production":
                    continue
                if tuple(ex.input.key) == target:
                    dependents.append(
                        {
                            "database": act.key[0],
                            "code": act.key[1],
                            "name": act.get("name"),
                            "exchange_type": ex.get("type"),
                            "amount": ex.get("amount"),
                            "uid": ex.get("prism_uid"),
                        }
                    )
    return {
        "target": {"database": database, "code": code},
        "scanned_databases": sorted(scan),
        "dependent_count": len(dependents),
        "blocked": bool(dependents),
        "dependents": dependents,
    }


def backup_project(dir_backup: str | None = None) -> dict:
    """Snapshot the active project to a tar.gz (bw2io). Use before risky bulk operations."""
    bd = get_bd()
    project = bd.projects.current
    path = get_bi().backup_project_directory(project, dir_backup=dir_backup)
    return {"project": project, "path": str(path)}


#: bw2io's ``project-metadata.json`` holds four small fields.
_MAX_METADATA_FILE = 1024 * 1024


@dataclass(frozen=True)
class StagedBackup:
    """A backup unpacked into a temp folder of its own and checked, not yet a workspace."""

    source: str
    name: str
    #: The unpacked workspace folder.
    folder: Path
    #: Bytes of file content in ``folder``.
    size: int
    #: bw2io's ``project-metadata.json``, empty when the backup has none.
    metadata: dict


def _name_taken(name: str) -> PrismError:
    return PrismError(f"A workspace named '{name}' already exists.", code="workspace_exists",
                      hint="Restore it under another name, or delete the existing workspace first.",
                      status_code=409)


def _read_metadata(folder: Path) -> dict:
    meta_file = folder / "project-metadata.json"
    if not meta_file.is_file():
        return {}
    try:
        if meta_file.stat().st_size > _MAX_METADATA_FILE:
            raise ValueError("oversized")
        metadata = json.loads(meta_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise PrismError("This file is not a workspace backup.", code="backup_unreadable",
                         hint="Choose a .tar.gz written by Back up this workspace.") from e
    if not isinstance(metadata, dict):
        raise PrismError("This file is not a workspace backup.", code="backup_unreadable",
                         hint="Choose a .tar.gz written by Back up this workspace.")
    return metadata


@contextmanager
def staged_backup(
    fp: str, project_name: str | None = None, overwrite: bool = False
) -> Iterator[StagedBackup]:
    """Unpack and check a backup in a temp folder that is removed on exit; the skills in it are switched off.

    Touches nothing but the file and that folder, so callers run it outside the project locks; the name is
    checked here to refuse early and again by :func:`restore_project`, which runs inside them.
    """
    path = Path(fp)
    if not path.is_file():
        raise PrismError(f"No file at '{fp}'.", code="backup_not_found")
    name = (project_name or "").strip() or backup_archive.read_name(path)
    if name in get_bd().projects and not overwrite:
        raise _name_taken(name)
    td = Path(tempfile.mkdtemp(prefix="prism-restore-"))
    try:
        unpacked = backup_archive.unpack(path, td)
        workspace_pickles.assert_plain(unpacked.folder)
        skills_store.hold_restored(unpacked.folder)
        yield StagedBackup(fp, name, unpacked.folder, unpacked.size, _read_metadata(unpacked.folder))
    finally:
        shutil.rmtree(td, ignore_errors=True)


def restore_project(staged: StagedBackup, overwrite: bool = False) -> dict:
    """Make a staged backup a workspace. The caller holds the project locks.

    An existing workspace of the same name is a refusal with its own code, not bw2io's ValueError: the
    app asks for another name then, and never overwrites one by accident (``overwrite`` stays an explicit
    API choice).
    """
    name = staged.name
    if name in get_bd().projects:
        if not overwrite:
            raise _name_taken(name)
        _restore_over_existing(staged)
    else:
        _restore_as_new_project(staged)
    return {"restored_from": staged.source, "project_name": name}


def _restore_over_existing(staged: StagedBackup) -> None:
    """The explicit overwrite (API only), as bw2io's ``restore_project_directory`` does it: switch to the
    workspace, copy the backup over its folder, take over its metadata, switch back. The copy is of the
    checked folder; bw2io would unpack the file again."""
    from bw2io.backup import _remove_project_metadata, _restore_project_metadata

    projects = get_bd().projects
    previous = projects.current
    projects.set_current(staged.name, update=False)
    try:
        backup_archive.assert_room(staged.size, Path(projects.dir))
        shutil.copytree(staged.folder, projects.dir, dirs_exist_ok=True)
        _restore_project_metadata()
        _remove_project_metadata()
    finally:
        projects.set_current(previous)


def _restore_as_new_project(staged: StagedBackup) -> None:
    """Copy a staged backup into a NEW workspace without ever making it the active one.

    bw2io's restore activates the target workspace for the minutes the copy takes. Writers that do not
    take PROJECT_LOCK (chat history, views) would then land in — or be overwritten by — the workspace being
    restored. So: copy into the directory bw2data would use for that name, and only then register the
    project. The active workspace never changes.
    """
    from bw2data.project import ProjectDataset, project_created
    from bw2io.backup import _METADATA_FIELDS

    projects = get_bd().projects
    name, metadata = staged.name, staged.metadata
    full_hash = bool(metadata.get("full_hash", False))
    target = projects._project_dir(ProjectDataset(name=name, full_hash=full_hash))
    if target.exists():
        raise PrismError(f"A folder for a workspace named '{name}' is already on disk.",
                         code="workspace_exists", status_code=409,
                         hint="Restore it under another name.")
    backup_archive.assert_room(staged.size, target.parent)
    try:
        shutil.copytree(staged.folder, target)
    except BaseException:
        # A copy that died half-way (disk full) leaves a folder no project row points to — invisible
        # in the app and in the way of the next attempt. It did not exist before, so it goes.
        shutil.rmtree(target, ignore_errors=True)
        raise
    try:
        row = ProjectDataset.create(data={"25": True}, name=name, full_hash=full_hash)
    except BaseException:
        shutil.rmtree(target, ignore_errors=True)
        raise
    for field in _METADATA_FIELDS:
        if field in metadata:
            setattr(row, field, metadata[field])
    row.save()
    (target / "project-metadata.json").unlink(missing_ok=True)
    project_created.send(row)


def support_bundle(version: str, audit: list, health: dict) -> bytes:
    """ZIP with app/engine versions, per-database model-health, and the audit log — no inventory
    data, so it is safe to share for troubleshooting."""
    import bw2calc
    import bw2data

    info = {
        "app_version": version,
        "engine": {
            "bw2data": bw2data.__version__ if isinstance(bw2data.__version__, str)
            else ".".join(map(str, bw2data.__version__)),
            "bw2calc": getattr(bw2calc, "__version__", "?"),
        },
        "current_project": get_bd().projects.current,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("info.json", json.dumps(info, indent=2, default=str))
        z.writestr("health.json", json.dumps(health, indent=2, default=str))
        z.writestr("audit.json", json.dumps(audit, indent=2, default=str))
    return buf.getvalue()
