"""The one place a deliberately swallowed exception still leaves a trace.

The codebase swallows ~80 exceptions on purpose — best-effort enrichment, cache warm-ups, cleanup
paths — each with a comment saying why the failure must not propagate. The comments are right; what
was missing is any way to SEE such a failure when it hides a real bug: a swallowed KeyError in a
formatting helper looks exactly like "feature quietly absent". Every deliberate swallow now calls
:func:`swallowed`, which files the fact at DEBUG under one logger name — invisible in normal
operation, one ``logging.getLogger("prism_lca.swallowed").setLevel(DEBUG)`` away when hunting.
"""
from __future__ import annotations

import logging

_logger = logging.getLogger("prism_lca.swallowed")


def swallowed(exc: BaseException, where: str = "") -> None:
    """Record a deliberately ignored exception at DEBUG. Never raises."""
    try:
        _logger.debug("swallowed in %s: %s: %s", where or "?", type(exc).__name__, exc)
    except Exception:  # pragma: no cover - logging must never take the caller down
        pass
