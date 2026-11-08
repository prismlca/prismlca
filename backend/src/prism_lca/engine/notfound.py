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
    holder = _holder(bd, code, database)
    if holder is None:
        return _CHECK
    if is_read_only(holder):
        return (
            f"That code is a dataset of '{holder}', a read-only background database. To use it as an "
            f"input, give '{holder}' as the input's database; the dataset itself cannot be changed."
        )
    return f"That code is a process in '{holder}', not in '{database}'."


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


def _holder(bd, code: str, database: str) -> str | None:
    """The database that does hold `code`, when it is not the one named. Looked up on this error path
    only: one indexed query per database of the project."""
    if not code or len(code) > 200:
        return None
    for name in bd.databases:
        if name == database:
            continue
        try:
            if bd.get_node(database=name, code=code) is not None:
                return name
        except Exception:  # not in this one — the expected answer for all but one
            continue
    return None
