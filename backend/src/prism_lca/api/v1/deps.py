"""Shared API dependencies."""
from __future__ import annotations

from fastapi import Header, Request

from prism_lca.api.token_gate import token_matches, unauthorized
from prism_lca.repository.base import LcaRepository


def require_token(request: Request, x_prism_token: str | None = Header(default=None)) -> None:
    """Each route's own declaration that it needs the token; compared like ``TokenGate`` does, on the
    header's raw bytes (Starlette decoded them as Latin-1)."""
    presented = x_prism_token.encode("latin-1") if x_prism_token else None
    if not token_matches(presented, request.app.state.settings.auth_token):
        raise unauthorized()


def repository(request: Request) -> LcaRepository:
    return request.app.state.repository


#: How a caller may name an LCIA method.
#:
#: Either the exact ``("family", "category", "indicator")`` triple, or the whole name as one string —
#: ``"IPCC 2021 · climate change: total (excl. biogenic CO2) · global warming potential (GWP100)"`` —
#: or a loose spelling of it. ``lca.resolve_method`` folds punctuation, case and a ``v`` before a
#: version, so the name a search returned always computes, and an ambiguous one comes back with its
#: candidates named. Accepting only the triple is what made an assistant fail three times in one
#: session on a method it had itself just looked up: the string became a tuple of single characters.
MethodRef = str | list[str]
