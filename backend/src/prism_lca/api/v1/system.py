"""System endpoints: liveness, app/engine info.

``/health`` is public so the Electron shell can poll for readiness before it has anything
else to say; everything else requires the handshake token.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import maintenance
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import is_read_only
from prism_lca.engine.health import lint_database
from prism_lca.errors import PrismError
from prism_lca.repository.base import BackendInfo, ProjectInfo

router = APIRouter(prefix="/system", tags=["system"])


class HealthResponse(BaseModel):
    status: str = "ok"


class InfoResponse(BaseModel):
    app_version: str
    api_version: str
    backend: BackendInfo
    current_project: ProjectInfo | None


@router.get("/health", response_model=HealthResponse, summary="Liveness probe (public)")
async def health() -> HealthResponse:
    return HealthResponse()


@router.get(
    "/info",
    response_model=InfoResponse,
    dependencies=[Depends(require_token)],
    summary="App version, engine status and active workspace",
)
async def info(request: Request) -> InfoResponse:
    settings = request.app.state.settings
    repo = request.app.state.repository
    return InfoResponse(
        app_version=settings.app_version,
        api_version="v1",
        backend=repo.backend_info(),
        current_project=repo.current_project(),
    )


class ProviderKeyRequest(BaseModel):
    """A provider API key handed over by the Electron shell, which owns the encrypted store."""

    provider: str = "openrouter"
    key: str = ""


class ProviderKeyResponse(BaseModel):
    """Presence only — this endpoint never reads a key back out. See the note in `set_provider_key`."""

    provider: str
    present: bool


@router.post(
    "/provider-key",
    response_model=ProviderKeyResponse,
    dependencies=[Depends(require_token)],
    summary="Hand the backend the provider key for API embeddings (in-memory only)",
)
def set_provider_key(request: Request, payload: ProviderKeyRequest) -> ProviderKeyResponse:
    """Give the running backend the key it needs for API embeddings — **in memory only**.

    The key belongs to the Electron shell, which keeps it in the OS credential store and passes it
    here as an environment variable at spawn. This endpoint exists for the other direction of time: a
    key entered in Settings *after* the backend started would otherwise not reach it until the next
    launch, and "I entered my key and search still says there is none" is a bug the user cannot see
    the cause of.

    Deliberately write-only and unlogged. There is no GET that returns the key, the response carries
    presence and nothing else, and the value is never written to disk on this side — persisting it
    would put a second, unencrypted copy next to the encrypted one the shell maintains.
    """
    provider = (payload.provider or "openrouter").strip().lower()
    if provider not in ("openrouter", "openai"):
        raise PrismError(
            f"Unknown provider '{provider}'.",
            code="provider_unknown",
            hint="One of: openrouter, openai.",
        )
    key = (payload.key or "").strip()
    settings = request.app.state.settings
    if provider == "openrouter":
        settings.openrouter_api_key = key
    else:
        settings.openai_api_key = key
    # An embedding provider built with the previous key has to go, or the new one takes effect only
    # after a restart — which is the whole thing this endpoint is here to avoid.
    search = getattr(request.app.state, "search", None)
    if search is not None:
        search.reset_provider()
    return ProviderKeyResponse(provider=provider, present=bool(key))


class SearchModelResponse(BaseModel):
    """The local search model (bge-m3): on disk, missing, arriving, or failed.

    ``bytes_total`` is the expected size (0 when the configured backend needs no local model);
    ``bytes_done`` what is on disk so far, partial files included.
    """

    state: str  # "ready" | "missing" | "downloading" | "error"
    repo: str
    revision: str | None
    bytes_done: int
    bytes_total: int
    error: str | None = None


@router.get(
    "/search-model",
    response_model=SearchModelResponse,
    dependencies=[Depends(require_token)],
    summary="Is the local search model on disk? (never contacts the network)",
)
def search_model(request: Request) -> SearchModelResponse:
    return SearchModelResponse(**request.app.state.search_model.status())


@router.post(
    "/search-model/download",
    response_model=SearchModelResponse,
    dependencies=[Depends(require_token)],
    summary="Download the local search model from huggingface.co (only after the user agreed)",
)
def search_model_download(request: Request) -> SearchModelResponse:
    # The one call in the backend that may fetch the model. The shell makes it only after the
    # user pressed "Download" in the consent dialog; it is idempotent, so a Retry or a double
    # click never starts a second download.
    return SearchModelResponse(**request.app.state.search_model.start_download())


class BackupRequest(BaseModel):
    """Where to write the archive. Empty = the user's home directory, which is where bw2io puts it."""

    directory: str | None = None


@router.get(
    "/backup/estimate",
    dependencies=[Depends(require_token)],
    summary="How big a workspace backup would be, and the licence warning that goes with it",
)
def backup_estimate() -> dict:
    from prism_lca.engine import project_backup

    return project_backup.estimate()


@router.post(
    "/backup",
    dependencies=[Depends(require_token)],
    summary="Write a full workspace backup to disk (contains licensed background data — do not share)",
)
def backup(payload: BackupRequest) -> dict:
    from prism_lca.engine import lca, project_backup

    # Like /projects/backup: an archive taken inside a scenario window would hold the overrides.
    with lca._LCA_LOCK:
        return project_backup.write(payload.directory)


@router.get(
    "/embedding-usage",
    dependencies=[Depends(require_token)],
    summary="API-embedding consumption (month → model → cost/prompt/calls) — the backend's ledger half",
)
def embedding_usage() -> dict:
    from prism_lca.search import embedding_usage as ledger

    # The frontend merges this into the cost table as the 'embedding' category (V127): embeddings
    # bill from the backend, so until this endpoint existed that spend was invisible in Settings.
    return {"months": ledger.snapshot()}


