"""Structured errors.

Every error carries a machine-readable ``code`` and a human ``hint`` describing how to
fix it — usable by both the UI and (in Phase 2) an AI agent.

Deliberately framework-free: every engine module imports ``PrismError``, so a FastAPI import here
would drag the web stack into everything (it did, until 2026-08-31). The HTTP handlers live in
``api/error_handlers.py``.

``scenario_calc_error`` stays here rather than in ``engine/scenarios.py`` because three engine
modules raise it (scenarios, compare, lca) — it is a shared error constructor, not scenario logic.
"""
from __future__ import annotations


class PrismError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str = "prism_error",
        hint: str | None = None,
        status_code: int = 400,
        details: dict | None = None,
        situational: bool = False,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.hint = hint
        self.status_code = status_code
        # Structured facts for the UI to word its own dialog from. The message and hint stay complete
        # without them: the assistant's tools read those two and never this.
        self.details = details
        # The request was fine; the app's situation answered it — busy, not built yet, switched to another
        # workspace, overtaken by a newer request. A client tells this apart from a "no" to the request
        # itself: the assistant's loop counts it as a call that failed to run, never as one it refused.
        self.situational = situational

    def envelope(self) -> dict:
        """The response body every client reads: ``{"error": {code, message, hint, …}}``."""
        error: dict = {"code": self.code, "message": self.message, "hint": self.hint}
        if self.details is not None:
            error["details"] = self.details
        if self.situational:
            error["situational"] = True
        return {"error": error}


def scenario_calc_error(name: str, exc: Exception) -> PrismError:
    """Turn a raw parameter/recalculation failure during scenario evaluation into a clear,
    actionable message — the underlying bw2data/param exception would otherwise reach the UI as an
    opaque ``internal_error`` 500 (e.g. a full SQL dump)."""
    return PrismError(
        f"Could not compute scenario “{name}”.",
        code="scenario_calc_error",
        hint="Applying this scenario's parameter overrides failed. Check the model's parameters "
             "and any fx formulas on its exchanges — a value or formula may be invalid. "
             f"(Details: {type(exc).__name__}: {exc})",
        status_code=422,
    )
