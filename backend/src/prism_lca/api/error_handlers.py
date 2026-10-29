"""The HTTP shape of PrismLCA's errors — the one place errors and FastAPI meet.

Moved out of ``errors.py`` so that module stays framework-free: every engine module imports
``PrismError``, and while the handlers lived beside it, importing any engine module transitively
pulled FastAPI/Starlette into processes that never serve HTTP (scripts, the offline word-forms
tool, PyInstaller analysis).
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from prism_lca.errors import PrismError


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(PrismError)
    async def _handle_prism_error(_request: Request, exc: PrismError) -> JSONResponse:
        error = {"code": exc.code, "message": exc.message, "hint": exc.hint}
        if exc.details is not None:
            error["details"] = exc.details
        return JSONResponse(status_code=exc.status_code, content={"error": error})

    @app.exception_handler(Exception)
    async def _handle_unexpected(_request: Request, exc: Exception) -> JSONResponse:
        # Unknown exceptions (numpy/bw2data/KeyError …) would otherwise surface as Starlette's
        # plain-text 500 — the UI and the AI assistant both rely on this envelope shape.
        import logging

        logging.getLogger(__name__).exception("Unhandled error", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "internal_error",
                    "message": f"{type(exc).__name__}: {exc}",
                    "hint": "Unexpected server error — see the backend log for the traceback.",
                }
            },
        )
