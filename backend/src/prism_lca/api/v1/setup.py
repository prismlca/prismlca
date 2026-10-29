"""Setup endpoints: importing a background database (ecoinvent from local ecoSpold-2 files, or
BAFU:20XY from its ecoSpold-1 folder), removing one, and starting over."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import background_reset, ecoinvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/setup", tags=["setup"], dependencies=[Depends(require_token)])


class EcoinventImportRequest(BaseModel):
    ecospold2_dir: str
    project: str = "ecoinvent-3.12-cutoff"
    database: str = "ecoinvent-3.12-cutoff"
    #: Path to the release's 'LCIA Implementation <version>.xlsx'. Optional, but without it the
    #: project has no impact methods and nothing can be calculated.
    lcia_xlsx: str | None = None


class LciaImportRequest(BaseModel):
    lcia_xlsx: str
    project: str = "ecoinvent-3.12-cutoff"


class ImportStatusResponse(BaseModel):
    state: str
    step: str
    detail: str
    project: str | None = None
    database: str | None = None
    #: 0–1 while measurable; null = running without a measure.
    progress: float | None = None
    #: True while ``POST /setup/cancel`` can still stop the job.
    cancellable: bool = False
    #: Epoch seconds the job started at.
    started_at: float | None = None


def _to_response(st: ecoinvent.ImportStatus) -> ImportStatusResponse:
    return ImportStatusResponse(
        state=st.state.value,
        step=st.step,
        detail=st.detail,
        project=st.project,
        database=st.database,
        progress=st.progress,
        cancellable=st.cancellable,
        started_at=st.started_at,
    )


class BackgroundImportRequest(BaseModel):
    """One request shape for both providers. ``path`` is the ecoSpold-2 ``datasets`` folder for
    ecoinvent (``lcia_xlsx`` beside it) or the ``ecoSpold files`` folder for BAFU."""

    source: Literal["ecoinvent", "bafu"]
    path: str
    lcia_xlsx: str | None = None
    #: Only honoured for ecoinvent (name pattern ``ecoinvent-3.12-cutoff``); BAFU derives its
    #: name from the download folder (``bafu-2026-v1``).
    database: str | None = None


def _index_after(request: Request):
    return index_after(request.app.state.search)


def index_after(search):
    """The import's ``on_done``: line up the new database's search index, then bring the biosphere
    index along — flows the import ADDED are appended (cheap), flows the ecoinvent-master sync
    RENAMED force a rebuild. All of it waits its turn behind the build that may be running: an
    import often finishes while the database imported just before it is still being indexed, and a
    refusal there left the new database without an index for good. Failures are logged, never
    raised: the import itself succeeded."""

    def queue(db_name: str, changes: dict | None = None) -> None:
        changes = changes or {}
        follow = False
        try:
            if changes.get("biosphere_rebuild") or changes.get("biosphere_added"):
                # Asked BEFORE anything is queued. A biosphere without an index gets one from the
                # database build itself (its follow-up step indexes the flows as they are by then);
                # asked later, that fresh index looked like an old one, and all 9 850 flows were
                # indexed a second time. One being built right now counts as there: it may have
                # read the flows before this import changed them.
                info = search.index_info("biosphere3")
                follow = bool(info.get("indexed") or info.get("building"))
        except Exception as exc:  # noqa: BLE001 - no biosphere, nothing to follow
            logger.warning("biosphere index not followed up after the import: %s", exc)
        try:
            search.builds.build_when_free(db_name)
        except Exception as exc:  # noqa: BLE001 - the import succeeded; the index can be built by hand
            logger.warning("search index of %s not lined up after the import: %s", db_name, exc)
        if not follow:
            return
        try:
            if changes.get("biosphere_rebuild"):
                search.builds.build_when_free("biosphere3")
            else:
                search.builds.extend_when_free("biosphere3", list(changes["biosphere_added"]))
        except Exception as exc:  # noqa: BLE001 - the biosphere index can be rebuilt by hand
            logger.warning("biosphere index not followed up after the import: %s", exc)

    return queue


@router.post(
    "/background", response_model=ImportStatusResponse, summary="Start a background import"
)
async def start_background_import(
    request: Request, body: BackgroundImportRequest
) -> ImportStatusResponse:
    """ecoinvent or BAFU — at most one database per provider. ecoinvent is the
    master: a BAFU import maps onto it when present, and an ecoinvent import after BAFU rewrites
    the existing BAFU database onto ecoinvent's flow list."""
    if body.source == "bafu":
        st = ecoinvent.start_bafu_import(
            body.path, database=body.database, on_done=_index_after(request)
        )
    else:
        st = ecoinvent.start_import(
            body.path,
            ecoinvent.get_bd().projects.current,
            body.database or "ecoinvent-3.12-cutoff",
            body.lcia_xlsx,
            on_done=_index_after(request),
        )
    return _to_response(st)


@router.post("/ecoinvent", response_model=ImportStatusResponse, summary="Start ecoinvent import")
async def start_ecoinvent_import(
    request: Request, body: EcoinventImportRequest
) -> ImportStatusResponse:
    """Kept for older frontends; ``POST /setup/background`` is the general form."""
    st = ecoinvent.start_import(
        body.ecospold2_dir,
        body.project,
        body.database,
        body.lcia_xlsx,
        on_done=_index_after(request),
    )
    return _to_response(st)


@router.post("/lcia", response_model=ImportStatusResponse, summary="Import LCIA methods")
async def start_lcia_import(body: LciaImportRequest) -> ImportStatusResponse:
    """Add impact methods to a project whose inventory was imported without them."""
    st = ecoinvent.start_lcia_import(body.lcia_xlsx, body.project)
    return _to_response(st)


@router.get("/status", response_model=ImportStatusResponse, summary="Import job status")
async def import_status() -> ImportStatusResponse:
    return _to_response(ecoinvent.status())


@router.post("/cancel", response_model=ImportStatusResponse, summary="Cancel the running import")
async def cancel_import() -> ImportStatusResponse:
    """Stops the ecoinvent import before it writes; the status turns ``cancelled`` shortly after."""
    return _to_response(ecoinvent.cancel_import())


class ResetRequest(BaseModel):
    code: str


@router.get("/background", summary="Background data in this project, and the cost of a reset")
async def background_overview() -> dict:
    return background_reset.background_overview()


@router.delete("/background/{name}", summary="Remove one background database")
async def remove_background(request: Request, name: str) -> dict:
    """Removes the database and its search index; refuses while a model still points into it.
    The biosphere and the methods stay."""
    return background_reset.remove_background(name, request.app.state.search.drop_index)


@router.post("/background/reset-code", summary="Issue the code a reset requires")
async def reset_code() -> dict:
    return background_reset.issue_reset_code()


@router.post("/background/reset", summary="Delete this project's background data")
async def reset_background(request: Request, body: ResetRequest) -> dict:
    """Destructive and deliberate: needs the code from ``/background/reset-code``."""
    return background_reset.reset_background(body.code, request.app.state.search.drop_index)
