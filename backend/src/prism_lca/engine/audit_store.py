"""The audit log, on disk — so „append-only audit trail" (ADR-004) is true across restarts.

Until 2026-07-31 the log lived in `CommandBus._audit`, a list in memory: every backend restart wiped
it, and the support bundle only ever showed what had happened since the last start. For a tool whose
selling point is that every change is recorded and attributable, that is the wrong half of the
promise to keep.

**JSON Lines, appended.** One entry per line, nothing rewritten. A log is appended to, so the file
format should be too: a crash mid-write costs the last line instead of the whole array, and appending
does not grow more expensive as the log does (a re-serialised JSON array would).

**The path resolves per call** (`get_bd().projects.dir`), so the log follows the active project
without anyone having to remember to switch it — the CommandBus is a singleton in `app.state` and
outlives a project change.

What is *not* here: the undo/redo stacks. They hold Python objects carrying snapshots of the
pre-change state, and serialising those would mean restoring state whose validity can no longer be
checked afterwards. So the log survives a restart and the ability to undo does not.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path

from prism_lca.engine.bootstrap import get_bd

_LOCK = threading.Lock()
#: line count per log file, so an entry's index does not need a full read. Seeded by counting once.
_counts: dict[str, int] = {}
#: per log file: the line count the timeline was built at, and the timeline. Append-only means the
#: prefix of the file never changes, so a differing count is the only possible invalidation.
_lifecycles: dict[str, tuple[int, Lifecycle]] = {}


def path() -> Path:
    return Path(get_bd().projects.dir) / "prism_meta" / "audit.jsonl"


def _count(p: Path) -> int:
    key = str(p)
    if key not in _counts:
        n = 0
        if p.exists():
            with p.open("r", encoding="utf-8") as fh:
                n = sum(1 for line in fh if line.strip())
        _counts[key] = n
    return _counts[key]


def next_index() -> int:
    """The index the next entry gets. Continues across sessions — that is the point of all this."""
    with _LOCK:
        return _count(path())


def append(entry: dict) -> None:
    """Add one entry. The caller has already set its index (see `next_index`)."""
    p = path()
    with _LOCK:
        p.parent.mkdir(parents=True, exist_ok=True)
        # A hard kill can leave a line without its newline. Appending onto it would fuse two entries
        # into one unparseable line — and `load` would then drop the *new* entry along with the old.
        if p.exists() and p.stat().st_size:
            with p.open("rb") as fh:
                fh.seek(-1, 2)
                if fh.read(1) != b"\n":
                    with p.open("a", encoding="utf-8") as out:
                        out.write("\n")
        with p.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
        _counts[str(p)] = _count(p) + 1


def load() -> list[dict]:
    """Every entry, in the order they happened.

    A line that does not parse is skipped rather than fatal: the plausible cause is a crash during the
    last write, and one lost entry must not make the whole history unreadable.
    """
    p = path()
    if not p.exists():
        return []
    out: list[dict] = []
    with p.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                out.append(item)
    return out


# --------------------------------------------------------------------------- #
# The timeline
# --------------------------------------------------------------------------- #
#: Actions that put a **new** model under a name. All three carry the new name in ``database``, and
#: the latter two carry the model they came from in ``related`` (which is what a copied model's provenance line
#: is made of). ``import_model`` is deliberately absent: it writes activities into a database that
#: already exists, so it is not a birth.
BIRTHS = ("create_model", "duplicate_model", "import_bundle")
#: Action that moves a model from one name to another. Carries the new name in ``database`` and,
#: since Phase 2, the old one in ``previous_name``.
RENAME = "rename_model"
#: Action that ends a model. Carries its name in ``database``.
DEATH = "delete_model"

#: A tenure that began before the log has any structured word about it — a rename note whose
#: ``previous_name`` names a model this log never saw created (created before the lifecycle notes
#: carried fields at all). Reaching back to the beginning is the generous reading, and it is exactly
#: what Phase 1 did for that name, so nothing that used to be attributed stops being.
BEGINNING = -1


@dataclass(frozen=True)
class Tenure:
    """One model held one name over one closed stretch of the log.

    ``start`` and ``end`` are **inclusive**, and they are entry ``index`` values, i.e. positions in
    the append-only file. The boundaries are set so that each lifecycle note lands in the history it
    reads best in: a create/duplicate/import note inside the tenure it opens, a delete note inside
    the tenure it closes, and a rename note inside the *new* name's tenure — which is the same
    decision Phase 1 made when it filed the rename under the new name.
    """

    name: str
    start: int
    end: int | None = None  # None = still carrying this name

    def contains(self, index: int) -> bool:
        return index >= self.start and (self.end is None or index <= self.end)


@dataclass
class Model:
    """One model *identity*, across every name it ever had.

    Not a name — a name is the thing that lies. The identity is what a reader means by "this model",
    and it is the only thing a rename does not change.
    """

    tenures: list[Tenure] = field(default_factory=list)
    #: The model this one was copied from (``duplicate_model``/``import_bundle`` provenance), and the
    #: index of the entry that says so ("copied from A — see its history").
    origin: str | None = None
    origin_index: int | None = None

    @property
    def current_name(self) -> str | None:
        """The name it goes by now, or None if it has none — deleted, or the name went to a newer
        model. The entries stay and say the model is gone; that is the point of append-only."""
        if not self.tenures or self.tenures[-1].end is not None:
            return None
        return self.tenures[-1].name

    @property
    def names(self) -> list[str]:
        return [t.name for t in self.tenures]


class Lifecycle:
    """Which model carried which name when, read out of the lifecycle notes in the log itself.

    **Why a timeline and not a chain of names.** Rename A → B, then create a *new* model called A.
    Now the log holds entries saying ``database: "A"`` that belong to B and newer ones saying
    ``database: "A"`` that belong to the new A. Following the rename note as a name chain hands the
    old ones to the new A — F3's mistake one level up: identity guessed from something that is not
    identity. Only the order of the log separates them, so that is what this reads.

    **The clock is the entry index**, not ``timestamp``. Two reasons, both in the code: the index is
    the position in an append-only file and therefore monotone by construction, while ``timestamp``
    is not — ``bundle.read_audit`` appends imported history *with the sender's timestamps*, so a line
    written today can carry a date from last year. And the index is a field every reader already has,
    which keeps ``attributed_to`` a function of one entry.

    **Nothing is parsed out of prose.** A rename that predates ``previous_name`` leaves only
    ``Rename model 'A' → 'B'`` in its summary, and this class does not look at it: the timeline
    starts where the structured notes start. Model names are free text — they can hold quotes and
    arrows — so a parse would be a guess about identity, which is the one thing this file exists to
    stop doing. The cost of not parsing is nil in practice: such a rename leaves the two names
    unlinked, which is precisely what Phase 1 already did, so no attribution is lost, only ungained.
    """

    def __init__(self, entries: list[dict] | None = None) -> None:
        self.models: list[Model] = []
        self._by_name: dict[str, Model] = {}         # current name -> identity
        self._tenures: dict[str, list[tuple[Tenure, Model]]] = {}
        #: names whose attribution cannot be answered by equality — either the name was held by more
        #: than one model, or its model also answers to another name. Everything else takes the fast
        #: path, so the common project pays nothing for this.
        self._contested: set[str] = set()
        self._build(entries or [])

    # -- building -----------------------------------------------------------
    def _build(self, entries: list[dict]) -> None:
        alive: dict[str, Model] = {}
        for entry in entries:
            action = entry.get("action")
            if action not in BIRTHS and action != RENAME and action != DEATH:
                continue
            index = entry.get("index")
            name = entry.get("database")
            if not isinstance(index, int) or not isinstance(name, str) or not name:
                # A lifecycle note from before the fields existed says nothing structured, and its
                # prose is not evidence (see the class docstring). Skip it, silently and on purpose.
                continue
            if action in BIRTHS:
                self._open(alive, name, index, related=entry.get("related"))
            elif action == RENAME:
                self._rename(alive, entry.get("previous_name"), name, index)
            else:
                self._close(alive, name, index)
        self._index()

    def _new(self, alive: dict[str, Model], name: str, tenure: Tenure) -> Model:
        model = Model(tenures=[tenure])
        self.models.append(model)
        alive[name] = model
        return model

    def _open(self, alive: dict[str, Model], name: str, index: int, related: object) -> None:
        # A name can only be born free: if the log never saw the previous holder go, the birth of the
        # new one is the evidence that it did. Closing it one entry earlier keeps the two apart.
        self._close(alive, name, index - 1)
        model = self._new(alive, name, Tenure(name=name, start=index))
        if isinstance(related, str) and related:
            model.origin, model.origin_index = related, index

    def _rename(self, alive: dict[str, Model], previous: object, name: str, index: int) -> None:
        old = previous if isinstance(previous, str) and previous else None
        if old is None:
            # The note predates `previous_name` (Phase 1 wrote the new name and nothing else). All we
            # know is that a model is called `name` from here on; where it came from is not in the
            # log, and the sentence in `summary` is prose, not evidence. So: a birth, and the old
            # name keeps its own entries. That is exactly what Phase 1 answered, no better, no worse.
            self._open(alive, name, index, related=None)
            return
        model = alive.pop(old, None)
        if model is None:
            # Renamed away from a name this log never saw born — a model older than the structured
            # notes. Its tenure reaches back to the start of the log, because that is where its
            # entries are and there is no evidence of anyone else having held the name.
            model = Model(tenures=[Tenure(name=old, start=BEGINNING, end=index - 1)])
            self.models.append(model)
        else:
            last = model.tenures[-1]
            model.tenures[-1] = Tenure(name=last.name, start=last.start, end=index - 1)
        model.tenures.append(Tenure(name=name, start=index))
        alive[name] = model

    def _close(self, alive: dict[str, Model], name: str, index: int) -> None:
        model = alive.pop(name, None)
        if model is None:
            return
        last = model.tenures[-1]
        model.tenures[-1] = Tenure(name=last.name, start=last.start, end=max(index, last.start - 1))

    def _index(self) -> None:
        for model in self.models:
            for tenure in model.tenures:
                self._tenures.setdefault(tenure.name, []).append((tenure, model))
            if model.current_name is not None:
                self._by_name[model.current_name] = model
        for name, held in self._tenures.items():
            if len(held) > 1:
                self._contested.add(name)
        for model in self.models:
            if len(model.tenures) > 1:
                self._contested.update(model.names)

    # -- reading ------------------------------------------------------------
    def model_named(self, database: str) -> Model | None:
        """The identity that goes by ``database`` **now**, or None if the log knows no such name."""
        return self._by_name.get(database)

    def owner(self, name: str, index: int) -> Model | None:
        """The identity that carried ``name`` at position ``index``, or None if the log does not say.

        None is not "nobody": most projects never rename or reuse a name, and every model created
        before the lifecycle notes carried fields has no birth in here at all. The caller must treat
        it as "no evidence" and fall back to the name, never as "gone".
        """
        for tenure, model in self._tenures.get(name, ()):
            if tenure.contains(index):
                return model
        return None

    def knows(self, name: str, other_than: Model | None = None) -> bool:
        """Whether *another* model in this project ever went by ``name``.

        Needed because ``related`` is not always somebody else and not always local. A bundle import
        records the name the model had in the **sender's** project
        (`ImportBundleCommand.audit_related`) — which may be a name nothing here ever had, or, when
        the name happened to be free, the importing model's *own* new name. Pointing a reader at the
        history of a model this project never had, or at the entry's own model, is a promise the log
        cannot keep. A deleted model does count: its history is still in here, which is the point.
        """
        return any(model is not other_than for _, model in self._tenures.get(name, ()))

    def contested(self, database: str) -> bool:
        """Whether ``database`` needs the timeline at all. False for every name that was never
        renamed and never reused, which is the fast path and the normal case."""
        return database in self._contested

    def resolved_name(self, name: str, index: int) -> str | None:
        """What the model that held ``name`` at ``index`` is called today, or None if it no longer
        exists.

        The name in the entry is the name **at the time**, and it is never rewritten (D3). This is the
        read-side answer the view puts beside it. ``None`` only when the log actually witnessed the
        model go: an unknown name resolves to itself, because "no lifecycle note" is not evidence of
        a death — it is the normal state of every model older than these notes.
        """
        model = self.owner(name, index)
        return name if model is None else model.current_name


def lifecycle() -> Lifecycle:
    """The timeline of the active project's log, built at most once per appended line.

    Cheap because the log is append-only: an existing line never changes, so the cached line count is
    a complete invalidation test — no mtime, no hashing. A navigation that appended nothing reuses
    the timeline and reads no file at all, which is what makes this affordable in a route that
    ``Parameters`` and ``Scenarios`` call on every visit.
    """
    p = path()
    key = str(p)
    with _LOCK:
        n = _count(p)
        hit = _lifecycles.get(key)
        if hit is not None and hit[0] == n:
            return hit[1]
    built = Lifecycle(load())  # outside the lock: this reads a file, and `append` wants the lock
    with _LOCK:
        cached = _lifecycles.get(key)
        if cached is None or cached[0] <= n:
            _lifecycles[key] = (n, built)
    return built


def attributed_to(entry: dict, database: str, timeline: Lifecycle | None = None) -> bool:
    """Whether ``entry`` belongs in ``database``'s history.

    One predicate, three readers (the ``/model/audit`` filter, the bundle's audit section, the
    tests), because a filter that drifts from the one the export uses is how F3 stayed invisible: a
    "complete" export that looked successful while carrying an arbitrary slice.

    Three fields answer yes, and each for its own reason:

    * ``database`` — this is where something changed.
    * ``databases`` — a project-wide action with a consequence *in* this model (a deleted tag group
      strips assignments from every model it touched).
    * ``related`` — the model this change came *from* (``Copy 'x' from A into B``: the entry is a
      change in B and a provenance line in A, and a reviewer standing in A must see that its
      substance left the building).

    An entry with none of the three is **not** attributed to anything, and no amount of name
    matching in ``summary`` makes it so — that inference is exactly what F3 was.

    **A name is only the name at the time** (D3), so a match on the field is checked against the
    timeline: the entries a renamed model wrote under its old name are its own, and the entries an
    earlier model wrote under a name that has since been reused are not. ``timeline`` is passed in by
    a caller that has already loaded the log; left out, it comes from the per-file cache, which is
    what keeps the bundle's export on the same answer without the bundle having to know about any of
    this.
    """
    named = [n for n in (entry.get("database"), entry.get("related")) if isinstance(n, str)]
    listed = entry.get("databases")
    if isinstance(listed, list):
        named += [n for n in listed if isinstance(n, str)]
    if timeline is None:
        timeline = lifecycle()
    if not timeline.contested(database):
        return database in named  # never renamed, never reused: the name *is* the identity
    target = timeline.model_named(database)
    if target is None:
        return database in named  # the log knows the name is contested but not who holds it now
    index = entry.get("index")
    for name in named:
        if not isinstance(index, int):
            return database in named  # no position, no resolution — do not drop the line over it
        owner = timeline.owner(name, index)
        if owner is target or (owner is None and name == database):
            return True
    return False


def is_attributed(entry: dict) -> bool:
    """Whether the entry names any model at all. False for every line written before the field
    existed — every one of the development log's 1268 lines, which is why they get their own block in the
    model view instead of being mixed in."""
    return bool(entry.get("database") or entry.get("related") or entry.get("databases"))


def reset_cache() -> None:
    """Forget the cached line counts and timelines — for tests, and after a project is created or
    deleted. Both are keyed by the path string, and a deleted-then-recreated project reuses it;
    a timeline built from the old project's log would then place the new one's entries."""
    with _LOCK:
        _counts.clear()
        _lifecycles.clear()
