"""FastAPI application factory.

API-first (ADR-003): the UI is only a client of this API; there is no UI-only code path.
The same endpoints back the Phase-2 MCP server.
"""
from __future__ import annotations

import itertools
import json
import time
from urllib.parse import unquote

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from prism_lca import _log
from prism_lca.api.error_handlers import install_error_handlers
from prism_lca.api.v1.router import api_router
from prism_lca.config import Settings, get_settings
from prism_lca.engine import model
from prism_lca.engine.brightway_repository import BrightwayRepository
from prism_lca.engine.commands import (
    CLIENT_LABEL_RE,
    CURRENT_CLIENT,
    CURRENT_PROJECT,
    CURRENT_TURN,
    TURN_ID_RE,
    CommandBus,
)
from prism_lca.engine.model_scope import CURRENT_MODEL_SCOPE
from prism_lca.search.service import SearchService

#: Requests that say nothing about work in progress, so they never count as "in flight" (the busy
#: check and the stop must not count themselves, and the shell's health poll is no work).
_HOUSEKEEPING_PATHS = frozenset(
    {"/api/v1/system/health", "/api/v1/system/busy", "/api/v1/system/shutdown"}
)


class _InFlightMiddleware:
    """Counts the HTTP requests being answered right now in ``app.state.requests_in_flight``.

    The stop before an update (POST /system/shutdown) refuses while any is running: a synchronous
    calculation, a report write or a parameter batch can take longer than the shell waits for the
    process to end, and on Windows the fallback after that wait is TerminateProcess
    (V-2). Pure ASGI for the same reason
    as the middleware below; the counter is only ever touched on the event loop, so it needs no lock.
    """

    def __init__(self, app, state) -> None:  # noqa: ANN001 - ASGI app callable, Starlette State
        self.app = app
        self.state = state
        state.requests_in_flight = 0
        #: When each request in flight began (monotonic seconds): a synchronous calculation is long
        #: work the shell keeps the computer awake for, the quick polls of an idle window are not.
        state.request_starts = {}
        state.shutting_down = False
        self._tokens = itertools.count()

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] != "http" or scope.get("path") in _HOUSEKEEPING_PATHS:
            return await self.app(scope, receive, send)
        # Once a stop is accepted, nothing new starts: the busy check and this flag are set in one
        # step on the event loop (system.shutdown is async), so no request can slip in between and
        # begin a write the shell would later have to cut off.
        if self.state.shutting_down:
            from starlette.responses import JSONResponse

            return await JSONResponse(
                {
                    "error": {
                        "code": "shutting_down",
                        "message": "The backend is stopping for an update.",
                        "hint": "PrismLCA restarts in a moment; try again then.",
                    }
                },
                status_code=503,
            )(scope, receive, send)
        self.state.requests_in_flight += 1
        token = next(self._tokens)
        self.state.request_starts[token] = time.monotonic()
        try:
            return await self.app(scope, receive, send)
        finally:
            self.state.requests_in_flight -= 1
            del self.state.request_starts[token]


