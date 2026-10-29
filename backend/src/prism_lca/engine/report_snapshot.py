"""The report pipeline's caches: snapshots, render-input memo, preview documents, render tokens.

Moved out of the HTTP router. Five module-global caches and three locks lived in
`api/v1/report.py`, which meant that invalidating them required importing a *router* —
`app.py` and `api/v1/params.py` both did. This module owns the state; `report_pipeline` (the
builders) and the routers call in through functions. `invalidate()` is the one public switch.

--- one data snapshot per model state ---------------------------------------------------------
Writing a single chapter asked the backend three times for the same numbers: once for the brief,
once for the writer's own gate check, once for the check that stores it. Each of those ran a full
LCA per variant, the contribution breakdown, the hotspot walk and the Typst blocks. Over eight
chapters in four lanes that is twenty-four identical computations, and every staleness pass adds
another — on an ecoinvent background, the dominant non-model cost of writing a report.

So the endpoints that only *judge or write text* share one snapshot.

The key is what the data is made of, deliberately not the whole report: storing a chapter's text
must not throw the snapshot away, or a four-lane "write all" would invalidate it for the other
three lanes on every save — which is the entire run. Everything that can move a number is in the
key instead:

  * `lca.model_generation()` — every model, parameter, method and import edit in the app bumps it
    (but a reversible scenario window does not — keying on the raw cache generation made every
    scenario-bearing snapshot invalidate itself while being built, V131),
    the same counter the factorisation cache keys on. An edit anywhere drops this cache too.
  * the study metadata and the scenario overrides, hashed directly: a changed override changes the
    result at compute time without touching the technosphere, so no generation moves for it.
  * the report's own data-bearing fields — subjects, methods, amount, aggregation, language — and
    the request's overrides of them.

The TTL is a backstop for anything not enumerated above, not the mechanism, and it **slides**: it is
refreshed on every hit, so it measures idleness rather than age. Measured from the build it expired
mid-run — a "write all" over eight chapters takes minutes, so a fixed minute meant rebuilding the
same snapshot roughly once a minute for the length of the run. Correctness does not rest on it; it
rests on the key. By design, checking a chapter against a snapshot is fine, and
editing the model while a rewrite runs is a mistake no cache should be designed around.

The document endpoints (pdf, preview, sources, bundle, data, abbreviations) do not read THIS
cache — but they memoise their expensive INPUTS under the same key (see
`_INPUTS_MEMO`). That is not the freshness trade-off the rule above forbids: the key
proves the numbers could not differ (same model generation, same data-bearing fields), so the
reuse is memoisation, not staleness — and the "generated" stamp is still the moment of THIS
render. What changed the decision: switching a palette or a theme re-paid a full study for a
document whose every number was provably identical (V136).
"""

from __future__ import annotations

import threading
import time
import uuid
from collections import OrderedDict

from prism_lca.engine import lca

#: The last few typeset documents, keyed by report. A preview page turn used to re-run the entire
#: pipeline — every subject's LCA, the contribution tree, the linter, the source build — twice per click
#: (once for the charts, once for the page), which measured 14 s per page on a three-variant report. The
#: pages themselves were already cached one layer down; this is what stood in front of that cache.
_PREVIEW_DOCS: OrderedDict[str, tuple[dict[str, str | bytes], list[str], list[str]]] = OrderedDict()
_PREVIEW_DOCS_MAX = 3

#: Inputs from the render that produced the charts, handed on to the render that typesets them.
#:
#: Drawing a figure needs the numbers, and typesetting needs the figure, so a fresh preview is inherently
#: two round trips — and it used to compute the whole study in each. The token is the client's proof that
#: both halves belong to one interaction: `/sources` computes and mints it, `/preview` (or `/pdf`) spends
#: it. No timeout and no hidden staleness, because a token cannot outlive the click that made it — the
#: next fresh render mints a new one and this one falls out of the map.
_RENDER_INPUTS: OrderedDict[str, tuple[str, dict, dict, int]] = OrderedDict()
_RENDER_INPUTS_MAX = 3

#: Both caches are plain module state mutated from uvicorn's threadpool; the UI does fire `/sources`
#: and `/preview` together, so eviction can race eviction without this.
_CACHES_LOCK = threading.Lock()

