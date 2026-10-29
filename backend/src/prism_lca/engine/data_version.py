"""Which data format a PrismLCA data directory holds — the stamp an update checks before opening it.

Every release reads the stamp first. A directory written by a
NEWER format is refused, untouched, with a sentence naming the version that wrote it — an older
PrismLCA must never half-understand newer data (a user who goes back with an older installer would
otherwise lose work silently). A directory without a stamp gets one. The first release ships this
before any migration exists, so that later releases find the stamp in every data directory.

When a release changes the on-disk format: raise ``DATA_SCHEMA``, migrate (backup first),
then stamp. Nothing here migrates yet.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

#: The data format this version reads and writes. Raise it only together with a migration.
DATA_SCHEMA = 1
STAMP_FILE = "prism-data-version.json"


def _read_schema(data_dir: Path) -> tuple[int | None, str | None]:
    """(format, writer) from the stamp, or (None, None) when there is none or it is unreadable.

    An unreadable stamp counts as none and is rewritten: refusing would lock a user out of their own
    data over a damaged marker; the format inside is what the data itself is, not what the marker says.
    """
    try:
        raw = json.loads((data_dir / STAMP_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None
    if not isinstance(raw, dict) or not isinstance(raw.get("schema"), int):
        return None, None
    return raw["schema"], raw.get("written_by")


def check_and_stamp(data_dirs: Path | list[Path], app_version: str) -> str | None:
    """None when this version may open every directory in ``data_dirs`` (stamping those without a
    stamp); otherwise the sentence why not. All directories are read before any is written, so a
    refused start changes nothing anywhere.

    More than one directory because the Brightway databases may live outside the data directory
    (``BRIGHTWAY2_DIR``, honoured by the instance lock and the bootstrap alike): the stamp has to sit
    where the data actually is.
    """
    dirs = [data_dirs] if isinstance(data_dirs, Path) else list(dict.fromkeys(data_dirs))
    found = [(d, *_read_schema(d)) for d in dirs]
    for _d, schema, writer in found:
        if schema is not None and schema > DATA_SCHEMA:
            who = writer or "a newer version"
            return (
                f"This data was written by PrismLCA {who} (data format {schema}). This version "
                f"({app_version}) only reads data format {DATA_SCHEMA} and has not touched it. "
                f"Install PrismLCA {who} or newer to open it."
            )
    for d, schema, _writer in found:
        if schema == DATA_SCHEMA:
            continue
        d.mkdir(parents=True, exist_ok=True)
        tmp = (d / STAMP_FILE).with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"schema": DATA_SCHEMA, "written_by": app_version}), encoding="utf-8")
        os.replace(tmp, d / STAMP_FILE)
    return None
