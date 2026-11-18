"""Letting go of the workspace that was left: closing what other threads still hold open in it.

A SQLite connection belongs to the thread that opened it, and Brightway's switch closes only those of the
thread that switches. The others go with the database object they belong to, and not even when the last
reference to them is dropped: a Python SQLite connection keeps its statement cache, and the cache points
back at the connection, so only a garbage collection closes it. Until one runs, `parameters.db` and
`lci/databases.db` of the workspace that was left stay open, and Windows refuses to delete, move or rename
the folder of a workspace the user is no longer in — from the app as from outside it.

Two moments call for a collection:

- **The switch.** Brightway sends `project_changed` once every database has moved to the new workspace,
  and one collection then takes the old database objects with every thread's connection to them.
- **The end of a read the switch fell into.** Many reads run without the switch's locks: the HTTP
  requests that only read (the parameter list, say), the background warm-ups and index builds, an import's
  indexing after it has finished. One that is in the middle of a query while the switch collects still
  holds its cursor, and the cursor holds its connection, so that connection survives the switch's
  collection. So every HTTP request runs inside `reading()`, and so does every thread of ours that touches
  Brightway (`reader()`; `tests/test_left_workspace.py` holds new threads to that). When one ends with a
  switch behind it that it did not make itself, a collection follows; work no switch fell into costs nothing.

Deleting a workspace collects once more on its own (`delete_project`), at the moment the folder has to be
free: a read that ended just before it may still be waiting for its collection.
"""
from __future__ import annotations

import contextvars
import gc
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager

#: How long the collection after a crossed read waits. It does not need to: the read has let go by the time
#: it is asked for. It is there so that the reads a switch fell into, ending together, share one collection.
COLLECT_AFTER_S = 0.2

#: How many switches this process has made so far.
_switches = 0
#: Counts the switches the bracketed work makes itself: a request that switches has not been crossed by its
#: own switch. A list, so the count reaches the bracket from the worker thread the request's handler runs in
#: (it runs in a copy of the request's context, and a copy shares the list).
_own_switches: contextvars.ContextVar[list[int] | None] = contextvars.ContextVar(
    "prism_own_switches", default=None
)
_collection_due = False
_due_lock = threading.Lock()


def connect() -> None:
    """Hook into Brightway's switch. Called once, right after `bw2data` was first imported."""
    from bw2data.signals import project_changed

    # Every switch, wherever it starts: a workspace opened, created, deleted, imported into, restored.
    project_changed.connect(_let_go, weak=False)


def _let_go(_sender: object, **_kwargs: object) -> None:
    global _switches
    _switches += 1
    own = _own_switches.get()
    if own is not None:
        own[0] += 1
    gc.collect()


@contextmanager
def reading() -> Iterator[None]:
    """Bracket work that touches Brightway: a switch inside it that it did not make is let go of at its end."""
    own = [0]
    token = _own_switches.set(own)
    started_after = _switches
    try:
        yield
    finally:
        _own_switches.reset(token)
        if _switches - started_after > own[0]:
            _collect_soon()


def reader[T](fn: Callable[..., T]) -> Callable[..., T]:
    """`fn` run inside `reading()` — for the target of a thread that touches Brightway."""

    def bracketed(*args: object, **kwargs: object) -> T:
        with reading():
            return fn(*args, **kwargs)

    return bracketed


def _collect_soon() -> None:
    """Collect on a thread of our own: a full collection holds every other thread for a moment, and the work
    that ended may be a request answered on the server's event loop."""
    global _collection_due
    with _due_lock:
        if _collection_due:
            return
        _collection_due = True
    timer = threading.Timer(COLLECT_AFTER_S, _collect)
    timer.daemon = True
    timer.start()


def _collect() -> None:
    global _collection_due
    # Cleared first: a read that ends while this collection runs asks for the next one, it is not lost.
    with _due_lock:
        _collection_due = False
    gc.collect()
