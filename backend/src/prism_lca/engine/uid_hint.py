"""What a refused exchange lookup by uid tells its caller.

A uid is ``uuid4().hex`` — 32 hex digits a model copies by hand, and a copy one character off answered
only "not found … the exchange may have been removed": true, and no way forward. One measured case sent a
33-character uid (one digit appended) for a formula; the formula never arrived and the exchange stayed at
1 kg instead of 30 g (V487). So the refusal says what the lookup can see:

- a uid that is not 32 hex digits is called malformed, with its length;
- a uid of the same process (or model) that differs by one character, or starts with the same eight, is
  NAMED with what it is — never used in its place. Two exchanges can differ in one digit; a lookup that
  quietly took the nearest one would edit the wrong exchange and say it had succeeded;
- with the near uid goes WHERE it differs. Two uids with two characters swapped look the same, and a caller
  told only the right one read it as the uid it had sent, and sent the wrong one again.
"""
from __future__ import annotations

import re

from prism_lca.errors import PrismError

#: A uid as ``model.new_uid()`` writes it. Older or hand-made uids of another shape still FIND their
#: exchange — the shape is only judged once nothing matched.
UID_SHAPE = re.compile(r"^[0-9a-f]{32}$")

#: Leading characters two uids must share to count as near — 32 bits, which no two exchanges of one model
#: share by chance.
_PREFIX = 8
#: How many near uids a refusal names.
_SHOWN = 3
#: A stretch of differing characters longer than this is no slip of the hand: the two uids only start alike.
_SLIP = 6


def is_near(wanted: str, uid: str | None) -> bool:
    """Whether ``uid`` is one edit away from ``wanted``, or starts with the same eight characters."""
    if not uid or not wanted or uid == wanted:
        return False
    a, b = wanted.lower(), uid.lower()
    if len(a) >= _PREFIX and a[:_PREFIX] == b[:_PREFIX]:
        return True
    return _one_edit(a, b)


def _one_edit(a: str, b: str) -> bool:
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b, strict=True)) == 1
    short, long = (a, b) if len(a) < len(b) else (b, a)
    i = 0
    while i < len(short) and short[i] == long[i]:
        i += 1
    return short[i:] == long[i + 1:]


def difference(sent: str, real: str) -> str:
    """Where ``sent`` departs from the uid ``real``, in words the caller can hold against its own text."""
    a, b = sent.lower(), real.lower()
    head = 0
    while head < len(a) and head < len(b) and a[head] == b[head]:
        head += 1
    tail = 0
    while tail < len(a) - head and tail < len(b) - head and a[-1 - tail] == b[-1 - tail]:
        tail += 1
    yours, its = a[head:len(a) - tail], b[head:len(b) - tail]
    if len(yours) > _SLIP or len(its) > _SLIP:
        return f"it shares only its first {head} characters with yours"
    if not yours:
        return f'yours lacks "{its}" after character {head}'
    if not its:
        return f'yours has "{yours}" too many at character {head + 1}'
    return f'at character {head + 1} yours has "{yours}" where it has "{its}"'


def _label(ex) -> str:
    """What a named exchange is, in the words of the process view."""
    kind = ex.get("type")
    try:
        name = ex.input.get("name") or "?"
    except Exception:  # noqa: BLE001 - a dangling input still has its uid worth naming
        name = "?"
    role = "output" if kind == "production" else "flow" if kind == "biosphere" else "input"
    return f"{role}: {name}"


def uid_not_found(uid: str, near: list, message: str, hint: str) -> PrismError:
    """The refusal for ``uid``: the caller's ``message``, plus the shape when it is wrong; the caller's
    ``hint`` unless there is something more precise to say — the near uids (exchanges from ``near``,
    already filtered with :func:`is_near`), or for a malformed uid where a whole one is found."""
    text = uid or ""
    malformed = not UID_SHAPE.match(text)
    if malformed:
        message = f"{message} Malformed uid ({len(text)} characters) — a uid is 32 hex digits."
    if near:
        named = " or ".join(
            f"{ex.get('prism_uid')} ({_label(ex)} — {difference(text, ex.get('prism_uid') or '')})"
            for ex in near[:_SHOWN]
        )
        hint = f"Did you mean {named}? It was not used in its place — send it if it is the one you meant."
    elif malformed:
        hint = "Copy the uid from the process's exchanges (get_process_details)."
    return PrismError(message, code="exchange_not_found", status_code=404, hint=hint)