@router.get(
    "/support-bundle",
    dependencies=[Depends(require_token)],
    summary="Troubleshooting bundle (versions + health + audit; no inventory data)",
)
def support_bundle(request: Request) -> Response:
    # `model_dump()` and not the models themselves: `support_bundle` serialises with
    # `default=str`, which turned every entry into its repr — audit.json has never been
    # machine-readable JSON objects until now.
    audit = [e.model_dump() for e in request.app.state.command_bus.audit()]
    bd = get_bd()
    health_by_db = {
        db: lint_database(db) for db in bd.databases if not is_read_only(db)
    }
    data = maintenance.support_bundle(
        request.app.state.settings.app_version, audit, health_by_db
    )
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="prism-support-bundle.zip"'},
    )


# --- orderly stop for an update -----------------------------------------------------------------
# The Electron shell installs an update only after this process has exited (V-2).
# On Windows `child.kill()` is TerminateProcess: no atexit, no lock release, and a write
# into the Brightway SQLite files cut off wherever it stood. So the shell asks here first, and uvicorn
# leaves the way it does on SIGTERM — in-flight requests finish, then the process ends normally.


def _busy_reasons(request: Request) -> list[str]:
    """Work a stop would destroy, in words the shell can show. Empty means idle."""
    return _in_flight(request) + _jobs(request)


def _in_flight(request: Request) -> list[str]:
    # Requests being answered right now (app.py's _InFlightMiddleware; the busy check and the stop
    # themselves are not counted). A synchronous calculation or a write in progress is one of these.
    in_flight = getattr(request.app.state, "requests_in_flight", 0)
    return [f"{in_flight} request{'s' if in_flight != 1 else ''} in progress"] if in_flight else []


#: A request answered for this long is a synchronous calculation (the Results page compares inside
#: the request) or the like, not a status poll.
LONG_REQUEST_S = 15.0


def _long_work(request: Request) -> list[str]:
    """What runs for minutes once started — what the shell keeps the computer awake for: the jobs,
    and requests that have been running for a while. Requests in general are left out: the status
    polls of an idle window are requests too, and they would hold the computer awake at random."""
    starts = getattr(request.app.state, "request_starts", {})
    now = time.monotonic()
    long = sum(1 for began in starts.values() if now - began >= LONG_REQUEST_S)
    work = [f"{long} long request{'s' if long != 1 else ''} in progress"] if long else []
    return work + _jobs(request)


def _jobs(request: Request) -> list[str]:
    """The work that runs on its own threads once started."""
    from prism_lca.engine import calc_jobs, ecoinvent
    from prism_lca.engine.dataimport import session as import_session

    work: list[str] = []
    running = calc_jobs.running_count()
    if running:
        work.append(f"{running} calculation{'s' if running != 1 else ''} running")
    if ecoinvent.status().state == ecoinvent.JobState.running:
        work.append("a background import running")
    if import_session.reading_progress() is not None:
        work.append("a data import being read")
    if import_session.committing():
        work.append("a data import being written")
    search = getattr(request.app.state, "search", None)
    if search is not None and search.builds.busy():
        work.append("the search index being built")
    model = getattr(request.app.state, "search_model", None)
    if model is not None and model.downloading():
        work.append("the search model being downloaded")
    return work


class BusyResponse(BaseModel):
    busy: bool
    reasons: list[str]
    #: What runs for minutes once started: the jobs of `reasons`, and the requests among its
    #: "in progress" that have been answered for a while.
    long_work: list[str]


@router.get(
    "/busy",
    response_model=BusyResponse,
    dependencies=[Depends(require_token)],
    summary="Is anything running that a stop would destroy?",
)
async def busy(request: Request) -> BusyResponse:
    # `async` on purpose: the middleware adds and removes request start times on the event loop, and
    # reading them from a worker thread could catch the map mid-change.
    reasons = _busy_reasons(request)
    return BusyResponse(busy=bool(reasons), reasons=reasons, long_work=_long_work(request))


class ShutdownRequest(BaseModel):
    #: Stop even while work is running — the shell sends this when the user is quitting anyway.
    force: bool = False


class ShutdownResponse(BaseModel):
    accepted: bool
    reasons: list[str] = []


@router.post(
    "/shutdown",
    response_model=ShutdownResponse,
    dependencies=[Depends(require_token)],
    summary="End this backend in order (used before an update is installed)",
)
async def shutdown(request: Request, payload: ShutdownRequest) -> ShutdownResponse:
    """Refuse while work is running unless ``force``; otherwise tell uvicorn to exit.

    ``should_exit`` is the flag uvicorn's own signal handler sets: the server stops accepting,
    lets running requests finish, runs the lifespan shutdown and returns from ``run()`` — after which
    the process ends and ``atexit`` releases the instance lock. The answer to this request still goes
    out, because it is in flight when the flag is read.
    """
    # `async` on purpose: it runs on the event loop, where the in-flight middleware counts and admits
    # requests. With no await between the check and the flag, nothing can be admitted in between.
    reasons = _busy_reasons(request)
    if reasons and not payload.force:
        return ShutdownResponse(accepted=False, reasons=reasons)
    request.app.state.shutting_down = True
    server = getattr(request.app.state, "server", None)
    if server is not None:
        server.should_exit = True
    return ShutdownResponse(accepted=True, reasons=reasons)
