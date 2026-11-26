""""Why different?" computed by the comparison that scores the subjects, across the requests of one run.

The Results page computes a comparison one subject per request, so that its progress bar moves and Cancel takes
effect between subjects. A split needs two subjects' systems, each read while it is the factorised one: reading a
side again later means factorising its system again (a scenario's window, a model of its own), which costs as much
as the comparison. So the sides a run's plan (:mod:`difference_plan`) needs are read by the comparison's own solves
and kept here, under the token the page gives the run, and a pair is split in the request that brings its second
side. A side is let go once every pair it belongs to is split; the run itself (its plan) stays for the requests
still to come.

A run is short-lived state, bounded twice: only the newest few runs are kept, and none longer than a few minutes —
a run the page left (cancelled, superseded, the page closed) is not finished by anyone.
"""
from __future__ import annotations

import contextlib
import json
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

from prism_lca import _log
from prism_lca.engine import difference, difference_plan, lca, method_lookup
from prism_lca.engine import difference_terms as terms
from prism_lca.errors import PrismError

#: How many changes an indicator names: the page lists them all on a click, and a foreground model rarely changes
#: more entries than this between two variants; past it, the rest is summed (``more``).
TOP_N = 100
#: What a pair says when one of its two results could not be read off its calculation.
UNREADABLE = "One of the two results could not be read for the split. The scores are not affected."
#: What a pair says when the model changed between, or during, the calculations of its two results.
MOVED = "The model changed while the results were computed. Calculate again to split it."
#: What a pair says when the workspace was switched before it was split.
SWITCHED = "The workspace was switched while the results were computed. Calculate again to split it."
#: Runs kept at once, and how long one is kept after its last request (seconds).
MAX_RUNS = 2
MAX_AGE = 600.0

#: The clock runs are kept by (a test sets its own).
_clock = time.monotonic
_lock = threading.Lock()
_runs: OrderedDict[str, _Run] = OrderedDict()


@dataclass
class _Run:
    key: str
    project: str
    subjects: list[dict]
    methods: list[tuple]
    plan: list[difference_plan.Entry]
    #: When a request of the run last began or ended: a run expires MAX_AGE after it, unless a request is in flight.
    touched: float
    #: The model generation the plan was made under: its pairing of a copy onto its original holds for that model.
    generation: int = 0
    #: subject index → (its side, the model generation it was read under)
    sides: dict[int, tuple[terms.Side, int]] = field(default_factory=dict)
    #: subject index → why its side could not be read
    failed: dict[int, str] = field(default_factory=dict)
    split: set[int] = field(default_factory=set)
    #: Requests of the run begun and not yet ended (``Joined.close``): one that computes longer than MAX_AGE must not
    #: find the run expired by the next run's request, with the sides its later subjects need. MAX_RUNS bounds them
    #: all the same.
    active: int = 0

    def pairs(self) -> list[tuple[int, int]]:
        return [(i, e.reference) for i, e in enumerate(self.plan) if e.reference is not None]

    def references(self) -> set[int]:
        return {ref for _sub, ref in self.pairs()}


class Reading:
    """One subject's side, read from :func:`lca.compute_lcia`'s ``observe`` hook. A read that fails is noted, never
    raised: the split may fail, the scores must not."""

    def __init__(self, reference: bool) -> None:
        self._recorder = terms.Recorder(reference=reference)
        self.error: str | None = None
        #: The model generation the side is read under: a split of two sides read under different ones would
        #: split the difference between two models, not between two variants of one. Taken before the solve, and
        #: checked at every read: model edits do not wait for the calculation lock, so one can land while the
        #: matrices are built, and a generation taken only afterwards would stamp the old matrices with the new one.
        self.generation = lca.model_generation()

    def __call__(self, system, method) -> None:
        if self.error is not None:
            return
        if lca.model_generation() != self.generation:
            self.error = MOVED
            return
        try:
            self._recorder(system, method)
        except Exception as exc:  # noqa: BLE001 - a side that cannot be read is one split fewer
            _log.swallowed(exc, "difference run: read side")
            self.error = exc.message if isinstance(exc, PrismError) else UNREADABLE

    @property
    def side(self) -> terms.Side | None:
        return None if self.error is not None else self._recorder.side


def begin(token: str, subjects: list[dict], methods: list, *, here: list[dict], at: int = 0) -> _Run:
    """The run under ``token``, planned on its first request. A request that compares something else under the same
    token starts it over. ``here`` are the subjects this request computes, standing at ``at`` among ``subjects``."""
    from prism_lca.engine.bootstrap import get_bd

    refs = [_ref(s) for s in subjects]
    if at < 0 or refs[at:at + len(here)] != [_ref(s) for s in here]:
        raise PrismError(
            "The subjects of this request are not the ones of the run at that place.",
            code="invalid_request",
            hint='"difference.of" lists every subject of the run; "at" is where this request\'s first one stands.',
        )
    key = json.dumps([refs, [list(m) for m in methods]], sort_keys=True)
    project = str(get_bd().projects.current)
    now = _clock()
    with _lock:
        for old in [t for t, r in _runs.items() if now - r.touched > MAX_AGE and not r.active]:
            del _runs[old]
        run = _runs.get(token)
        if run is not None and run.key == key and run.project == project:
            run.touched = now
            run.active += 1
            _runs.move_to_end(token)
            return run
    resolved = [method_lookup.resolve_method(m) for m in methods]
    generation = lca.model_generation()  # before the plan reads the model, as a side's is taken before its solve
    try:
        entries = difference_plan.plan(refs)
    except Exception as exc:  # noqa: BLE001 - a plan that fails splits nothing; the comparison stands
        _log.swallowed(exc, "difference run: plan")
        entries = [difference_plan.Entry(reason=difference_plan.INDEPENDENT) for _ in subjects]
    run = _Run(key=key, project=project, subjects=refs, methods=resolved, plan=entries, touched=now,
               generation=generation, active=1)
    with _lock:
        _runs[token] = run
        _runs.move_to_end(token)
        while len(_runs) > MAX_RUNS:
            _runs.popitem(last=False)
    return run


