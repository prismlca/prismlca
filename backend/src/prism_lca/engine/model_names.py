"""What a model name may hold: one line, and no slash. Typed names are refused, names from a file are cleaned.

A control character puts a name on two lines in every list that shows it. A slash breaks the model's
addresses: most routes carry the name as one path segment (``/model/activities/{database}``), and the
server routes on the decoded path, so even a slash sent as ``%2F`` splits the segment and the request
answers "Not Found". Every other character travels percent-encoded and arrives intact.

A model that already carries such a name keeps it: create, copy and rename take their names in the request
body, so it can still be copied and renamed, which is how it is repaired.
"""

from __future__ import annotations

import re

from prism_lca.errors import PrismError

#: C0 and C1 controls plus the Unicode line and paragraph separators; format characters (joiners, marks) stay allowed.
_BREAKING = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")
#: What a slash becomes in a name read from a file.
_SLASH_STANDIN = "-"


def clean(name: str) -> str:
    """``name`` as a model can carry it: each run of control characters, with the spaces around it, becomes
    one space, the ends are trimmed, and each slash becomes a hyphen. A name without any of these comes back
    exactly as it was given."""
    name = name or ""
    if _BREAKING.search(name):
        name = " ".join(part.strip() for part in _BREAKING.split(name) if part.strip())
    return name.replace("/", _SLASH_STANDIN)


def assert_allowed(name: str) -> None:
    """Refuse a typed name with a control character or a slash, after trimming the ends as the repository does."""
    name = (name or "").strip()
    suggestion = clean(name)
    if _BREAKING.search(name):
        raise PrismError(
            "A model name cannot contain line breaks, tabs or other control characters.",
            code="invalid_name",
            hint=f"Write the name on one line, for example ‘{suggestion}’." if suggestion else
            "Write the name on one line.",
        )
    if "/" in name:
        raise PrismError(
            "A model name cannot contain a slash (/): PrismLCA looks a model up by its name, and a slash "
            "cuts that name in two.",
            code="invalid_name",
            hint=f"Use a hyphen or another character instead, for example ‘{suggestion}’.",
        )