#: Only the *data* is cached. The report definition is re-read every time and never comes out of
#: here: storing a chapter changes it while leaving the numbers alone, so a cached definition would
#: hand the next caller a report without the chapter that was just written.
# 10 minutes, not one: correctness rests on the key (see the module docstring), so the TTL only
# decides how long an idle snapshot occupies memory. At 60 s the pause between two checking actions —
# reading a chapter, then pressing "Write all" — routinely crossed the line and re-paid the ~96 s
# build for numbers that had not moved (V120). It still slides on every hit.
SNAPSHOT_TTL = 600.0
_SNAPSHOT_MAX = 4
_snapshots: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
_snapshot_lock = threading.Lock()
#: Held while a snapshot is *built*, so four lanes arriving at a cold cache compute it once rather
#: than four times. One lock rather than one per key: the computations serialise on the LCA lock
#: anyway, so nothing is lost by making them queue here instead.
snapshot_build_lock = threading.Lock()

#: `(project, database, report_id)` of every study this process has computed, most recent last —
#: deliberately NOT the snapshot keys, which carry the model generation. What a warm-up has to know is
#: which reports to rebuild *after* the generation moved, and that is also the answer to "whose study
#: may we spend a minute on unasked": a project holds dozens of reports, and the ones somebody is
#: working on are the ones somebody has already asked about. See `report_pipeline.warm_snapshots`.
_warm_targets: OrderedDict[tuple[str, str, str], None] = OrderedDict()
_WARM_TARGETS_MAX = 8

#: The document endpoints' half of the saving: the last computed render INPUTS (every subject's
#: LCIA, the contribution trees, the inventory — everything `render_inputs` gathers), keyed like
#: the snapshot above. On a hit, `render_inputs` refreshes what is cheap or definition-side —
#: the template, the identity, the request's figures, the provenance stamp, the research/review
#: logs — and reuses the expensive rest, because the key proves it could not have changed.
_INPUTS_MEMO: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
_INPUTS_MEMO_MAX = 2
inputs_lock = threading.Lock()
#: Held while inputs are BUILT — page-open staleness and a quick Preview used to compute the
#: same study twice in parallel; the second caller now waits and is served from the memo.
inputs_build_lock = threading.Lock()

#: Where the study being built stands — `None` while none is. The freshness check on a five-variant,
#: sixteen-indicator comparison waited almost five minutes behind a spinner and a seconds counter, and
#: nothing on the page could say whether it was moving or stuck (seen while recording a product video).
#: Builds serialise on `inputs_build_lock`, so there is one writer at a time and one record
#: is enough; it is replaced whole, never mutated, so the poll reads it without a lock — a poll that
#: queued behind the build it reports on would be no poll at all.
_build_progress: dict | None = None


class BuildProgress:
    """The counter one `_compute_render_inputs` run keeps: planned units of work and finished ones.

    A unit is one solve the build will do — a variant's LCIA, one breakdown, the tree, the inventory.
    They are not equal in cost (the first in each scenario window also pays the factorisation), but
    they are the build's own count of what is left, which a clock is not.
    """

    def __init__(self, database: str, report_id: str) -> None:
        self._base = {"database": database, "report_id": report_id}
        self._started = time.monotonic()
        self._done = 0
        self._total = 0
        self._publish()

    def _publish(self) -> None:
        global _build_progress
        _build_progress = {
            **self._base,
            "done": self._done,
            "total": max(self._total, self._done),
            "started": self._started,
        }

    def plan(self, total: int) -> None:
        self._total = total
        self._publish()

    def step(self, units: int = 1) -> None:
        self._done += units
        self._publish()

    def close(self) -> None:
        global _build_progress
        if _build_progress is not None and _build_progress.get("started") == self._started:
            _build_progress = None


def build_progress(database: str, report_id: str) -> dict | None:
    """This report's running build as `{done, total, elapsed}`, or `None` when none is running for it."""
    current = _build_progress
    if current is None or current["database"] != database or current["report_id"] != report_id:
        return None
    return {
        "done": current["done"],
        "total": current["total"],
        "elapsed": round(time.monotonic() - current["started"], 1),
    }


def preview_key(database: str, report_id: str) -> str:
    """The key render tokens and preview documents are filed under — workspace included.

    Two workspaces may hold a model of the same name, and the short report's id is always `short`:
    a token minted in A was taken as fresh in B and typeset A's product and score into B's PDF (3
    instead of 9). The model generation does not move on a switch, so the workspace has to be part of
    the identity. NUL separates, since names may hold anything.
    """
    project = str(getattr(lca.get_bd().projects, "current", ""))
    return f"{project}\0{database}/{report_id}"


def preview_get(key: str) -> tuple[dict[str, str | bytes], list[str], list[str]] | None:
    with _CACHES_LOCK:
        cached = _PREVIEW_DOCS.get(key)
        if cached is not None:
            _PREVIEW_DOCS.move_to_end(key)
    return cached


