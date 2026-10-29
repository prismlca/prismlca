"""The chat's model fence: a request from the built-in assistant changes only the model it runs in.

The in-app chat works on the model whose chat it was started in. Every backend call of its tools
carries ``X-Prism-Model`` with that model's name (percent-encoded); the HTTP middleware puts it into
:data:`CURRENT_MODEL_SCOPE`, and every write a chat tool can reach asks here before it runs. A request
without the header — the app itself, an external MCP session, the report writer — is not fenced at all.

Only WRITES are fenced here. The main process refuses the reads before they are sent
(``main/ai/modelScope.ts``); a read leaves nothing behind in the wrong model, and fencing some sixty
read routes one by one would be a large surface for no gain. The writes are fenced twice on purpose:
the main process says no in words the model can act on, and this module catches what the main
process does not see — an argument it does not know, a tool added later.

What counts as "outside" follows the product rules for the chat:
- a write lands in the fenced model or names no model at all (workspace-wide: tag vocabulary, custom
  LCIA methods) — anything else is refused, the library included;
- an input linked into the fenced model comes from the model itself, the library or a read-only
  database (background, biosphere) — never from another model, a comparison model included, because
  the link would make one model depend on the other;
- models are not created, copied, imported or deleted; the fenced model may be renamed.
"""

from __future__ import annotations

from collections.abc import Iterable
from contextvars import ContextVar

from prism_lca.engine.guardrails import is_read_only
from prism_lca.engine.library import is_library
from prism_lca.engine.model import resolve_db_name
from prism_lca.errors import PrismError

#: The model the current request may change (``X-Prism-Model``), or None for an unfenced request.
#: An empty string is a fence around no model: a chat without an open model may change none.
CURRENT_MODEL_SCOPE: ContextVar[str | None] = ContextVar("prism_model_scope", default=None)

#: Said with every refusal: the one thing the assistant can tell the user instead.
ELSEWHERE_HINT = (
    "This chat works only on its own model. Work in another model is done in that model's own chat: "
    "tell the user so instead of looking for another way."
)


def fence() -> str | None:
    """The model the current request is fenced to, or None when it is not fenced."""
    return CURRENT_MODEL_SCOPE.get()


def _canonical(name: str | None) -> str:
    """The database a name will reach. The routes resolve names tolerantly — case and punctuation do not
    count (``_db_or_404``) — so the fence compares what will be written, not what was typed: otherwise
    ``bottle glass`` would pass a fence that only knows ``Bottle Glass``. A name that resolves to
    nothing stays as typed; the route then answers "not found"."""
    return resolve_db_name(name) if name else ""


def _named(models: Iterable[str]) -> str:
    return ", ".join(f"‘{m}’" if m else "a model the request does not name" for m in models)


def outside_error(models: Iterable[str], fenced: str) -> PrismError:
    own = f"‘{fenced}’" if fenced else "no model (none is open)"
    return PrismError(
        f"Outside this chat's model: this change would write into {_named(models)}, and the assistant "
        f"in this chat may change only {own}.",
        code="outside_model_scope",
        status_code=403,
        hint=ELSEWHERE_HINT,
    )


def assert_writes(models: Iterable[str | None]) -> None:
    """Refuse when a fenced request would write into any model but its own. An empty or missing name
    counts as outside: a fence fails closed."""
    fenced = fence()
    if fenced is None:
        return
    outside = sorted({c for c in (_canonical(m) for m in models) if c != fenced or not fenced})
    if outside:
        raise outside_error(outside, fenced)


def assert_model_write(database: str | None) -> None:
    """One named model, for the routes that write outside the command bus."""
    assert_writes([database])


def assert_suppliers(databases: Iterable[str | None]) -> None:
    """Refuse an input linked from another model. The model itself, the library and the read-only
    databases (background, biosphere) are fine; a name that does not exist is left to the command,
    which answers "not found" (``is_read_only`` treats an unknown database as read-only)."""
    fenced = fence()
    if fenced is None:
        return
    resolved = {_canonical(d) for d in databases if d}
    foreign = sorted({d for d in resolved if d != fenced and not is_library(d) and not is_read_only(d)})
    if foreign:
        raise PrismError(
            f"Outside this chat's model: an input can come from the background databases, the library and "
            f"‘{fenced}’ itself — not from another model ({_named(foreign)}), a comparison model included. "
            "A link would make this model depend on the other one.",
            code="outside_model_scope",
            status_code=403,
            hint=(
                "To take over the other model's modelling, read its process and rebuild it here from the "
                "same background datasets."
            ),
        )


def assert_no_new_model(action: str) -> None:
    """Creating, copying, importing or deleting a model is never done from inside a fenced request."""
    fenced = fence()
    if fenced is None:
        return
    raise PrismError(
        f"Outside this chat's model: the assistant in this chat cannot {action}.",
        code="outside_model_scope",
        status_code=403,
        hint="The user does that in the app; a model's own chat then works on it.",
    )


def fence_command(command) -> None:  # noqa: ANN001 - a Command; typed loosely to keep this module import-light
    """Before a command executes: the models it will write, and the inputs it will link."""
    if fence() is None:
        return
    models = command.scope_models()
    if models is not None:
        assert_writes(models)
    assert_suppliers(command.scope_suppliers())


def fence_undo(command) -> None:  # noqa: ANN001 - see fence_command
    """Before an undo: the models the command writes. Not its suppliers — taking back a link removes it."""
    if fence() is None:
        return
    models = command.scope_models()
    if models is not None:
        assert_writes(models)


def fence_step(attribution: dict) -> None:
    """Before an undo/redo takes a step back: the models the step's audit line names.

    The step has already run, so its attribution is known — and it is the right question here: an undo
    writes exactly where the step wrote. A step that names no model at all is workspace-wide and is
    left alone, like the step itself was."""
    if fence() is None:
        return
    models = [m for m in [attribution.get("database"), *(attribution.get("databases") or [])] if m]
    if models:
        assert_writes(models)