class Joined:
    """One request's part of a run: the subjects it computes, standing at ``at`` among the run's."""

    def __init__(self, run: _Run, at: int) -> None:
        self.run = run
        self.at = at
        self.read: dict[int, Reading] = {}
        self._closed = False

    def reading(self, k: int) -> Reading | None:
        """What reads this request's ``k``-th subject's side while it is scored — None when no pair needs it."""
        index = self.at + k
        if index in self.run.references():
            self.read[index] = Reading(reference=True)
        elif any(sub == index for sub, _ref in self.run.pairs()):
            self.read[index] = Reading(reference=False)
        return self.read.get(index)

    def offer(self, should_cancel=None) -> dict:
        return offer(self.run, self.read, should_cancel=should_cancel)

    def close(self) -> None:
        """Give the run back, however the request ended: it may expire again from now. Once per request."""
        if self._closed:
            return
        self._closed = True
        with _lock:
            self.run.active = max(0, self.run.active - 1)
            self.run.touched = _clock()


def join(difference: dict, methods: list, *, here: list[dict]) -> Joined:
    """A request's part of the run ``difference`` (``{run, of, at}``) names."""
    at = int(difference.get("at", 0))
    return Joined(begin(str(difference["run"]), difference["of"], methods, here=here, at=at), at)


def held(reading: Reading | None):
    """The LCA lock while a side is read across a subject's methods; nothing to hold otherwise."""
    return lca._LCA_LOCK if reading is not None else contextlib.nullcontext()


def offer(run: _Run, read: dict[int, Reading], should_cancel=None) -> dict:
    """Keep the sides just read and split every pair whose two sides are now in. The answer is the run's plan and
    the pairs split in this request: ``{"plan": [...], "splits": [{subject, reference, indicators | error, …}]}``."""
    from prism_lca.engine.bootstrap import get_bd

    for index, r in read.items():
        if r.side is not None:
            run.sides[index] = (r.side, r.generation)
        else:
            run.failed[index] = r.error or UNREADABLE
    splits: list[dict] = []
    names = difference._Names(get_bd())
    with lca._LCA_LOCK:  # the names come from the workspace the sides were read in, which a switch waits for
        # A switch that came in after the last solve: the sides' node ids would be named from another workspace.
        switched = str(get_bd().projects.current) != run.project
        for sub, ref in run.pairs():
            if sub in run.split:
                continue
            if switched:
                splits.append(_failed(sub, ref, SWITCHED))
                run.split.add(sub)
                continue
            if sub in run.failed or ref in run.failed:
                splits.append(_failed(sub, ref, run.failed.get(sub) or run.failed[ref]))
                run.split.add(sub)
                continue
            if sub not in run.sides or ref not in run.sides:
                continue
            if should_cancel and should_cancel():
                raise lca.CalcCancelled()
            splits.append(_split(run, sub, ref, names, should_cancel))
            run.split.add(sub)
    # A side is kept only while a pair still waits for it.
    waiting = {i for sub, ref in run.pairs() if sub not in run.split for i in (sub, ref)}
    for index in [i for i in run.sides if i not in waiting]:
        del run.sides[index]
    return {"plan": [e.answer() for e in run.plan], "splits": splits}


def _split(run: _Run, sub: int, ref: int, names, should_cancel) -> dict:
    side, read_at = run.sides[sub]
    ref_side, ref_read_at = run.sides[ref]
    if not run.generation == read_at == ref_read_at == lca.model_generation():
        return _failed(sub, ref, MOVED)
    entry = run.plan[sub]
    try:
        out = {"subject": sub, "reference": ref}
        if entry.pairing is not None:
            out["pairing"] = entry.pairing.summary()
        out.update(difference.split_sides(ref_side, side, entry.pairing, run.methods, names=names, top_n=TOP_N,
                                          subject_db=run.subjects[sub]["database"], should_cancel=should_cancel))
        # The changes are named from the model as it is while they are listed, and edits do not wait for the lock.
        if lca.model_generation() != read_at:
            return _failed(sub, ref, MOVED)
        return out
    except lca.CalcCancelled:
        raise
    except Exception as exc:  # noqa: BLE001 - one pair that cannot be split says why; the scores stand
        _log.swallowed(exc, "difference run: split")
        return _failed(sub, ref, exc.message if isinstance(exc, PrismError) else "This difference could not be split.")


def _failed(sub: int, ref: int, message: str) -> dict:
    return {"subject": sub, "reference": ref, "error": message}


def _ref(s: dict) -> dict:
    out = {"database": s["database"], "code": s["code"]}
    if s.get("scenario"):
        out["scenario"] = s["scenario"]
    if s.get("amount", 1.0) != 1.0:
        out["amount"] = float(s["amount"])
    return out


def drop_all() -> None:
    """Let every run go — the page's Cancel: nothing will ask for their pairs any more."""
    with _lock:
        _runs.clear()
