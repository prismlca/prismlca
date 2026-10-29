"""Database endpoints (of the active project)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import commands, model_folders, model_scope
from prism_lca.repository.base import DatabaseInfo

router = APIRouter(prefix="/databases", tags=["databases"], dependencies=[Depends(require_token)])


class CreateForegroundRequest(BaseModel):
    name: str = "foreground"


class DuplicateForegroundRequest(BaseModel):
    source: str
    name: str


class RenameForegroundRequest(BaseModel):
    database: str
    name: str
    source: str = "user"


class DeleteForegroundRequest(BaseModel):
    database: str
    source: str = "user"


class FolderRequest(BaseModel):
    name: str


class FolderRenameRequest(BaseModel):
    id: str
    name: str


class FolderDeleteRequest(BaseModel):
    id: str


class FolderAssignRequest(BaseModel):
    database: str
    #: null / "" takes the model out of whatever folder it is in.
    folder_id: str | None = None


@router.get("/folders", summary="Model folders and which model sits in which")
async def list_folders() -> dict:
    """Both halves in one call — see `model_folders.state` for why they cannot be fetched apart."""
    return model_folders.state()


@router.post("/folders", summary="Create a model folder")
async def create_folder(body: FolderRequest) -> dict:
    return model_folders.create(body.name)


@router.post("/folders/rename", summary="Rename a model folder")
async def rename_folder(body: FolderRenameRequest) -> dict:
    return model_folders.rename(body.id, body.name)


@router.post("/folders/delete", summary="Delete a folder (the models in it survive, unfiled)")
async def delete_folder(body: FolderDeleteRequest) -> dict:
    return model_folders.delete(body.id)


@router.post("/folders/assign", summary="Move a model into a folder, or out of one")
async def assign_folder(body: FolderAssignRequest) -> dict:
    return model_folders.assign(body.database, body.folder_id or None)


@router.get("", response_model=list[DatabaseInfo], summary="List databases with read-only status")
async def list_databases(request: Request) -> list[DatabaseInfo]:
    return request.app.state.repository.list_databases()


@router.post(
    "/foreground",
    response_model=DatabaseInfo,
    summary="Create a writable foreground database",
)
async def create_foreground(request: Request, body: CreateForegroundRequest) -> DatabaseInfo:
    model_scope.assert_no_new_model("create a model")
    # Check and mutation as one step: a project switch cannot land in between.
    with commands.project_guard():
        info = request.app.state.repository.create_foreground_database(body.name)
    request.app.state.command_bus.note(
        "user", "create_model", f"Create model '{body.name}'", database=body.name
    )
    return info


@router.post(
    "/foreground/duplicate",
    response_model=DatabaseInfo,
    summary="Duplicate a foreground model into a new writable database",
)
async def duplicate_foreground(request: Request, body: DuplicateForegroundRequest) -> DatabaseInfo:
    model_scope.assert_no_new_model("copy a model")
    with commands.project_guard():
        info = request.app.state.repository.duplicate_foreground_database(body.source, body.name)
    # The new model starts with one line and looks like it came from nothing, while all of its
    # substance came from `source`. `related` is what lets its history say so.
    # A copy lands beside its original, which is where the person who made it will look for it.
    model_folders.copy(body.source, body.name)
    request.app.state.command_bus.note(
        "user", "duplicate_model", f"Duplicate model '{body.source}' → '{body.name}'",
        database=body.name, related=body.source,
    )
    return info


@router.post("/foreground/rename", response_model=DatabaseInfo, summary="Rename a foreground model")
async def rename_foreground(request: Request, body: RenameForegroundRequest) -> DatabaseInfo:
    # The chat may rename its own model; the cascade that follows (other models' comparison lists and
    # views point at the new name) keeps the workspace consistent and writes no content.
    model_scope.assert_model_write(body.database)
    with commands.project_guard():
        info = request.app.state.repository.rename_foreground_database(body.database, body.name)
    # The search index is keyed by database name — drop the old one or a future database reusing
    # the old name would serve stale results.
    request.app.state.search.invalidate(body.database)
    # The NEW name: append-only means the log is never rewritten, so a rename is a line in the
    # history of the model as it is called from now on, and reading back further is the reader's job.
    # `related` stays empty — it means "came from another model", not "used to be called".
    #
    # `previous_name` is what makes reading back possible, and it has to be a **field**: this note and
    # its siblings (`create_model`, `delete_model`) are the timeline the read side walks, and an entry
    # belongs to whichever model carried its name *at its position in the log*. The sentence
    # below stays exactly as it is — it is what the user reads — but it is not what the resolver
    # reads: a model name is free text and may itself contain quotes or an arrow, so parsing
    # "Rename model 'A' → 'B'" would be guessing identity out of prose, which is F3's family.
    # Folder membership travels with the rename inside the repository's cascade (per_model_stores),
    # like every other name-keyed store — it used to be this route's job, so a rename that did not
    # come through here quietly emptied the folder the model was filed in.
    request.app.state.command_bus.note(
        body.source, "rename_model", f"Rename model '{body.database}' → '{body.name}'",
        database=body.name, previous_name=body.database,
    )
    # Its undo steps name the old model and cannot follow it.
    request.app.state.command_bus.forget_model(body.database)
    return info


@router.post("/foreground/delete", summary="Delete a foreground model and its processes")
async def delete_foreground(request: Request, body: DeleteForegroundRequest) -> dict:
    model_scope.assert_no_new_model("delete a model")
    with commands.project_guard():
        result = request.app.state.repository.delete_foreground_database(body.database)
    request.app.state.search.invalidate(body.database)  # see rename: index is name-keyed
    # The entries keep pointing at a name that no longer exists, and that is right — the history
    # says the model was there; the audit view marks such entries ("model no longer exists").
    # Folder membership is cleared by the repository's cascade (per_model_stores) — otherwise a
    # future model created under the same name would inherit a folder nobody chose.
    request.app.state.command_bus.note(
        body.source, "delete_model", f"Delete model '{body.database}'", database=body.database
    )
    # A model created later under this name must not inherit its undo steps.
    request.app.state.command_bus.forget_model(body.database)
    return result
