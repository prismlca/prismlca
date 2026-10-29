"""The workspace's geography names, read from the user's own ecoinvent release.

ecoinvent's location codes — "RER", "CA-QC", "Europe without Switzerland" — come with their English
names in the release's ``MasterData/Geographies.xml``, beside the ``ElementaryExchanges.xml`` the
import reads anyway. We take them from the user's copy and keep them in
``prism_meta/geographies.json``; nothing of the list ships with PrismLCA, the same rule as for flow
names (bring your own data, docs/DATENHERKUNFT.md).

The ecoinvent import writes the file. A workspace imported before that reads the names once from the
release folder the background registry recorded, if the folder is still there. Without ecoinvent (a
workspace with BAFU only) there is no file: the frontend then names countries from ICU and a handful
of region codes from its own short list (``shared/geographyNames.ts``).
"""

from __future__ import annotations

import threading
import xml.etree.ElementTree as ET
from pathlib import Path

from prism_lca.engine._store import prism_meta_dir, read_json, write_json_atomic

FILE = "geographies.json"
_XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"
_lock = threading.Lock()


def _path() -> Path:
    return prism_meta_dir() / FILE


def release_file(ecospold2_dir: Path) -> Path:
    """Where a release keeps its geographies: ``MasterData`` beside the ``datasets`` folder."""
    return ecospold2_dir.parent / "MasterData" / "Geographies.xml"


def parse(path: Path) -> dict[str, str]:
    """``shortname → English name`` for every geography in an ecoSpold2 ``Geographies.xml``."""
    names: dict[str, str] = {}
    for _event, element in ET.iterparse(path, events=("end",)):
        if element.tag.rsplit("}", 1)[-1] != "geography":
            continue
        code = name = ""
        for child in element:
            if child.get(_XML_LANG, "en") != "en":
                continue
            tag = child.tag.rsplit("}", 1)[-1]
            if tag == "shortname":
                code = (child.text or "").strip()
            elif tag == "name":
                name = (child.text or "").strip()
        if code and name:
            names[code] = name
        element.clear()  # the KML outlines are not needed
    return names


def store_from_release(ecospold2_dir: Path, destination: Path | None = None) -> int:
    """Read the release's geographies into the workspace; the number of names, 0 if it has none.

    ``destination`` defaults to the active workspace's file — the import runs with its workspace
    set and a switch waits for it; the lazy path in :func:`load` passes the file it resolved."""
    source = release_file(ecospold2_dir)
    if not source.is_file():
        return 0
    names = parse(source)
    if names:
        with _lock:
            write_json_atomic(destination or _path(), names, sort_keys=True)
    return len(names)


def load() -> dict[str, str]:
    """The workspace's names — from the stored file, or read once from the recorded release.

    Under the workspace lock: the file, the registry that names the release and the write all
    belong to one workspace, and a switch in between would store one workspace's names in another.
    """
    from prism_lca.engine.commands import PROJECT_LOCK

    with PROJECT_LOCK:
        path = _path()
        if not path.exists():
            _from_recorded_release(path)
        names = read_json(path, default={}, on_error="empty")
    return names if isinstance(names, dict) else {}


def forget() -> None:
    """Drop the names with the ecoinvent database they came from."""
    with _lock:
        _path().unlink(missing_ok=True)


def _from_recorded_release(destination: Path) -> None:
    from prism_lca.engine.backgrounds import common as backgrounds

    database = backgrounds.database_of(backgrounds.PROVIDER_ECOINVENT)
    info = backgrounds.registry(database) if database else None
    if info is not None and info.source_path:
        store_from_release(Path(info.source_path), destination)
