"""What a refused activity lookup tells its caller.

"Activity 'x' not found in 'y'" is true and leaves the caller guessing. Where the refusing side can see
what went wrong, the hint says it (the same shape as the report gate's repair, V267):

- a whole batch sent in the single-code field, as a JSON string (V277);
- a code that lives in ANOTHER database — most often a background dataset's code sent with the model's
  own database name as an input's database.

The lookup is shared by every caller (process details, edits, deletion, exchanges, the HTTP API), so the
hint states facts and names only the one use that is safe in all of them. It never invites an edit
elsewhere: a background database is read-only and the hint says so, and a code from another of the user's
models or the library is named as such, without a suggestion to act on that database.

Behind the model fence (a chat bound to one model, V502) the hint names no other of the user's models: their
names say what else the user studies and steer the assistant's assumptions. Background databases and the
library stay named — the chat reads and links them anyway.

A READ may go one step further (V470): when the code is not in the database named but in exactly one
background database, the reader can be given that dataset instead of a refusal — reading changes nothing,
and the answer says where it came from. Two backgrounds holding the code is a choice for the caller, so
the hint names both and nothing is read.
"""

from __future__ import annotations

import json

from prism_lca.engine.guardrails import is_read_only

#: How many codes of a mis-sent batch the hint repeats back. Enough to recognise it as one's own
#: list, short enough that a forty-code slip does not become a wall of hex.
_HINT_CODES = 3

_CHECK = "Check the activity code and database."


def not_found_hint(bd, code: str, database: str) -> str:
    """The hint for `code` not found in `database`."""
    batch = batch_hint(code)
    if batch:
        return batch
    holders = _visible(_holders(bd, code, database))
    if not holders:
        return _CHECK
    if len(holders) > 1:
        named = " and ".join(f"'{h}'" for h in holders)
        return f"That code exists in {named}, not in '{database}'. Give the database you mean."
    holder = holders[0]
    if is_read_only(holder):
        return (
            f"That code is a dataset of '{holder}', a read-only background database. To use it as an "
            f"input, give '{holder}' as the input's database; the dataset itself cannot be changed."
        )
    return f"That code is a process in '{holder}', not in '{database}'."


def _visible(holders: list[str]) -> list[str]:
    from prism_lca.engine.model_scope import visible_names

    return visible_names(holders)


def background_holder(bd, code: str, database: str) -> str | None:
    """The one background database holding `code` when `database` does not, for a read to fall back on.

    None when no background holds it, or when several do: picking one of two would be a guess, and the
    refusal's hint then names both."""
    from prism_lca.engine.backgrounds.common import is_background

    holders = _holders(bd, code, database)
    backgrounds = [h for h in holders if is_background(h)]
    return backgrounds[0] if len(backgrounds) == 1 else None


def read_elsewhere_note(database: str, holder: str) -> str:
    """What a read that fell back on a background database says about it."""
    return (
        f"Not in '{database}' — this is the dataset with that code in '{holder}', the one background "
        f"database that has it. Give '{holder}' as the database when you read or link it."
    )


def batch_hint(code: str) -> str | None:
    """The hint for a JSON array sent as one code, or None. A model put the whole batch under the
    singular field and got back "Activity '[\"0d6068eb…\", …]' not found": the value was right there in
    the message and nothing read it — two dead calls, and in one session's tooling critique the
    accusation that the batch parameter is broken. It is not: `codes` works."""
    text = (code or "").strip()
    if not (text.startswith("[") and text.endswith("]")):
        return None
    try:
        items = json.loads(text)
    except ValueError:
        return None
    if not isinstance(items, list) or not all(isinstance(i, str) for i in items) or not items:
        return None
    shown = ", ".join(items[:_HINT_CODES])
    more = f" (+{len(items) - _HINT_CODES} more)" if len(items) > _HINT_CODES else ""
    return (
        f"That is a list of {len(items)} codes in the single-code field. Pass them as "
        f'"codes": [{shown}]{more} — one call, one result per code.'
    )


def _holders(bd, code: str, database: str) -> list[str]:
    """The databases that do hold `code`, other than the one named. Looked up on this error path only:
    one indexed query per database of the project."""
    if not code or len(code) > 200:
        return []
    found = []
    for name in bd.databases:
        if name == database:
            continue
        try:
            if bd.get_node(database=name, code=code) is not None:
                found.append(name)
        except Exception:  # not in this one — the expected answer for all but one
            continue
    return found
