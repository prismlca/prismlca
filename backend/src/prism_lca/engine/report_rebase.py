"""A written chapter's placeholders restated in today's positions, for the writer who updates it.

A placeholder names a member by position — `hotspots.0` — and the chapter's pins say which member
each position meant when the sentence was written (`report_bindings.bindings_for`). After a
recalculation the two part ways: the lorry is pinned at `hotspots.0` and stands at `hotspots.2`
today. Printing does not mind; the pin finds the lorry. A writer updating the chapter does: the
brief's facts list today's order, so a new sentence citing `hotspots.0` means the box while an
untouched sentence citing `hotspots.0` means the lorry, and one map of pins cannot hold both.

So an update is handed the chapter rebased: every pinned path rewritten to the position its member
holds today. Text and facts then speak one set of coordinates, the rebased chapter prints exactly
what the stored one prints, and the updated text is bound by position like any fresh write — the
pin of an untouched sentence comes out naming the member it named before.

A pinned member that is no longer in the results has no position today. Its token is marked
``{{gone:…}}``: a path no data has, so the contract refuses a chapter that still carries it, and the
sentence about the vanished member has to be rewritten instead of quietly printing whoever took its
place.
"""
from __future__ import annotations

import re
from typing import Any

from prism_lca.engine.report_bindings import identity_matches, ranked_splits
from prism_lca.engine.report_tokens import PLACEHOLDER, lookup, paths_in_token

#: Marks a token whose pinned member has left the results. Not a path, so it never resolves.
GONE_PREFIX = "gone:"

#: One path inside a token — the same characters the placeholder pattern allows for a path.
_PATH = re.compile(r"[A-Za-z0-9_.\-\[\]]+")


def today(path: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]]) -> str | None:
    """`path` with every pinned ranked index replaced by its member's position today — None when a
    member it crosses is gone.

    The walk `report_bindings._bound_walk` makes, outermost level first and each one entered through
    the member its own pin names, recording where that member stands instead of only fetching it. A
    level without a pin is read by position, as printing reads it, and keeps its index.
    """
    splits = ranked_splits(path)
    if not splits:
        return path
    node: Any = data
    walked = ""  # the original path up to the level last entered
    moved = ""  # the same prefix in today's positions
    for head, index, _rest in splits:
        step = head[len(walked) + 1 :] if walked else head
        items = lookup(step, node) if step else node
        pin = bindings.get(f"{head}.{index}")
        position: int | None = index
        if pin:
            members = items if isinstance(items, (list, tuple)) else []
            position = next((i for i, item in enumerate(members) if identity_matches(item, pin)), None)
            if position is None:
                return None
        node = lookup(str(position), items) if isinstance(items, (list, tuple)) else None
        if node is None:
            if pin:
                return None
            # Nothing pinned here and nothing at the place: the path prints a gap today as it is, and
            # it stays as it is from here on — what is gone is only ever said of a pinned member.
            return (f"{moved}{head[len(walked):]}" if walked else head) + path[len(head) :]
        moved = f"{moved}{head[len(walked):]}.{position}" if walked else f"{head}.{position}"
        walked = f"{head}.{index}"
    return moved + path[len(walked) :]


def rebase(text: str, data: dict[str, Any], bindings: dict[str, dict[str, Any]] | None) -> str:
    """The text with every placeholder pointing where its pins point, in today's positions."""
    if not bindings or not text:
        return text or ""

    def token(m: re.Match[str]) -> str:
        inner = m.group(1)
        paths = paths_in_token(inner)
        moved: dict[str, str] = {}
        for path in paths:
            now = today(path, data, bindings)
            if now is None:
                return "{{" + GONE_PREFIX + inner + "}}"
            if now != path:
                moved[path] = now
        if not moved:
            return m.group(0)
        # One pass over the token, so two members that swapped places cannot swap back.
        return "{{" + _PATH.sub(lambda p: moved.get(p.group(0), p.group(0)), inner) + "}}"

    return PLACEHOLDER.sub(token, text)


__all__ = ["GONE_PREFIX", "rebase", "today"]
