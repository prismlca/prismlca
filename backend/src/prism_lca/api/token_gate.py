"""The handshake token, checked from the request headers before any other layer handles a request."""
from __future__ import annotations

import json
import secrets

from prism_lca.errors import PrismError

TOKEN_HEADER = b"x-prism-token"

UNAUTHORIZED_MESSAGE = "Missing or invalid API token."
UNAUTHORIZED_HINT = "Send the token from the backend handshake in the 'X-Prism-Token' header."


def unauthorized() -> PrismError:
    """The 401 — the same envelope whether the gate or a route's dependency gives it."""
    return PrismError(UNAUTHORIZED_MESSAGE, code="unauthorized", status_code=401, hint=UNAUTHORIZED_HINT)


def token_matches(presented: bytes | None, expected: str) -> bool:
    """Constant-time comparison on bytes, so any header value gives an answer rather than an exception."""
    if not presented or not expected:
        return False
    return secrets.compare_digest(presented, expected.encode("utf-8"))


def _header(scope, name: bytes) -> bytes | None:  # noqa: ANN001 - ASGI scope
    # The first occurrence, as Starlette's ``Headers.get`` (and so ``require_token``) reads it.
    for key, value in scope.get("headers") or []:
        if key == name:
            return value
    return None


def has_valid_token(scope) -> bool:  # noqa: ANN001 - ASGI scope
    """Whether this request carries the app's token. Without settings on the app, nobody has it."""
    settings = getattr(getattr(scope.get("app"), "state", None), "settings", None)
    expected = getattr(settings, "auth_token", None)
    return isinstance(expected, str) and token_matches(_header(scope, TOKEN_HEADER), expected)


def _is_preflight(scope) -> bool:  # noqa: ANN001 - ASGI scope
    # Exactly what Starlette's CORSMiddleware answers on its own, without passing the request on.
    return (
        scope.get("method") == "OPTIONS"
        and _header(scope, b"origin") is not None
        and _header(scope, b"access-control-request-method") is not None
    )


class TokenGate:
    """Pure ASGI, outermost: a request without the token gets 401 before its body is read.

    Exempt are the public read-only paths and CORS preflights; none of them reads a body.
    """

    def __init__(self, app, *, public_paths: frozenset[str]) -> None:  # noqa: ANN001 - ASGI app callable
        self.app = app
        #: Open without the token to GET and HEAD only.
        self.public_paths = public_paths

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if (
            scope["type"] != "http"
            or (scope.get("method") in ("GET", "HEAD") and scope.get("path") in self.public_paths)
            or _is_preflight(scope)
            or has_valid_token(scope)
        ):
            return await self.app(scope, receive, send)
        # Answered without awaiting `receive`.
        error = unauthorized()
        body = json.dumps(
            {"error": {"code": error.code, "message": error.message, "hint": error.hint}}
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})
