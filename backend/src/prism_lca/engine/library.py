"""``My processes`` — the project's own library of datasets, and where every import lands.

The alternative was one read-only database per import source, which is what Brightway users
normally do and what PrismLCA did until this module. It has one property that sinks it here:
**search runs against exactly one database** (``search(query, db_name)``, and the sidebar has a
picker). Ten suppliers would mean ten indexes and a user who has to know where a dataset lives
before they can look for it.

So: one writable library per project, and it is **live-linked**. A model's exchange points into it
by ``(database, code)`` — the same mechanism that already points into ecoinvent, no new machinery.
Change a dataset here and every model that draws on it changes with it. That is the point, and it
is also the risk: a finished study's numbers move under it. The report's own staleness marking
catches that after the fact; :func:`consumers_of_keys` is what lets the UI say it beforehand.

Provenance therefore sits on the **activity**, not on the database: source, format, date and a
batch id per dataset. Without that, "remove this import again" could not be expressed at all once
the database itself stays.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.guardrails import set_read_only
from prism_lca.errors import PrismError

#: The library's name. Fixed, not configurable: it is an address that models' exchanges point at,
#: and a renameable address is a broken one. Per project — a project is a closed world.
LIBRARY_DB = "My processes"

#: On the registry entry, so `list_databases` can hand out a kind of its own and the UI never
#: mistakes the library for a study.
LIBRARY_KEY = "prism_library"

#: On each activity: where it came from and which import brought it.
SOURCE_KEY = "prism_import_source"
FORMAT_KEY = "prism_import_format"
BATCH_KEY = "prism_import_batch"
BATCH_LABEL_KEY = "prism_import_label"
DATE_KEY = "prism_import_date"

BIOSPHERE_DB = "biosphere3"


def ensure_library() -> str:
    """Create the library if this project has none. Returns its name."""
    bd = get_bd()
    if LIBRARY_DB not in bd.databases:
        bd.Database(LIBRARY_DB).register(searchable=False)  # no bw2data FTS index — see engine/hygiene.py
    set_read_only(LIBRARY_DB, False)
    bd.databases[LIBRARY_DB][LIBRARY_KEY] = True
    bd.databases.flush()
    return LIBRARY_DB


def ensure_library_if_set_up() -> str | None:
    """Create the library for a project that is past its ecoinvent import. Returns it, or None.

    Called at startup and on every project switch, so the library is a **place that is already
    there** rather than something an import conjures up. Guarded by "has a background inventory"
    for one concrete reason: the Overview opens the ecoinvent wizard when a project holds no
    databases at all, and an eagerly created empty library would silently take that gate away.
    """
    bd = get_bd()
    if LIBRARY_DB in bd.databases:
        return LIBRARY_DB
    return ensure_library() if any(_is_background(n) for n in bd.databases) else None


def is_library(name: str) -> bool:
    return name == LIBRARY_DB


def new_batch() -> str:
    """An id for one import. Short because it shows up in a table, random because two imports of
    the same file on the same day are two imports."""
    return uuid4().hex[:12]


def stamp(source: str, fmt: str, batch: str, label: str) -> dict[str, Any]:
    """The provenance fields every imported activity carries."""
    return {
        SOURCE_KEY: source,
        FORMAT_KEY: fmt,
        BATCH_KEY: batch,
        BATCH_LABEL_KEY: label,
        DATE_KEY: datetime.now(UTC).date().isoformat(),
    }


def _is_background(name: str) -> bool:
    """An inventory the user draws on rather than builds: ecoinvent, or a leftover import.

    Two markers, not one, and that is not belt-and-braces: ``prism_import_complete`` was added
    later, so an ecoinvent imported before it carries only the read-only flag. Checking the flag
    for an *explicit* True matters just as much — :func:`prism_lca.engine.guardrails.is_read_only`
    answers True for a database with no flag at all, so asking it here would call every unflagged
    model background and, in :func:`model_databases`, skip the very databases we must scan.
    """
    if name in (LIBRARY_DB, BIOSPHERE_DB):
        return False
    meta = get_bd().databases[name]
    return bool(meta.get("prism_import_complete")) or meta.get("prism_read_only") is True


def model_databases() -> list[str]:
    """The user's own models — everything that is neither the library, the biosphere, nor imported
    background.

    Deliberately not ``not is_read_only(name)``: an unflagged database reads as read-only, so that
    test once skipped every model there was. What is excluded here is what is *explicitly* marked
    background — a database we cannot classify is scanned rather than silently ignored, and the
    price of scanning one too many is a slow answer, not a wrong one.
    """
    bd = get_bd()
    return sorted(
        name
        for name in bd.databases
        if name not in (LIBRARY_DB, BIOSPHERE_DB) and not _is_background(name)
    )


def consumers_of_keys(codes: set[str]) -> dict[str, int]:
    """Which models draw on these library datasets, and how many exchanges each has.

    Asked before deleting an import, and worth asking before editing one: a dangling exchange is
    not a visible error, it is a number that quietly stops being there.
    """
    if not codes:
        return {}
    bd = get_bd()
    out: dict[str, int] = {}
    for name in model_databases():
        hits = 0
        for activity in bd.Database(name):
            for exchange in activity.exchanges():
                target = exchange.input
                if target[0] == LIBRARY_DB and target[1] in codes:
                    hits += 1
        if hits:
            out[name] = hits
    return out


def batches() -> list[dict[str, Any]]:
    """The imports this library holds, newest label last — one row per batch, not per dataset."""
    bd = get_bd()
    if LIBRARY_DB not in bd.databases:
        return []
    found: dict[str, dict[str, Any]] = {}
    for activity in bd.Database(LIBRARY_DB):
        batch = activity.get(BATCH_KEY)
        if not batch:
            continue
        row = found.setdefault(
            batch,
            {
                "batch": batch,
                "label": activity.get(BATCH_LABEL_KEY) or "",
                "source": activity.get(SOURCE_KEY) or "",
                "format": activity.get(FORMAT_KEY) or "",
                "date": activity.get(DATE_KEY) or "",
                "datasets": 0,
            },
        )
        row["datasets"] += 1
    return sorted(found.values(), key=lambda r: (r["date"], r["label"]))


def own_datasets() -> int:
    """Datasets in the library that no import brought — the ones the user built by hand."""
    bd = get_bd()
    if LIBRARY_DB not in bd.databases:
        return 0
    return sum(1 for a in bd.Database(LIBRARY_DB) if not a.get(BATCH_KEY))


def delete_batch(batch: str, *, force: bool = False) -> dict[str, Any]:
    """Remove one import from the library. The datasets go; the library and everything else stays.

    This is the counterpart to a commit, and the reason it is per batch rather than per database:
    the library is permanent, so "undo that import" has to be expressible without deleting the
    place it landed in.
    """
    bd = get_bd()
    if LIBRARY_DB not in bd.databases:
        raise PrismError("This workspace has no library yet.", code="library_missing", status_code=404)
    victims = [a for a in bd.Database(LIBRARY_DB) if a.get(BATCH_KEY) == batch]
    if not victims:
        raise PrismError(
            f"No import with the id “{batch}” is in the library.",
            code="batch_not_found",
            status_code=404,
        )
    codes = {a["code"] for a in victims}
    used = consumers_of_keys(codes)
    # The library draws on itself: an import linked A → B, and B re-imported on its own is a batch of
    # one whose consumer A stays behind. The models were scanned, the library was not — deleting B
    # emptied A's input without a word, and every model on A lost B's burden. A
    # consumer that goes in the same deletion is not a victim of it.
    inside = sum(
        1
        for activity in bd.Database(LIBRARY_DB)
        if activity["code"] not in codes
        for exchange in activity.exchanges()
        if exchange.get("type") != "production"
        and exchange.input.key[0] == LIBRARY_DB
        and exchange.input.key[1] in codes
    )
    if inside:
        used = {**used, LIBRARY_DB: inside}
    if used and not force:
        listed = ", ".join(f"{name} ({n})" for name, n in used.items())
        raise PrismError(
            f"{len(used)} of your models draw on datasets from this import: {listed}. Deleting it "
            f"would leave their exchanges pointing at nothing.",
            code="import_in_use",
            status_code=409,
            hint="Replace those exchanges first, or delete it anyway if you mean to.",
        )
    for activity in victims:
        activity.delete()
    return {
        "deleted": batch,
        "datasets": len(victims),
        "was_used_by": sorted(used),
        # For the caller to take out of the search index — the datasets are gone, the index is not.
        "codes": sorted(codes),
    }
