"""A model's view state: canvas arrangement, node colours, results setup.

Deliberately **not** on the command bus, and the only mutating endpoint in the app that is not.
Everything undoable is a statement about the *model*; dragging a node says nothing about the study,
and an Undo stack full of "moved a box 40 pixels" would bury the changes that matter. What this
endpoint writes is also what the renderer already had in `localStorage` — the move is about where it
lives, not about making it a modelling decision.

Whole-entry PUT rather than a patch API: the renderer holds the view in memory anyway (it draws
from it), so it always has the complete picture, and one debounced write per model beats a call per
dragged node. Sections the client does not send are left alone — see `ViewStore.put`. The one change the
renderer does not hold is one the backend made itself (a merged tag group renames the saved breakdowns): the
revision the client read at guards that, see `ViewStore.revision`.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from prism_lca.api.v1.deps import require_token
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.view_store import SCHEMA, ViewStore
from prism_lca.errors import PrismError

router = APIRouter(prefix="/views", tags=["views"], dependencies=[Depends(require_token)])


class ViewRequest(BaseModel):
    """The sections to store. Any key is accepted — a newer client may send one this version does not
    know, and it is kept rather than refused; an explicit `null` clears a section."""

    view: dict = Field(default_factory=dict)
    #: The revision the client read the view at (`ViewStore.revision`). Sent, a write over a change the
    #: backend made since is refused with `view_changed`; left out, the write goes through as it always did.
    rev: int | None = None


@router.get("/{database}", summary="A model's stored view state (canvas, colours, results setup)")
async def get_view(request: Request, database: str) -> dict:
    del request  # the store reads the active project itself
    store = ViewStore()
    return {"schema": SCHEMA, "database": database, "view": store.get(database), "rev": store.revision(database)}


@router.put("/{database}", summary="Store a model's view state (sections not sent are left alone)")
async def put_view(request: Request, database: str, payload: ViewRequest) -> dict:
    del request
    # Refused rather than stored: the renderer's debounced write can land after the model it belongs
    # to was deleted, and this store keyed by name would keep an entry nobody can ever reach again
    # (seen: nine dead models' views in one development project).
    if database not in get_bd().databases:
        raise PrismError(f"Database '{database}' does not exist.", code="database_not_found",
                         status_code=404)
    store = ViewStore()
    entry = store.put(database, payload.view, payload.rev)
    return {"schema": SCHEMA, "database": database, "view": entry, "rev": store.revision(database)}
