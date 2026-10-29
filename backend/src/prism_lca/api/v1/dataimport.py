"""Import foreign LCI data — the endpoints the wizard drives.

The shape mirrors the wizard's five steps, and the split is deliberate: **only ``/commit`` writes.**
Everything before it can be abandoned by closing the window, which is what makes a review step a
review rather than a confirmation dialog.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from prism_lca import _log
from prism_lca.api.v1.deps import require_token
from prism_lca.engine import lca, library
from prism_lca.engine.dataimport import session
from prism_lca.engine.dataimport.detect import FORMAT_LABELS, detect
from prism_lca.engine.dataimport.session import Unmatched
from prism_lca.errors import PrismError

router = APIRouter(prefix="/import", tags=["import"], dependencies=[Depends(require_token)])


class DetectRequest(BaseModel):
    path: str = Field(min_length=1)


class StartRequest(BaseModel):
    path: str = Field(min_length=1)
    #: Which background database technosphere links are searched in. Empty = let the server pick the
    #: obvious one (see :func:`_default_background`), because the caller knowing which inventory is
    #: indexed is exactly the kind of thing a caller gets wrong.
    background: str = ""


class Assumption(BaseModel):
    quantity: float
    what: str = Field(min_length=1, max_length=200)


class Decision(BaseModel):
    dataset: str
    #: The dataset's own key, preferred over the name when sent — two datasets can share a name.
    #: Optional so an older client keeps working by name.
    dataset_key: str | None = None
    index: int
    #: Where the chosen target lives. Only needed for something found by hand rather than picked
    #: off the shortlist — the shortlist knows its own databases.
    database: str | None = None
    #: Empty or missing clears the match. Saying "not this" must be as cheap as saying "this one".
    code: str | None = None
    confidence: str | None = None
    evidence: str | None = None
    #: True when this decision IS the reviewer's region choice for an already-matched process —
    #: it clears the "Select region…" state that blocks the commit (see session._region_still_open).
    region_chosen: bool = False
    #: The substance property that bridges two quantities — a density, a calorific value — for a
    #: target whose unit measures something else than the source's. ``quantity`` is how much of the
    #: target unit one source unit is; ``what`` names it, because a factor whose origin is not on
    #: screen cannot be told apart from one somebody invented. Always lands in the lowest band.
    assumption: Assumption | None = None
    #: The reviewer confirms that the chosen supplier — which makes this product only as a
    #: co-product (``allocation_required`` on the candidate) — has been allocated or is meant anyway.
    allocation_confirmed: bool = False


class DecideRequest(BaseModel):
    decisions: list[Decision]


class CommitRequest(BaseModel):
    #: Names the *import*, not a database — everything lands in the project's library either way.
    #: Empty is allowed: the source's own file name is a better default than a forced invention.
    label: str = Field(default="", max_length=120)
    unmatched: Unmatched = Unmatched.park


class OptionsRequest(BaseModel):
    #: Book the products a process gives off besides its reference as ``substitution`` — an avoided
    #: burden (system expansion) — instead of leaving them unbooked. Changes results, so it is a
    #: choice the reviewer makes in the wizard, never a default. ``None`` leaves it as it is.
    coproducts_as_substitution: bool | None = None


def _with_searched_as(result: dict) -> list[dict[str, Any]]:
    """The hits of a search, each carrying what was searched besides the name as written — a source
    dataset called "PET resin" is also searched as "polyethylene terephthalate resin", and a reviewer
    choosing among the candidates should be able to see why one turned up."""
    hits = list(result.get("results") or result.get("hits") or [])
    searched_as = (result.get("searched_as") or {}).get("query")
    if searched_as:
        hits = [{**h, "searched_as": searched_as} for h in hits]
    return hits


def _existing(path: str) -> Path:
    target = Path(path).expanduser()
    if not target.exists():
        raise PrismError(f"There is nothing at {target}.", code="import_not_found")
    return target


@router.post("/detect", summary="What format is this file, folder or zip?")
def detect_source(body: DetectRequest) -> dict[str, Any]:
    found = detect(_existing(body.path))
    return {
        "format": found.format.value,
        "label": FORMAT_LABELS[found.format],
        "evidence": found.evidence,
        "files": len(found.files),
    }


def _searchable_databases(request: Request) -> list[str]:
    """Where a process may come from: the background inventories and the project's library — the
    same set the search panel offers as checkboxes."""
    return [
        d.name
        for d in request.app.state.repository.list_databases()
        if d.kind in ("background", "library")
    ]


def _default_background(request: Request) -> tuple[str, str]:
    """The inventory a process link is searched in, and a note if none can serve.

    Picked here rather than asked of the caller: an import links its technosphere inputs against
    whatever this project's background is, and there is only ever one obvious answer — the largest
    indexed one. Without an index there are no candidates at all, so that case has to be *said*,
    not silently turned into 300 unmatched rows.
    """
    databases = request.app.state.repository.list_databases()
    inventories = sorted(
        (d for d in databases if d.kind == "background"), key=lambda d: -d.node_count
    )
    if not inventories:
        return "", "This workspace has no background inventory, so process inputs cannot be linked."
    for inventory in inventories:
        if request.app.state.search.index_info(inventory.name).get("indexed"):
            return inventory.name, ""
    return "", (
        f"“{inventories[0].name}” has no search index yet, so process inputs cannot be linked. "
        f"Build it in the search panel (Index), then import again."
    )


@router.post("/start", summary="Read a source and run the deterministic matching pass")
def start(request: Request, body: StartRequest) -> dict[str, Any]:
    background = body.background.strip()
    note = ""
    if not background:
        background, note = _default_background(request)

    def search(query: str, database: str, limit: int) -> list[dict[str, Any]]:
        """The project's own semantic index — the same one the process search uses.

        Passed in rather than imported by the matcher so the import can never quietly build a
        second index, and so a search failure degrades to "no candidates" instead of taking the
        whole read down.
        """
        try:
            # Every region of a hit (`variants_cap=0`), like the search panel: the matcher puts the
            # source's own region first, and a region outside the assistant's twelve-variant cap was
            # neither preferred nor offered although it existed.
            result = request.app.state.search.search(query, database, limit=limit, variants_cap=0)
        except Exception:  # noqa: BLE001 — no candidates is a valid answer; a crash is not
            return []
        return _with_searched_as(result)

    try:
        result = session.start(
            _existing(body.path), search=search if background else None, background=background
        )
    except session.ImportStopped:
        # Not an error and not a half-import: the pass gave up before a session existed, so the
        # wizard is back where it was standing. `active: false` is what says so — the caller merges
        # this over its own optimistic `active: true`.
        return {"active": False, "stopped": True}
    if note:
        result.setdefault("notes", []).append(note)
    return result


@router.get("/progress", summary="Where a running deterministic pass stands")
def progress() -> dict[str, Any]:
    """Polled by the wizard while ``/start`` is in flight — the read takes minutes on a big
    package, and a sentence that stands still for minutes is indistinguishable from a hang.
    Deliberately lock-free (see session._reading): the poll must not queue behind the work.
    """
    return {"reading": session.reading_progress()}


@router.post("/stop", summary="Give up on a running read")
def stop_reading() -> dict[str, Any]:
    """The counterpart to ``/start`` while it is still in flight.

    Separate from ``/cancel``, which throws away a *finished* read that is under review. This one
    is the way out of a wrong file: a 3000-dataset package matches for minutes, and until now the
    only way to stop it was to close the window and leave the work running behind it.
    """
    session.stop_reading()
    return {"stopping": True}


@router.get("/state", summary="How the current import stands")
def state() -> dict[str, Any]:
    return session.state()


@router.post("/options", summary="Change how the current import will be written")
def options(body: OptionsRequest) -> dict[str, Any]:
    """Write-through from the wizard: a switch applies when it is flipped, and the answer is the new
    state. Read by ``/commit`` — there is nothing to send along with it."""
    return session.set_options(coproducts_as_substitution=body.coproducts_as_substitution)


@router.get("/rows", summary="The review table, filterable by confidence")
def rows(confidence: str | None = None, only_open: bool = False) -> dict[str, Any]:
    return {"rows": session.rows(confidence=confidence, only_open=only_open)}


@router.get("/candidates", summary="Look a flow or a process up by hand, beyond the shortlist")
def candidates(request: Request, q: str, kind: str = "biosphere", limit: int = 40) -> dict[str, Any]:
    """What the reviewer can choose from when the shortlist is wrong.

    Flows come from the import's own biosphere index — across ALL compartments, because a reviewer
    may be correcting the compartment itself. Processes come from the project's semantic search over
    the background and the library, which is where a process could legitimately come from.
    """
    if kind == "biosphere":
        return {"candidates": session.candidates(q, kind, limit=max(1, min(limit, 100)))}

    def search(query: str, database: str, hits: int) -> list[dict[str, Any]]:
        try:
            result = request.app.state.search.search(query, database, limit=hits)
        except Exception:  # noqa: BLE001 — no candidates is a valid answer; a crash is not
            return []
        return _with_searched_as(result)

    libraries = {
        d.name for d in request.app.state.repository.list_databases() if d.kind == "library"
    }
    per_database: list[list[dict[str, Any]]] = []
    for database in _searchable_databases(request):
        hits = session.candidates(
            q, kind, search=search, background=database, limit=max(1, min(limit, 100))
        )
        if database in libraries:
            # Said on the hit, because the reviewer must see it: the user's own datasets answer to
            # the same names as ecoinvent's, and picking one is a deliberate act, not a default.
            for hit in hits:
                hit["library"] = True
        per_database.append(hits)
    # Interleaved, and the limit counts PER DATABASE — the same decision the model search made.
    # Stacked-then-sliced lost the library entirely (it always came second); interleaved-then-sliced
    # would displace ecoinvent's tail instead. Neither list may cost the other its hits: the result
    # just gets longer, and the rank-by-rank weave keeps both fronts at the front
    # (no ecoinvent hit may be lost behind My processes).
    found: list[dict[str, Any]] = []
    for rank in range(max((len(hits) for hits in per_database), default=0)):
        for hits in per_database:
            if rank < len(hits):
                found.append(hits[rank])
    return {"candidates": found}


@router.post("/decide", summary="Apply review decisions (from a person or from the matching model)")
def decide(body: DecideRequest) -> dict[str, Any]:
    refused: list[dict[str, Any]] = []
    applied = session.decide([d.model_dump() for d in body.decisions], refused=refused)
    return {"applied": applied, "refused": refused}


@router.post("/commit", summary="Write the import into the project's library")
def commit(request: Request, body: CommitRequest) -> dict[str, Any]:
    result = session.commit(body.label.strip(), unmatched=body.unmatched)
    # A library write is a technosphere change like any other, only it does not go through the
    # command bus: a foreground model that draws on a replaced dataset would otherwise answer its
    # next calculation from the factorisation built before the import — the fast reuse path checks
    # generation, database names and demand ids, not the inventory behind them.
    lca.invalidate_lca_cache(model_change=True)
    # The datasets just imported are exactly the ones somebody will look for next, so the index is
    # carried along rather than left stale behind a button. Only the newcomers are embedded — a
    # rebuild would re-embed the whole library for someone else's delivery. If the library has no
    # index yet, this does nothing and the search panel offers the first build as it always has.
    codes = result.pop("codes", [])
    try:
        # Forget first: a re-import replaces a dataset under the same code, and an index row is not
        # updated by adding one with the same code — it would be skipped as "already known" and keep
        # describing the version that was just overwritten.
        request.app.state.search.forget(result["database"], codes)
        grown = request.app.state.search.extend(result["database"], codes)
        # Both numbers matter to the caller for different reasons: `added` is what happened, `exists`
        # is whether the datasets can be found at all — a library with no index yet swallows an import
        # silently, and the wizard has to say so rather than close on a job half done.
        result["index"] = {"added": grown["added"], "exists": grown["indexed"]}
    except Exception as exc:  # noqa: BLE001 - the datasets are in; only the index fell behind
        # By now the datasets are written and the session is gone, so an embedding provider that
        # fails here must not turn the whole request into a failed import — the wizard would show an
        # error over a job that is done, and a retry would only meet import_no_session. The answer
        # says what happened instead: in, but not searchable until the index is rebuilt.
        _log.swallowed(exc, "import_commit_index")
        result["index"] = {"added": 0, "exists": False, "error": str(exc)}
    return result


class DeleteRequest(BaseModel):
    batch: str = Field(min_length=1)
    #: Delete even though models draw on it. Their exchanges then point at nothing, so this is a
    #: decision the caller has to state rather than a flag the UI sets by default.
    force: bool = False


@router.get("/batches", summary="The imports the library holds")
def batches() -> dict[str, Any]:
    return {"batches": library.batches(), "own": library.own_datasets(), "library": library.LIBRARY_DB}


@router.post("/batches/delete", summary="Remove one import from the library again")
def delete_batch(request: Request, body: DeleteRequest) -> dict[str, Any]:
    """The counterpart to /commit — per import, not per database.

    The library is permanent, so "undo that import" cannot be "delete the database it landed in".
    What identifies an import is the batch id every one of its datasets carries.
    """
    result = library.delete_batch(body.batch.strip(), force=body.force)
    # Same as /commit: the library changed under whatever model draws on it.
    lca.invalidate_lca_cache(model_change=True)
    # The deleted datasets have to leave the index too — a hit that no longer resolves reads as
    # corruption. Only those, though: dropping the whole index would cost the user everything that
    # stayed, re-embedded from scratch, for somebody else's deletion.
    try:
        request.app.state.search.forget(library.LIBRARY_DB, result.pop("codes", []))
    except Exception as exc:  # noqa: BLE001 - the datasets are gone either way
        _log.swallowed(exc, "delete_batch_index")
        result["index_error"] = str(exc)
    return result


@router.post("/cancel", summary="Throw the current import away")
def cancel() -> dict[str, Any]:
    session.cancel()
    return {"active": False}
