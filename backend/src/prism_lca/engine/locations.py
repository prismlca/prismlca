"""Locations a model can store that Brightway reads back as text.

When bw2data processes a database it reads each activity's location back with ``eval`` as soon as the stored text
contains a round bracket: that is how a regionalised location, which Brightway keeps as a tuple, comes back from its
text form. Any other text with a round bracket would be run as Python code. So text on its way into a model is made
safe here: its round brackets become square ones ("Russia (Asia)" → "Russia [Asia]"), which reads the same to a
person and is never evaluated. A real tuple (Brightway's regionalised location) passes as it is; text shaped like one
does not, because Brightway would turn it into a tuple its geography table does not know, and every calculation of
the workspace would fail.

Every way into a model or "My processes" rewrites before it saves — the inspector, the assistant and MCP, the
copies, and every import — and says so: an edit in its answer, an import in the log. The same pass runs over what is
stored when a workspace opens and right before Brightway processes a database, for data from before this rule and
for any way in that has none. Background databases are imported from their own sources and are left as they are.
"""
from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager

_logger = logging.getLogger(__name__)
_local = threading.local()


def _bracketless(value):
    if value is None or isinstance(value, tuple):
        return value
    if not isinstance(value, str):
        # A number or a list from a file: Brightway would map the value and look up its text form, which it does
        # not know, and every calculation of the workspace would fail. Stored as its text, it matches itself.
        value = str(value)
    if "(" not in value:
        return value
    return value.replace("(", "[").replace(")", "]")


def safe_location(value):
    """The location as a model may store it: text with round brackets gets square ones, any other value but no
    location or a real tuple becomes its text. Inside :func:`recording`, each rewrite is recorded."""
    safe = _bracketless(value)
    pairs = getattr(_local, "pairs", None)
    if pairs is not None and safe != value:
        pairs.append((value, safe))
    return safe


@contextmanager
def recording() -> Iterator[list[tuple[str, str]]]:
    """Collects the (before, after) of every location :func:`safe_location` rewrites in this thread meanwhile, so an
    import can say what it changed."""
    outer = getattr(_local, "pairs", None)
    _local.pairs = pairs = []
    try:
        yield pairs
    finally:
        _local.pairs = outer
        if outer is not None:
            outer.extend(pairs)


def location_note(before, after) -> str | None:
    """One sentence for the person when a location was rewritten; None when it was not."""
    if before == after or not isinstance(before, str):
        return None
    return (
        f"The location '{before}' is stored as '{after}': a location in a model keeps no round brackets, "
        "so they become square ones."
    )


def _summary(pairs: list[tuple[str, str]]) -> str:
    n = len(pairs)
    shown = "; ".join(f"'{b}' → '{a}'" for b, a in pairs[:3]) + (" …" if n > 3 else "")
    return (
        f"{n} location{'s' if n != 1 else ''} stored with square brackets instead of round ones ({shown}): "
        "a location in a model keeps no round brackets"
    )


def note_rewrites(bus, pairs: list[tuple[str, str]], database: str | None) -> None:
    """One line in the log for what an import rewrote, attributed to the model it went into."""
    if pairs and bus is not None:
        bus.note("system", "safe_locations", _summary(pairs), database=database)


def _databases_to_check() -> list[str]:
    """Every database Brightway may process that is not a background: the models, "My processes", and any of
    unknown origin. Not the biosphere, not a background, and not a background still being imported (it has no
    mark yet, but it comes from its source like the finished ones)."""
    from prism_lca.engine import ecoinvent
    from prism_lca.engine.backgrounds.common import COMPLETE_KEY
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    status = ecoinvent._status
    importing = status.state == ecoinvent.JobState.running
    names = []
    for name in bd.databases:
        meta = bd.databases[name]
        # By its marks, never its name: a model may be called biosphere3 where none was imported, and a background
        # import may have been given a name the app also uses for something else.
        if meta.get(COMPLETE_KEY) or meta.get("prism_read_only") is True:
            continue
        if importing and (name == status.database or "prism_read_only" not in meta):
            continue
        names.append(name)
    return names


def make_stored_locations_safe(bus=None) -> dict[str, list[tuple[str, str]]]:
    """Rewrites every stored location that Brightway would evaluate, in every database this module covers, and
    returns what changed per database as (before, after) pairs. Run when a workspace opens (its data may predate
    this rule) and right before Brightway processes databases, so a value that came in by a way nobody normalised
    is caught before it is evaluated. With a command bus, each database that changed gets one line in the log."""
    from bw2data.backends.schema import ActivityDataset as AD

    from prism_lca.engine.bootstrap import get_bd

    names = _databases_to_check()
    if not names:
        return {}
    rows = list(
        AD.select(AD.database, AD.code, AD.location).where(AD.database.in_(names) & AD.location.contains("("))
    )
    changed: dict[str, list[tuple[str, str]]] = {}
    bd = get_bd()
    for row in rows:
        act = bd.get_activity((row.database, row.code))
        before = act.get("location")
        after = _bracketless(before)  # a real tuple is text only in the column, and passes
        if after == before:
            continue
        act["location"] = after
        act.save()
        changed.setdefault(row.database, []).append((before, after))
    for database, pairs in changed.items():
        _logger.warning("%s: %s", database, _summary(pairs))
        note_rewrites(bus, pairs, database)
    return changed

