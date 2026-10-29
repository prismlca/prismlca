"""Robustness / operations helpers (M22): delete-preview, project backup/restore, support bundle.

These are the guardrails that keep a project recoverable: see the dependency cascade *before*
deleting, snapshot the whole project before a risky operation, and export a support bundle
(versions + health + audit, never inventory data) when something goes wrong.
"""
from __future__ import annotations

import io
import json
import zipfile

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


def backup_project_name(fp: str) -> str:
    """The workspace name stored in a backup archive (bw2io writes it as ``.project-name.json``)."""
    import tarfile
    from pathlib import Path

    if not Path(fp).is_file():
        raise PrismError(f"No file at '{fp}'.", code="backup_not_found")
    try:
        with tarfile.open(fp, "r:gz") as tar:
            for member in tar:
                if member.name.endswith("project-name.json"):
                    handle = tar.extractfile(member)
                    if handle is not None:
                        return str(json.load(handle)["name"])
    except (tarfile.TarError, OSError, KeyError, ValueError) as e:
        raise PrismError("This file is not a workspace backup.", code="backup_unreadable",
                         hint="Choose a .tar.gz written by Back up this workspace.") from e
    raise PrismError("This file is not a workspace backup.", code="backup_unreadable",
                     hint="Choose a .tar.gz written by Back up this workspace.")


def restore_project(fp: str, project_name: str | None = None, overwrite: bool = False) -> dict:
    """Restore a project from a backup tar.gz.

    An existing workspace of the same name is a refusal with its own code, not bw2io's ValueError: the
    app asks for another name then, and never overwrites one by accident (``overwrite`` stays an explicit
    API choice).
    """
    name = (project_name or "").strip() or backup_project_name(fp)
    projects = get_bd().projects
    if name in projects:
        if not overwrite:
            raise PrismError(f"A workspace named '{name}' already exists.", code="workspace_exists",
                             hint="Restore it under another name, or delete the existing workspace first.",
                             status_code=409)
        # The explicit overwrite (API only) keeps bw2io's route, which switches workspaces while it copies.
        get_bi().restore_project_directory(fp, project_name=name, overwrite_existing=True)
    else:
        _restore_as_new_project(fp, name)
    return {"restored_from": fp, "project_name": name}


def _restore_as_new_project(fp: str, name: str) -> None:
    """Unpack a backup into a NEW workspace without ever making it the active one.

    bw2io's restore activates the target workspace for the minutes the copy takes. Writers that do not
    take PROJECT_LOCK (chat history, views) would then land in — or be overwritten by — the workspace being
    restored. So: extract to a temp dir, copy into the directory bw2data would
    use for that name, and only then register the project. The active workspace never changes.
    """
    import shutil
    import tempfile
    from pathlib import Path

    from bw2data.project import ProjectDataset, project_created
    from bw2io.backup import _METADATA_FIELDS, _extract_single_directory_tarball

    projects = get_bd().projects
    td = Path(tempfile.mkdtemp())
    try:
        extracted = _extract_single_directory_tarball(filepath=Path(fp), output_dir=td)
        meta_file = extracted / "project-metadata.json"
        metadata = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.is_file() else {}
        full_hash = bool(metadata.get("full_hash", False))
        target = projects._project_dir(ProjectDataset(name=name, full_hash=full_hash))
        if target.exists():
            raise PrismError(f"A folder for a workspace named '{name}' is already on disk.",
                             code="workspace_exists", status_code=409,
                             hint="Restore it under another name.")
        try:
            shutil.copytree(extracted, target)
        except BaseException:
            # A copy that died half-way (disk full) leaves a folder no project row points to — invisible
            # in the app and in the way of the next attempt. It did not exist before, so it goes.
            shutil.rmtree(target, ignore_errors=True)
            raise
    finally:
        shutil.rmtree(td, ignore_errors=True)
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