class _AssistantTurnMiddleware:
    """Pure ASGI wrapper that reads ``X-Prism-Turn`` into ``commands.CURRENT_TURN`` and
    ``X-Prism-Client`` into ``commands.CURRENT_CLIENT`` — see the comment at the ``add_middleware``
    call for why it is not a ``@app.middleware("http")``.

    ``X-Prism-Project`` is the third header, and it is a guard rather than an attribution: an
    external MCP session names the project it was opened on, and a request that arrives after the
    app switched to another project is answered 409 here, before any handler can touch the model
    of the same name in the other project.

    ``X-Prism-Model`` is the fourth, also a guard: the in-app chat names the model it runs in, and
    every write of the request must stay inside it (engine/model_scope.py).
    """

    def __init__(self, app) -> None:  # noqa: ANN001 - ASGI app callable
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        raw = ""
        raw_client = ""
        raw_project: str | None = None
        raw_model: str | None = None
        for key, value in scope.get("headers") or []:
            if key == b"x-prism-turn" and not raw:
                raw = value.decode("latin-1")
            elif key == b"x-prism-client" and not raw_client:
                # UTF-8 so a Unicode letter survives; an undecodable byte becomes U+FFFD, which the
                # pattern rejects — so a broken value is absent, not mangled into the log.
                raw_client = value.decode("utf-8", errors="replace")
            elif key == b"x-prism-project" and raw_project is None:
                # Percent-encoded by the sender: a header is Latin-1 on the wire, project names
                # are not ("Müller", "研究").
                raw_project = unquote(value.decode("latin-1"))
            elif key == b"x-prism-model" and raw_model is None:
                # The in-app chat's model fence (engine/model_scope.py); percent-encoded like the
                # project. Present but empty = a chat without a model, which may change none.
                raw_model = unquote(value.decode("latin-1"))
        if raw_project is not None:
            # The early answer, before the body is read: cheap, and the clear message. The check
            # that cannot be raced sits in the command bus (assert_expected_project).
            current = _current_project_name(scope)
            if current != raw_project:
                return await _project_changed_response(send, raw_project, current)
        token = CURRENT_TURN.set(raw if TURN_ID_RE.match(raw) else None)
        client_token = CURRENT_CLIENT.set(raw_client if CLIENT_LABEL_RE.match(raw_client) else None)
        project_token = CURRENT_PROJECT.set(raw_project)
        model_token = CURRENT_MODEL_SCOPE.set(raw_model)
        try:
            return await self.app(scope, receive, send)
        finally:
            CURRENT_MODEL_SCOPE.reset(model_token)
            CURRENT_PROJECT.reset(project_token)
            CURRENT_CLIENT.reset(client_token)
            CURRENT_TURN.reset(token)


def _current_project_name(scope) -> str | None:  # noqa: ANN001
    repo = getattr(getattr(scope.get("app"), "state", None), "repository", None)
    if repo is None:
        return None
    try:
        info = repo.current_project()
    except Exception:  # noqa: BLE001 - a guard must never take the request down with it
        return None
    return info.name if info is not None else None


async def _project_changed_response(send, expected: str, current: str | None):  # noqa: ANN001
    now = f'"{current}"' if current else "no workspace"
    message = (
        f'The active workspace changed: this session was opened on "{expected}", the app now has {now}. '
        "Reconnect to continue in the current workspace."
    )
    body = json.dumps({"error": {"code": "project_changed", "message": message}}).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": 409,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


def _ensure_library(app: FastAPI) -> None:
    """The project's own dataset library, created before anyone asks for it.

    At startup and on every project switch, because it is meant to be a place that is simply there
    — a library that appears only after the first import is not one you would think to put your own
    processes in.
    """
    try:
        from prism_lca.engine.library import ensure_library_if_set_up

        ensure_library_if_set_up()
    except Exception as exc:  # noqa: BLE001 - a missing library must never block startup
        _log.swallowed(exc, "ensure_library")


def _migrate_study_files(*, prefer_legacy: bool = False) -> None:
    """Legacy study-metadata file names to the per-model ones (engine/study.py). At startup before the
    first request, and inside the project lock wherever a workspace becomes active — before any model can
    be created, renamed or deleted, which would otherwise strand or hand on a legacy file."""
    try:
        from prism_lca.engine import study

        study.migrate_active_workspace(prefer_legacy=prefer_legacy)
    except Exception as exc:  # noqa: BLE001 - never block startup; the next start retries
        _log.swallowed(exc, "migrate_study_files")


def _hygiene() -> None:
    """What the active project must not accumulate — see ``engine.hygiene``. Startup and every switch."""
    from prism_lca.engine import hygiene

    hygiene.run()  # each step swallows its own errors


