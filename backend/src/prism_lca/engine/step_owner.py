"""Whether an external agent session may undo or redo a step without asking: only a step it made itself.

External sessions stamp their requests ``mcp-<session>-<call>`` (frontend/src/main/mcp/sessions.ts). Any other
step needs the user's approval for exactly that step, sent as ``X-Prism-Approved-Step: <verb>:<step id>``.
Requests without a turn (the window) and the in-app chat's turns (``turn-…``) are not affected.
"""

from __future__ import annotations

import itertools
import re

from prism_lca.errors import PrismError

#: An external session's turn. Group 1, everything up to the call number, names the session.
_EXTERNAL_TURN = re.compile(r"^(mcp-[A-Za-z0-9_]+-)[0-9]+$")
#: An approval: the verb and the step id the user saw on the card.
_APPROVAL = re.compile(r"^(undo|redo):([0-9]{1,18})$")
_IDS = itertools.count(1)

Approval = tuple[str, int]


def step_id(command: object) -> int:
    """The step's id, handed out on first request: stable for the step's life and never reused."""
    attrs = vars(command)
    found = attrs.get("_step_id")
    if found is None:
        found = attrs.setdefault("_step_id", next(_IDS))
    return found


def _session(turn: str | None) -> str | None:
    match = _EXTERNAL_TURN.match(turn or "")
    return match.group(1) if match else None


def needs_approval(step_turn: str | None, caller_turn: str | None) -> bool:
    """True when an external session asks about a step it did not make; an unparsable ``mcp-`` turn owns nothing."""
    if not (caller_turn or "").startswith("mcp-"):
        return False
    own = _session(caller_turn)
    return own is None or _session(step_turn) != own


def parse_approval(raw: str | None) -> Approval | None:
    """The ``X-Prism-Approved-Step`` header as (verb, step id); anything malformed is no approval."""
    match = _APPROVAL.match((raw or "").strip())
    return (match.group(1), int(match.group(2))) if match else None


def assert_may_take(command, caller_turn: str | None, approval: Approval | None, verb: str) -> None:  # noqa: ANN001
    """Refuse an external session's undo/redo of a step it did not make, unless the user approved this step for this verb."""
    if not needs_approval(getattr(command, "turn", None), caller_turn):
        return
    if approval == (verb, step_id(command)):
        return
    what = "take back" if verb == "undo" else "apply again"
    raise PrismError(
        f"The change {verb.capitalize()} would {what} here was not made by this session: {command.summary()}.",
        code=f"{verb}_not_yours",
        status_code=409,
        hint=(
            f"Leave it unless you mean to {what} exactly this change. Then call history again, and "
            f"PrismLCA asks the user in its window first. If you were after a change of your own, it lies "
            f"below this one and is out of reach: tell the user instead."
        ),
    )


def assert_may_take_turn(turn: str, caller_turn: str | None, verb: str) -> None:
    """An external session may take a whole assistant turn at once only when the turn is its own."""
    if needs_approval(turn, caller_turn):
        raise PrismError(
            f"That assistant turn was not made by this session, so it cannot be {verb}ne as a block.",
            code="turn_not_yours",
            status_code=409,
            hint=f"{verb.capitalize()} single steps with history instead; PrismLCA asks the user before one that is not yours.",
        )
