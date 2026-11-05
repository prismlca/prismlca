"""A model name holds one line: typed names with a control character are refused, names from a file are cleaned."""

from __future__ import annotations

import re

from prism_lca.errors import PrismError

#: C0 and C1 controls plus the Unicode line and paragraph separators; format characters (joiners, marks) stay allowed.
_BREAKING = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")


def clean(name: str) -> str:
    """``name`` on one line: each run of control characters, with the spaces around it, becomes one space,
    and the ends are trimmed. A name without any comes back exactly as it was given."""
    if not _BREAKING.search(name or ""):
        return name
    return " ".join(part.strip() for part in _BREAKING.split(name) if part.strip())


def assert_one_line(name: str) -> None:
    """Refuse a name that holds a control character, after trimming the ends as the repository does."""
    if _BREAKING.search((name or "").strip()):
        suggestion = clean(name)
        raise PrismError(
            "A model name cannot contain line breaks, tabs or other control characters.",
            code="invalid_name",
            hint=f"Write the name on one line, for example ‘{suggestion}’." if suggestion else
            "Write the name on one line.",
        )
