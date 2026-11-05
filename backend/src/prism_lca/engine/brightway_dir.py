"""Which Brightway directory the app opens: its own, never another Brightway installation's.

Brightway takes its directory from ``BRIGHTWAY2_DIR``, and people who already work with Brightway or the
Activity Browser often have it set for good — on Windows as a user variable that every program inherits,
PrismLCA included. Followed as it is, PrismLCA lists their projects as its workspaces, and its start-up
housekeeping writes into whichever one is active (bw2data's search flag and index, exchange uids); it
stamps the directory with its data format and opens SQLite files the Activity Browser may have open at
the same time, and a variable pointing at a folder that no longer exists stops the backend before it
starts. So the app decides from its own settings and hands the result to Brightway: ``PRISM_BRIGHTWAY_DIR``
when set, else ``brightway`` inside the data directory (``PRISM_DATA_DIR``).

An inherited ``BRIGHTWAY2_DIR`` is never opened. One that carries PrismLCA's data-format stamp is a
directory an earlier version worked in: its workspaces are copied into the app's own directory on the
first start there (``engine/workspace_carryover.py``). Run from source, any other value of the variable
refuses the start instead of being passed over: a developer who sets it means a throwaway directory, and
the default would be the real one.

No variable can point the app into somebody else's projects either. It opens a Brightway directory
only when it is empty (or not there yet), when it carries :data:`OWNER_FILE` — the mark :func:`claim`
puts into an empty directory PrismLCA is about to fill — or when it is the ``brightway`` folder of a
PrismLCA data directory, as every version before the mark made it. Anything else is refused before a
single file is written: a foreign Brightway directory, the shared one an earlier version stamped (the
stamp says PrismLCA started there, not that the projects are its own), or a project folder inside one.

Scripts and tests import the engine without going through here and keep Brightway's own rule
(``engine/bootstrap.py``).
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_dir

from prism_lca.config import APP_NAME, Settings
from prism_lca.engine.data_version import STAMP_FILE

#: Brightway's own variable, read by bw2data when it is first imported.
BRIGHTWAY_ENV = "BRIGHTWAY2_DIR"
#: Written into a Brightway directory PrismLCA creates: the app opens such a directory, and no other one.
OWNER_FILE = "prism-brightway-owner.json"
_PROJECTS_DB = "projects.db"


def _empty(path: Path) -> bool:
    return not path.exists() or (path.is_dir() and not any(path.iterdir()))


def claim(path: Path) -> None:
    """Mark ``path`` as PrismLCA's own if it is empty or not there yet — before anything goes into it.

    Anything with content is left exactly as it is: the mark only ever goes into a directory PrismLCA is
    about to create, never into one that holds somebody's files.
    """
    if not _empty(path):
        return
    path.mkdir(parents=True, exist_ok=True)
    (path / OWNER_FILE).write_text('{"created_by": "PrismLCA"}\n', encoding="utf-8")


def take(path: Path, settings: Settings) -> str | None:
    """Claim ``path`` and confirm it is ours now; None, or why the start must stop.

    :func:`choose` looked a moment earlier. Had another program filled an empty folder since, the claim
    would quietly pass it by — so the app goes on only with the mark in place, or with the ``brightway``
    folder of its data directory, and writes nothing (no lock, no stamp) otherwise.
    """
    claim(path)
    if (path / OWNER_FILE).is_file() or (not _empty(path) and _may_open(path, settings)):
        return None
    return (
        f"Another program put files into {path} while PrismLCA was starting. PrismLCA has changed nothing "
        "there and does not work in a folder it does not own. Start again, or choose an empty folder with "
        "PRISM_BRIGHTWAY_DIR."
    )


def _may_open(path: Path, settings: Settings) -> bool:
    if _empty(path) or (path / OWNER_FILE).is_file():
        return True
    # The data directory's own Brightway folder, from before the mark: the platform's data directory for
    # PrismLCA, or one carrying PrismLCA's stamp (a copy of it, a test run's).
    data = Path(settings.data_dir)
    return _same(path, data / "brightway") and (
        _same(data, Path(user_data_dir(APP_NAME, appauthor=False))) or (data / STAMP_FILE).is_file()
    )


def default_dir(settings: Settings) -> Path:
    """The app's own Brightway directory: ``PRISM_BRIGHTWAY_DIR``, else ``brightway`` in the data directory."""
    return Path(settings.brightway_dir) if settings.brightway_dir else Path(settings.data_dir) / "brightway"


@dataclass(frozen=True)
class Choice:
    path: Path
    #: A line for the log when an inherited ``BRIGHTWAY2_DIR`` was passed over.
    note: str | None = None
    #: Why the start is refused; ``path`` is not to be opened then.
    refusal: str | None = None
    #: A directory an earlier version worked in, whose workspaces belong in ``path``.
    carry_over_from: Path | None = None


def _same(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def choose(settings: Settings, environ: Mapping[str, str], *, from_source: bool) -> Choice:
    """The directory this app process gives Brightway (see the module docstring for the rules)."""
    own = default_dir(settings)
    if not _may_open(own, settings):
        return Choice(
            own,
            refusal=(
                f"PrismLCA was told to keep its Brightway projects in {own}, a folder it did not create "
                "and that already holds files. PrismLCA never works inside another Brightway "
                "installation's projects and has changed nothing there. Choose an empty folder with "
                "PRISM_BRIGHTWAY_DIR, or one PrismLCA created."
            ),
        )
    inherited = (environ.get(BRIGHTWAY_ENV) or "").strip()
    if not inherited or _same(Path(inherited), own):
        return Choice(own)
    other = Path(inherited)
    if settings.brightway_dir:
        return Choice(own, note=f"{BRIGHTWAY_ENV}={other} is not used: PRISM_BRIGHTWAY_DIR chooses {own}.")
    if from_source:
        return Choice(
            own,
            refusal=(
                f"{BRIGHTWAY_ENV} is set to {other}. PrismLCA does not follow Brightway's variable, because "
                "it usually belongs to another Brightway installation. Unset it to use "
                f"{own}, or set PRISM_BRIGHTWAY_DIR to a directory of PrismLCA's own — an empty one, or one "
                "its scripts created."
            ),
        )
    note = (
        f"{BRIGHTWAY_ENV}={other} belongs to another Brightway installation and is left alone; PrismLCA "
        f"keeps its databases in {own}. PRISM_BRIGHTWAY_DIR chooses a different directory."
    )
    if (other / STAMP_FILE).is_file():
        return Choice(own, note=note, carry_over_from=other)
    return Choice(own, note=note)