def recover_param_window(app: FastAPI) -> dict | None:
    """Undo an interrupted scenario window, then forget anything computed against it.

    Called at startup and again whenever a project is activated: the marker lives in the project
    directory, so a project nobody activated is a project nobody has checked yet.

    The cache clearing belongs here rather than in the engine, which knows nothing about the report
    endpoints. Bumping the model generation (which `param_window.recover` does) already makes every
    stored snapshot unreachable — it is in the key — but "unreachable" leaves a study's worth of
    numbers for the wrong model state sitting in an LRU, so it is dropped outright.
    """

    from prism_lca.engine import param_window

    try:
        result = param_window.recover(bus=getattr(app.state, "command_bus", None))
    except Exception as exc:  # noqa: BLE001
        # A restore that cannot be written must not stop the app from starting: the marker stays on
        # disk, so the model-health linter keeps saying the model is in doubt and the next start
        # tries again. Refusing to start would hide the very thing it is trying to protect.
        # param_window's own logger, so the warning files under the module that owns the recovery.
        param_window.logger.warning(
            "Could not undo an interrupted scenario window: %s: %s", type(exc).__name__, exc
        )
        return None
    if result is not None:
        from prism_lca.engine.report_snapshot import invalidate

        invalidate()
    return result


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    app = FastAPI(
        title="PrismLCA API",
        version=settings.app_version,
        summary="Local API for the PrismLCA desktop app. Every UI and AI action goes through here.",
    )

    # Loopback-only backend; permissive CORS is safe because access is gated by the token.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Carry the assistant-turn id from the header into the command bus's contextvar. The AI
    # loop sends ``X-Prism-Turn`` with every call of one agent run; every command executed under it
    # is stamped with that id, which is what groups a turn's changes in the audit log and lets
    # undo/redo take a whole turn back in one go. A malformed value is treated as absent — the log
    # is append-only forever, so nothing unvalidated is written into it.
    #
    # A PURE ASGI middleware, not ``@app.middleware("http")``: BaseHTTPMiddleware runs the
    # downstream app in its own task, so a contextvar set in its dispatch does not reliably reach
    # the endpoint. Wrapping the callable keeps everything in one task context, which anyio then
    # copies into the threadpool that sync endpoints run on.
    app.add_middleware(_AssistantTurnMiddleware)
    app.add_middleware(_InFlightMiddleware, state=app.state)

    install_error_handlers(app)

    app.state.settings = settings
    app.state.repository = BrightwayRepository()
    # Land on a project that has data rather than bw2data's empty 'default'.
    app.state.repository.ensure_working_project()
    # The command bus is built here rather than below with the other stores because the recovery on
    # the next line is a write to the model and belongs in the audit trail like every other one.
    app.state.command_bus = CommandBus()
    # Before anything reads the model: a process killed inside a scenario window leaves the
    # overrides in the parameters, and only the marker on disk knows what they were (V218).
    recover_param_window(app)
    _migrate_study_files()
    _ensure_library(app)
    _hygiene()
    # One-time: migrate legacy project-global parameters/groups/scenarios to per-model scope.
    # No-op (and un-marked, so it retries) until at least one foreground model exists.
    try:
        from prism_lca.engine import params as _params

        _params.migrate_project_to_models()
    except Exception as exc:  # noqa: BLE001 - never let a migration block startup
        _log.swallowed(exc, "create_app")
    # Build the property/unit vocabulary in the background (cached to disk after the first scan).
    model.warm_vocabulary()
    app.state.search = SearchService(settings)
    # The local search model's consent-gated download; warms search once it lands.
    from prism_lca.search.model_store import SearchModelStore

    app.state.search_model = SearchModelStore(settings, on_ready=app.state.search.warm)
    # Warm the embedding model in the background so the first search isn't a cold ~1-2 min wait.
    app.state.search.warm()

    app.include_router(api_router, prefix=settings.api_prefix)
    return app