def _still_current(key: str) -> bool:
    """Whether the workspace a key was taken in is still the active one. A caller takes the key BEFORE
    computing; a switch during the computation must not file the result under either workspace's key (A's
    inputs once ended up under B's key when the key was taken afterwards)."""
    return key.split("\0", 1)[0] == str(getattr(lca.get_bd().projects, "current", ""))


def preview_put(key: str, entry: tuple[dict[str, str | bytes], list[str], list[str]]) -> None:
    if not _still_current(key):
        return
    with _CACHES_LOCK:
        _PREVIEW_DOCS[key] = entry
        while len(_PREVIEW_DOCS) > _PREVIEW_DOCS_MAX:
            _PREVIEW_DOCS.popitem(last=False)


def new_render_token(key: str, report: dict, inputs: dict) -> str:
    """A token for these inputs — or "" when the workspace moved while they were computed: an empty
    token is never spendable, so the second half computes afresh where it is asked."""
    if not _still_current(key):
        return ""
    token = uuid.uuid4().hex
    with _CACHES_LOCK:
        # The generation pins the token to the model state it was computed for: without it a token
        # held across a model edit let /pdf or /preview typeset pre-edit numbers with no staleness
        # signal — "a token cannot outlive the click that made it" was only true while nothing changed.
        _RENDER_INPUTS[token] = (key, report, inputs, lca.model_generation())
        while len(_RENDER_INPUTS) > _RENDER_INPUTS_MAX:
            _RENDER_INPUTS.popitem(last=False)
    return token


def render_token_state(key: str, token: str | None) -> str:
    """``fresh`` (spendable), ``stale`` (minted for this report, but the model moved since) or
    ``unknown`` (never minted, or already pushed out of the small cache). Only the middle one says the
    caller's figures are wrong; the last says nothing either way."""
    with _CACHES_LOCK:
        entry = _RENDER_INPUTS.get(token or "")
    if entry is None or entry[0] != key:
        return "unknown"
    return "stale" if entry[3] != lca.model_generation() else "fresh"


def spend_render_token(key: str, token: str | None, figures: dict | None, references: list | None):
    """The inputs a token stands for, with this request's figures merged in — or None if unknown.

    The figures are the one part that legitimately differs between the two halves: the first render did
    not have them yet, because they are drawn from what it returned. The token is only honoured for the
    report it was minted for — spending it on another report's URL would typeset the wrong document and
    poison that report's preview cache.
    """
    with _CACHES_LOCK:
        entry = _RENDER_INPUTS.get(token or "")
    if entry is None or entry[0] != key:
        return None
    _, report, inputs, generation = entry
    if generation != lca.model_generation():
        return None  # the model moved since the mint — recompute rather than typeset stale numbers
    inputs = dict(inputs)
    inputs["figures"] = figures or {}
    inputs["method_references"] = references or []
    return report, inputs


def remember_target(project: str, database: str, report_id: str) -> None:
    """Note that somebody asked for this report's numbers. See `_warm_targets`."""
    target = (project, database, report_id)
    with _snapshot_lock:
        _warm_targets[target] = None
        _warm_targets.move_to_end(target)
        while len(_warm_targets) > _WARM_TARGETS_MAX:
            _warm_targets.popitem(last=False)


def warm_targets_for(project: str, database: str) -> list[str]:
    with _snapshot_lock:
        return [rid for (proj, db, rid) in _warm_targets if proj == project and db == database]


def snapshot_get(key: tuple) -> dict | None:
    with _snapshot_lock:
        hit = _snapshots.get(key)
        if hit is None or time.monotonic() - hit[0] >= SNAPSHOT_TTL:
            return None
        # Re-stamped, not just moved: the window measures how long nobody has asked, not how old the
        # answer is. A run that keeps asking keeps its snapshot; one that stops loses it after a minute.
        _snapshots[key] = (time.monotonic(), hit[1])
        _snapshots.move_to_end(key)
        return hit[1]


def snapshot_put(key: tuple, data: dict) -> None:
    with _snapshot_lock:
        # Everything from a superseded model generation goes now. `snapshot_key` puts
        # `lca.model_generation()` last, and that counter is process-wide and only ever moves
        # forward — so an entry whose key ends in another number cannot be reached by any caller
        # again, whatever project or report it was built for. Not a correctness fix (the key
        # already made them unreachable) but a capacity one: the cache is four slots, and the
        # size limit below would otherwise spend them evicting live snapshots to make room
        # beside dead ones. The TTL used to be the only thing that collected them, ten minutes
        # after the last hit.
        for dead in [k for k in _snapshots if k[-1] != key[-1]]:
            del _snapshots[dead]
        _snapshots[key] = (time.monotonic(), data)
        _snapshots.move_to_end(key)
        while len(_snapshots) > _SNAPSHOT_MAX:
            _snapshots.popitem(last=False)


