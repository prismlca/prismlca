"""Where a database's search index lives: inside the workspace's ``prism_search`` folder, whatever the
database is called.

A database name is free text. A name that reads as a plain relative path keeps the place its index has
always had (``prism_search/<name>``, sub-folders included for a name with a slash), so existing indexes are
found where they are. Any other name — absolute, with a drive, or with a ``..`` part — is stored under a
readable stem plus a hash of the exact name, the way study files are named.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path, PurePath

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")
#: The ending of a hashed stem. A plain name ending like one is hashed as well, so no two names share files.
_HASHED = re.compile(r"~[0-9a-f]{20}$")


def _plain(name: str) -> bool:
    """A relative path of ordinary parts: no anchor, no part made only of dots and spaces."""
    if not name or "\x00" in name:
        return False
    path = PurePath(name)
    return (
        not path.anchor
        and bool(path.parts)
        and all(part.strip(". ") for part in path.parts)
        and not _HASHED.search(path.parts[-1])
    )


def index_base(root: Path, db_name: str) -> Path:
    """The index files' common path (without ``.npz``/``.json``), always below ``root``."""
    if _plain(db_name):
        return root / db_name
    digest = hashlib.sha256(db_name.encode("utf-8", "surrogatepass")).hexdigest()[:20]
    readable = _UNSAFE.sub("_", db_name)[:80].strip("._") or "database"
    return root / f"{readable}~{digest}"
