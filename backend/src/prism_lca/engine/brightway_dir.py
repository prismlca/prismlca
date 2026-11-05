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

``PRISM_BRIGHTWAY_DIR`` cannot point the app into somebody else's projects either. The app opens only a
Brightway directory it created — empty when it came, and marked then with :data:`OWNER_FILE`
(:func:`claim`) — or the one at its default location, which nothing else creates. A directory that
already holds Brightway projects without that mark is refused, the shared one an earlier version stamped
included: the stamp says PrismLCA started there, not that the projects are its own.

Scripts and tests import the engine without going through here and keep Brightway's own rule
(``engine/bootstrap.py``).
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from prism_lca.config import Settings
from prism_lca.engine.data_version import STAMP_FILE

#: Brightway's own variable, read by bw2data when it is first imported.
BRIGHTWAY_ENV = "BRIGHTWAY2_DIR"
#: Written into a Brightway directory PrismLCA creates: the app opens such a directory, and no other one.
OWNER_FILE = "prism-brightway-owner.json"
_PROJECTS_DB = "projects.db"


def claim(path: Path) -> None:
    """Mark ``path`` as PrismLCA's own when it holds no Brightway projects yet, before anything does.

    A directory with projects is left as it is — the mark only ever goes into one PrismLCA is about to
    create, never into one another installation made.
    """
    if (path / _PROJECTS_DB).exists() or (path / OWNER_FILE).exists():
        return
    path.mkdir(parents=True, exist_ok=True)
    (path / OWNER_FILE).write_text('{"created_by": "PrismLCA"}\n', encoding="utf-8")


def _somebody_elses(path: Path) -> bool:
    return (path / _PROJECTS_DB).exists() and not (path / OWNER_FILE).exists()


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
    if settings.brightway_dir and _somebody_elses(own):
        return Choice(
            own,
            refusal=(
                f"PRISM_BRIGHTWAY_DIR points at {own}, which holds Brightway projects PrismLCA did not "
                "create. PrismLCA never works inside another Brightway installation's projects and has "
                "changed nothing there. Choose an empty folder, or one PrismLCA created."
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
