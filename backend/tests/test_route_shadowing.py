"""What a route's path may carry: no fixed route takes a request that was meant for a model or a workspace of
the same name, and no route carries a process code at all.

A route like `POST /ai/chats/{database}` answers for every model; a fixed route beside it, such as
`POST /ai/chats/mark-interrupted`, wins for one name, and a model called that could not have a chat created
(the request ran the fixed route instead). The check does not depend on declaration order: whichever of the
two comes first, one of them can no longer be reached for that name.

A process code is whatever a spreadsheet or a bundle brought in, slashes included ("P1/2"), and the server
routes on the decoded path: a code sent as `P1%2F2` still splits its segment and the request answers "Not
Found". So a code travels as a query parameter or in the body, never in the path.

The templates come from each API module's own router, which keeps a parameter's converter: a name taken as
`{name:path}` matches across slashes, and only its real pattern shows what it would swallow.
"""

from __future__ import annotations

import importlib
import pkgutil
import re

from fastapi.routing import APIRoute, APIRouter
from starlette.routing import compile_path

import prism_lca.api.v1 as api_v1

#: Path parameters that carry a name a person chooses.
NAME_PARAMS = ("database", "name")
_PARAM = re.compile(r"\{([^}:]+)(?::[^}]+)?\}")
_PLACEHOLDER = "X1"


def _templates() -> list[tuple[str, str]]:
    """(method, template) of every route the API modules declare, prefix included, converters kept."""
    found = []
    for info in pkgutil.iter_modules(api_v1.__path__):
        router = getattr(importlib.import_module(f"{api_v1.__name__}.{info.name}"), "router", None)
        if isinstance(router, APIRouter):
            found += [(method, "/api/v1" + route.path) for route in router.routes if isinstance(route, APIRoute)
                      for method in route.methods]
    return found


def _shadowed(routes: list[tuple[str, str]]) -> list[str]:
    shadowed = []
    for method, template in routes:
        carried = [p for p in _PARAM.findall(template) if p in NAME_PARAMS]
        if not carried:
            continue
        regex, _, _ = compile_path(template)
        for other_method, other in routes:
            if other_method != method or other == template:
                continue
            match = regex.match(_PARAM.sub(_PLACEHOLDER, other))
            for param in carried if match else ():
                if match.group(param) != _PLACEHOLDER:
                    shadowed.append(f"{method} {other} takes the requests of {template} for {param} "
                                    f"'{match.group(param)}'")
    return shadowed


def test_the_check_sees_every_route_the_app_serves(client):
    """A router included some other way would escape the check below."""
    served = {(m.upper(), p) for p, ops in client.app.openapi()["paths"].items() for m in ops}
    declared = {(m, _PARAM.sub(lambda g: "{" + g.group(1) + "}", t)) for m, t in _templates()}
    assert served == declared


def test_no_fixed_route_shadows_a_name_carrying_one():
    shadowed = _shadowed(_templates())
    assert not shadowed, (
        "Move the fixed route out of the name's path (a segment of its own before the name), so that no "
        "model or workspace name can reach it:\n" + "\n".join(shadowed)
    )


def test_the_check_sees_a_shadowed_route():
    """On the route the sweep of interrupted chats had, and on a name taken across slashes."""
    assert _shadowed([("POST", "/api/v1/ai/chats/mark-interrupted"), ("POST", "/api/v1/ai/chats/{database}")]) == [
        "POST /api/v1/ai/chats/mark-interrupted takes the requests of /api/v1/ai/chats/{database} for database "
        "'mark-interrupted'"
    ]
    assert _shadowed([("DELETE", "/api/v1/projects/old/trash"), ("DELETE", "/api/v1/projects/{name:path}")])
    assert not _shadowed([("DELETE", "/api/v1/projects/old/trash"), ("DELETE", "/api/v1/projects/{name}")])


def _code_segments(routes: list[tuple[str, str]]) -> list[str]:
    return [f"{method} {template}" for method, template in routes
            if any(p == "code" or p.endswith("_code") for p in _PARAM.findall(template))]


def test_no_route_carries_a_process_code_in_its_path():
    carried = _code_segments(_templates())
    assert not carried, (
        "A process code may contain a slash, which splits a path segment. Take the code (with its database) as "
        "query parameters instead, like GET /api/v1/model/activity?database=…&code=…:\n" + "\n".join(carried)
    )


def test_the_check_sees_a_code_in_a_path():
    assert _code_segments([("GET", "/api/v1/model/activities/{database}/{code}"),
                           ("GET", "/api/v1/model/consumers/{input_code}"), ("GET", "/api/v1/model/activity")]) == [
        "GET /api/v1/model/activities/{database}/{code}", "GET /api/v1/model/consumers/{input_code}"]