def memo_get(key: tuple) -> dict | None:
    """The raw inputs-memo hit (the caller refreshes the definition-side pieces). Slides the TTL."""
    with inputs_lock:
        hit = _INPUTS_MEMO.get(key)
        if hit is None or time.monotonic() - hit[0] >= SNAPSHOT_TTL:
            return None
        _INPUTS_MEMO[key] = (time.monotonic(), hit[1])  # sliding: measures idleness
        _INPUTS_MEMO.move_to_end(key)
        return dict(hit[1])


def memo_put(key: tuple, kept: dict) -> None:
    with inputs_lock:
        _INPUTS_MEMO[key] = (time.monotonic(), kept)
        _INPUTS_MEMO.move_to_end(key)
        while len(_INPUTS_MEMO) > _INPUTS_MEMO_MAX:
            _INPUTS_MEMO.popitem(last=False)


def snapshot_key(database: str, report_id: str, report: dict, body) -> tuple:
    """The fingerprint of everything that can move a number — see the module docstring."""
    import hashlib
    import json

    from prism_lca.engine.scenarios import ScenarioStore
    from prism_lca.engine.study import StudyMetaStore

    sections = report.get("sections") or []
    payload = json.dumps(
        [
            report.get("methods"),
            report.get("subjects"),
            report.get("amount"),
            report.get("aggregate_by"),
            report.get("lang"),
            # NOT the template and NOT the palette: no number depends on how the document is dressed.
            # Keying on the template made every theme switch a full recompute (V136).
            # NOT the translations either (V433): the snapshot is built untranslated and the
            # stored map is laid over a copy per request (`report_pipeline.analysis_snapshot`). Keying
            # on it made the translation step before Write all a second two-minute build — the check
            # had just paid for the same numbers.
            # Which *kinds* of chapter exist decides what is gathered (prose wants the tree, an
            # appendix wants the inventory) — the texts themselves do not enter the data at all.
            sorted({str(s.get("kind", "")) for s in sections}),
            [s.get("inventory_rows") for s in sections if s.get("kind") == "appendix"],
            # Which indicators the contribution chapters leave out: it decides which breakdowns are
            # *computed*, so a snapshot built before one was switched back on does not answer for it.
            [sorted(s.get("hidden_indicators") or []) for s in sections if s.get("kind") == "contribution"],
            # A contribution chapter's own dimension decides which breakdowns are computed, and the
            # system-model options decide which datasets the figure data folds.
            [s.get("aggregate_by") or "" for s in sections if s.get("kind") == "contribution"],
            [
                (s.get("per_process"), s.get("background_tier", True))
                for s in sections
                if s.get("kind") == "system_model"
            ],
            body.code,
            body.methods,
            body.amount,
            body.aggregate_by,
            StudyMetaStore().snapshot(database),
            ScenarioStore().list_all(database),
        ],
        sort_keys=True,
        default=str,
    )
    # The project belongs in the key for the same reason it does in the factorisation cache next door:
    # database names collide across projects — both can hold a "biosphere3" and the same ecoinvent —
    # and a snapshot from the other project would be numerically plausible and wrong.
    project = str(getattr(lca.get_bd().projects, "current", ""))
    return (
        project,
        database,
        report_id,
        hashlib.sha256(payload.encode()).hexdigest(),
        lca.model_generation(),
    )


def snapshot_id(key: tuple) -> str:
    """A short, opaque name for one snapshot key — what a brief hands out and a proposal hands back.

    Brief, proposal and patch used to be bound to nothing: the writer took its numbers at one moment,
    the gate bound the placeholders against the numbers of a later one, and a recalculation in between
    put another dataset at rank 1 under the text the model had written. The key already
    fingerprints everything that can move a number; this is only its spelling on the wire.
    """
    import hashlib
    import json

    return hashlib.sha1(json.dumps(list(key), default=str).encode()).hexdigest()[:12]


def invalidate() -> None:
    """Forget every snapshot AND the inputs memo — and who they were for. For tests, for the
    scenario-window recovery at startup, and for anything that has to be certain it recomputed."""
    with _snapshot_lock:
        _snapshots.clear()
        _warm_targets.clear()
    with inputs_lock:
        _INPUTS_MEMO.clear()


#: The name the routers and `app.py` used while this lived in the router — kept callable so the
#: intent reads the same at older call sites and in muscle memory.
clear_snapshot_cache = invalidate
