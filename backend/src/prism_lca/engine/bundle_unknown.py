"""Sections a bundle carried that this version cannot read: kept per model, written back on export.

A bundle written by a newer PrismLCA may hold a section this one has never heard of. Importing it must
not destroy it — a round trip through an older version would otherwise strip what the newer one wrote
— so the file is stored verbatim beside the model under ``prism_meta/imported_unknown/`` and the next
export of that model puts it back into the bundle, declared with the schema and ``required`` flag it
arrived with.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from prism_lca.engine.bootstrap import get_bd


def _unknown_root() -> Path:
    return Path(get_bd().projects.dir) / "prism_meta" / "imported_unknown"


def unknown_dir(database: str) -> Path:
    """Where a model's unread bundle sections live: a hash of its name, never the name itself.

    The name comes from a foreign manifest. Used as a path component it let a bundle write outside
    `prism_meta` — an absolute name replaced the base, `../` climbed out of it — and overwrite any
    file the app could write. A hash is one safe component
    whatever the name holds; the name is not needed on disk, only to find the folder again.
    """
    return _unknown_root() / hashlib.sha256(database.encode("utf-8")).hexdigest()[:32]


def _legacy_unknown_dir(database: str) -> Path | None:
    """The folder an older version wrote under the plain name — read, never written, and only when
    the name is one ordinary path component that stays inside the root."""
    root = _unknown_root().resolve()
    if not database or Path(database).name != database or database in (".", ".."):
        return None
    candidate = (root / database).resolve()
    return candidate if candidate.parent == root and candidate.is_dir() else None


def store_unknown(
    database: str, unknown: dict[str, bytes], entries: dict[str, dict] | None = None
) -> list[str]:
    """Keep sections this version cannot read, so a round trip does not destroy them.

    The manifest entry travels beside the file (`<file>.entry`): the next export has to declare the
    section with the schema and the `required` flag it came with, or a newer reader would take it for
    something older than it is."""
    if not unknown:
        return []
    base = unknown_dir(database)
    base.mkdir(parents=True, exist_ok=True)
    written = []
    for file, raw in sorted(unknown.items()):
        target = base / Path(file).name
        # Belt and braces: whatever the file name was, the target has to sit directly in `base`.
        if target.resolve().parent != base.resolve():
            continue
        target.write_bytes(raw)
        entry = (entries or {}).get(file)
        if entry:
            target.with_name(target.name + ".entry").write_text(
                json.dumps({k: entry[k] for k in ("schema", "required") if k in entry}), encoding="utf-8"
            )
        written.append(str(target.relative_to(base.parent.parent)))
    return written


def stored_unknown(database: str, taken: set[str]) -> list[tuple[str, bytes, dict]]:
    """What `store_unknown` kept for this model, ready to go into a bundle — `(file, bytes, manifest
    entry)` each, skipping any file this version now writes itself (`taken`)."""
    base = unknown_dir(database)
    if not base.is_dir():
        base = _legacy_unknown_dir(database) or base
    if not base.is_dir():
        return []
    out: list[tuple[str, bytes, dict]] = []
    for file in sorted(base.iterdir()):
        if file.suffix != ".json" or file.name in taken:
            continue
        raw = file.read_bytes()
        entry: dict = {}
        beside = file.with_name(file.name + ".entry")
        if beside.exists():
            try:
                entry = json.loads(beside.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001 - a damaged side file costs the flags, not the section
                entry = {}
        out.append(
            (
                file.name,
                raw,
                {
                    "file": file.name,
                    "schema": int(entry.get("schema") or 1),
                    "required": bool(entry.get("required", False)),
                    "sha256": hashlib.sha256(raw).hexdigest(),
                },
            )
        )
    return out
