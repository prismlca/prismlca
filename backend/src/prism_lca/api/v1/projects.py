"""Project management endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from prism_lca import _log
from prism_lca.api.v1.deps import require_token
from prism_lca.engine import audit_store, commands, ecoinvent, lca, maintenance
from prism_lca.repository.base import ProjectInfo

router = APIRouter(prefix="/projects", tags=["projects"], dependencies=[Depends(require_token)])


def _project_changed(request: Request, *, replaced: bool = False) -> None:
    """Everything that has to happen when the ground under the caches moves — one function, so a
    fifth project route cannot quietly skip half of it.

    ``replaced`` is for the two routes that change the data BEHIND a project name — a backup
    restored over an existing project, a project deleted (and maybe recreated under the same name).
    The factorisation cache and the loaded search indexes are keyed by project and database name,
    so for them nothing has moved: a switch to another project is caught by the key, a restore
    over the same project is not, and the next calculation would answer from the matrices of the
    data that was just replaced — numerically plausible, wrong.

    **The undo/redo stacks are dropped**. They hold Command objects naming databases and
    activity codes of the project they ran in, and unlike the audit log they do not follow a project
    switch. `Undo` after a switch therefore called `undo()` on a command of the previous project, and
    where both projects hold a model of the same name it changed data in the wrong one — no error, no
    message. The frontend reads `GET /model/history`, so the buttons go grey instead of a 409.

    **The audit line counts are dropped**. `audit_store._counts` is keyed by the *path string*,
    and a deleted project that is recreated under the same name gets the same path — so the old line
    count survived and `next_index()` handed out indices for a file that no longer had those lines.
    The visible half is `AuditLog.tsx`'s `key={a.index}`: duplicate React keys, and a log whose
    indices lie.

    **The search indexes are warmed**. The vector index, the BM25 corpus and the geo-variant
    map are cached per `project/database`, so a switch leaves all three cold and the first search in
    the new project pays them — the same 22 s that `SearchService.warm()` was written to take off
    the app start (V341), which until now ran once at startup and never again. Measured on a
    throwaway project with the real model: 9.95 s for a cold first search against 1.44 s warm, and
    the 1.44 s is the query embedding itself, which no cache can take away.
    """
    if replaced:
        lca.invalidate_lca_cache(model_change=True)
        request.app.state.search.forget_loaded()
    # A pending import was read and matched against the OLD project's databases; commit refuses it
    # now (import_project_changed), and dropping it here says so one step earlier.
    from prism_lca.engine.dataimport import session as import_session

    import_session.cancel()
    request.app.state.command_bus.clear_history()
    audit_store.reset_cache()
    request.app.state.search.warm_indexes()


class CreateProjectRequest(BaseModel):
    name: str


class BackupRequest(BaseModel):
    dir_backup: str | None = None


class RestoreRequest(BaseModel):
    path: str
    project_name: str | None = None
    overwrite: bool = False


@router.get("", response_model=list[ProjectInfo], summary="List projects")
async def list_projects(request: Request) -> list[ProjectInfo]:
    return request.app.state.repository.list_projects()


# Every route below that moves Brightway's global project state runs as a plain `def` (FastAPI's
# threadpool) and takes the LCA lock for the move itself. A scenario calculation holds that lock
# from "apply the overrides" through "restore the baseline" (scenarios.applied); a project switch
# in between made the restore write the baseline it had read in project A into the model of the
# same name in project B, and left A standing in the scenario. Waiting on the lock means the switch
# lands after the calculation, on a model that is back at its baseline — and it waits in its own
# thread, not on the event loop, so nothing else is held up by it.


@router.post("", response_model=ProjectInfo, summary="Create and activate a project")
def create_project(request: Request, body: CreateProjectRequest) -> ProjectInfo:
    with lca._LCA_LOCK, commands.PROJECT_LOCK:
        ecoinvent.assert_no_import_running("creating a workspace")
        info = request.app.state.repository.create_project(body.name)  # creates AND activates
    _project_changed(request)
    return info


@router.post("/backup", summary="Snapshot the active project to a tar.gz")
def backup_project(body: BackupRequest) -> dict:
    # Read-only as far as the active project is concerned: nothing is switched and nothing is
    # written into it, so the stacks still describe the project the caller is standing in. The lock
    # is still needed: a backup taken inside a scenario window would archive the overridden model.
    with lca._LCA_LOCK:
        return maintenance.backup_project(body.dir_backup)


@router.post("/restore", summary="Restore a project from a backup tar.gz")
def restore_project(request: Request, body: RestoreRequest) -> dict:
    with lca._LCA_LOCK, commands.PROJECT_LOCK:
        ecoinvent.assert_no_import_running("restoring a workspace")
        result = maintenance.restore_project(body.path, body.project_name, body.overwrite)
        # An overwrite of the ACTIVE workspace can put a legacy layout under it (engine/study.py). Brightway
        # copies the backup OVER the folder, so its legacy files are the backup's and must win. A restore
        # into another workspace leaves the active one alone; that one is migrated when it is activated.
        from prism_lca.engine.bootstrap import get_bd
        from prism_lca.errors import PrismError

        study_error: OSError | None = None
        if body.overwrite and result.get("project_name") == get_bd().projects.current:
            from prism_lca.engine import study

            try:
                study.migrate_active_workspace(prefer_legacy=True)
            except OSError as exc:
                study_error = exc
    # `overwrite=True` replaces a project directory under a path that may already be cached, audit
    # log included — so the counts have to go even though no project was activated here. Also when the
    # study step below failed: the restore itself has happened.
    _project_changed(request, replaced=True)
    if study_error is not None:
        # Not swallowed like at startup: without the marker the backup's study metadata could lose to
        # the pre-restore one later. Said now, while the backup is still at hand.
        raise PrismError(
            "The backup was restored, but its study metadata could not be put in place.",
            code="restore_study_incomplete",
            status_code=500,
            hint=f"Check that the workspace folder is writable, then restore again. ({study_error})",
        ) from study_error
    return result


@router.post("/{name}/activate", response_model=ProjectInfo, summary="Activate a project")
def activate_project(request: Request, name: str) -> ProjectInfo:
    with lca._LCA_LOCK, commands.PROJECT_LOCK:
        ecoinvent.assert_no_import_running("switching workspaces")
        info = request.app.state.repository.set_current_project(name)
        # Inside the lock, before anything can create, rename or delete a model (engine/study.py).
        from prism_lca.app import _migrate_study_files

        _migrate_study_files()
    # The crash marker lives in the project directory, so this is the first moment anyone could read
    # THIS project's model — the same check the app does at startup. Imported here, not at module
    # level: the app factory imports this router.
    from prism_lca.app import _ensure_library, _hygiene, recover_param_window

    _project_changed(request)
    recover_param_window(request.app)
    _ensure_library(request.app)
    _hygiene()
    # The same one-time migration the app start runs, for the same reason: a project that was last
    # opened by an older version still keeps its parameters and scenarios project-wide, and the
    # per-model readers see none of them until it has run. Startup only ever migrates the project
    # it starts in; switching to another old project has to do it too.
    try:
        from prism_lca.engine import params as _params

        _params.migrate_project_to_models()
    except Exception as exc:  # noqa: BLE001 - never let a migration block a project switch
        _log.swallowed(exc, "activate_project")
    return info


@router.delete("/{name}", summary="Delete a project (and its data) via Brightway")
def delete_project(request: Request, name: str) -> dict:
    with lca._LCA_LOCK, commands.PROJECT_LOCK:
        ecoinvent.assert_no_import_running("deleting a workspace")
        request.app.state.repository.delete_project(name)
        # Deleting the active workspace switches to 'default' — an activation by another name.
        from prism_lca.app import _migrate_study_files

        _migrate_study_files()
    # Yes, delete needs this too, and not only for the line counts. Deleting the project you are
    # standing in drops you into 'default' (the repository switches first, because Brightway cannot
    # delete the active project) — which is a project switch by another name, and leaves the stacks
    # pointing at a project that no longer exists. Deleting some *other* project cannot poison the
    # stacks, so this is unconditional for the simpler reason: a route that clears only sometimes is
    # a route someone will get wrong. `replaced`: a project recreated under this name gets the same
    # cache keys, and must not inherit the deleted one's factorisation or search index.
    _project_changed(request, replaced=True)
    return {"deleted": name}
