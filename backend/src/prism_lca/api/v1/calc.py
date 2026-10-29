"""LCIA calculation endpoints."""
from __future__ import annotations

import threading

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from prism_lca.api.v1.deps import MethodRef, require_token
from prism_lca.engine import calc_jobs, lca, montecarlo, scenarios, sensitivity
from prism_lca.engine import compare as compare_engine
from prism_lca.engine.scenarios import ScenarioStore
from prism_lca.errors import PrismError

router = APIRouter(prefix="/calc", tags=["calc"], dependencies=[Depends(require_token)])

# Cooperative cancellation: a newer request for THE SAME thing (or an explicit /cancel from the UI's
# Cancel button) must abort the old one instead of leaving it grinding in the background and blocking
# the LCA lock. Each (channel, request) pair keeps a monotonically increasing "latest" generation; a
# running traversal bails (raises CalcCancelled) once its generation is no longer the latest.
#
# Per REQUEST, not per channel: with one generation per channel, "Write
# all"'s four parallel chapters cancelled each other's contribution lookups — the second lane's
# `explain_result` made the first lane's 409 (V285). The double click this exists for
# sends the same request twice, so the key is the request itself; two different chapters asking two
# different questions run side by side. The UI's Cancel button still cancels its whole channel.
_CHANNELS = ("contribution", "stacked", "compare", "contribution-matrix")
_gen_lock = threading.Lock()
_gen: dict[tuple[str, str], int] = {}


def _request_key(body) -> str:
    """The request as a string: identical requests share a generation, different ones do not."""
    import json

    return json.dumps(body.model_dump(), sort_keys=True, default=str)


def _next_gen(channel: str, key: str = "") -> int:
    with _gen_lock:
        _gen[(channel, key)] = _gen.get((channel, key), 0) + 1
        return _gen[(channel, key)]


def _cancel_channel(channel: str) -> None:
    """Bump every request on the channel — the UI's Cancel means "whatever is running here"."""
    with _gen_lock:
        for pair in [p for p in _gen if p[0] == channel]:
            _gen[pair] += 1


def _canceller(channel: str, mine: int, key: str = ""):
    return lambda: _gen.get((channel, key), 0) != mine


class LciaRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    methods: list[MethodRef] | None = None
    #: A whole family at once ("EF v3.1", "IPCC 2021") — standard variants only, capped at
    #: :data:`FAMILY_CAP`; mutually exclusive with method/methods in spirit, wins when given.
    method_family: str | None = None
    amount: float = 1.0
    #: Also say how much of the score the activity emits ITSELF versus what its inputs bring.
    direct_split: bool = False


#: How many indicators a whole-family request returns at most. EF 3.1 has 25 standard categories; the
#: cap is there so a family with "no LT" twins and endpoint variants does not hand back 60 rows.
FAMILY_CAP = 25


def _family_methods(family: str) -> tuple[list[list[str]], dict]:
    found = lca.methods_in_family(family)
    if not found:
        raise PrismError(
            f"No LCIA method family matches '{family}'.",
            code="method_not_found",
            hint="list_method_families shows the installed families; the match is by family name.",
        )
    shown = found[:FAMILY_CAP]
    note = {"family": family, "n_methods": len(found), "n_used": len(shown)}
    if len(found) > len(shown):
        note["note"] = f"The family has {len(found)} indicators; the first {len(shown)} were computed."
    return shown, note


class ContributionMatrixRequest(BaseModel):
    database: str
    code: str
    methods: list[MethodRef]
    amount: float = 1.0
    #: A process is included when its share reaches this in AT LEAST ONE indicator.
    cutoff: float = 0.01
    top_n: int = 40
    scenario: str | None = None


class ContributionRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    amount: float = 1.0
    cutoff: float = 0.005
    max_depth: int = 8
    aggregate_by: str | None = None  # "tag:<dimension>" | "geo"
    scenario: str | None = None  # apply this scenario's parameter overrides for the tree


class PhaseRef(BaseModel):
    """One tag value — the flows of that part of the result only."""

    dimension: str
    value: str


class ElementaryFlowsRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    amount: float = 1.0
    #: Only the flows that the breakdown by this tag value attributes to it (one life-cycle phase).
    phase: PhaseRef | None = None
    #: 0 or less returns every characterised flow instead of the largest ones — thousands, on an ecoinvent
    #: process, which is what an export wants and what a side panel does not.
    top_n: int = 20
    #: Per flow, the part the activity emits itself next to the whole-chain figure.
    direct_split: bool = False
    # True = amount is already a matrix demand (e.g. a contribution-tree node's `a`, sign
    # included) — skip the treatment-sign normalisation that plain product amounts get.
    raw_demand: bool = False
    scenario: str | None = None  # apply this scenario's parameter overrides


class CharacterizationFactorsRequest(BaseModel):
    methods: list[list[str]]
    #: Optional case-insensitive filter on flow name / compartment (the flow set is very large).
    flow_query: str | None = None
    #: Cap the returned rows (0 = unlimited). `total_flows` always reports the unfiltered match count.
    limit: int = 0


@router.get("/methods", summary="List available LCIA methods")
def methods(query: str | None = None, limit: int = 5000) -> list[dict]:
    # High default: the UI pickers need the COMPLETE catalog (ecoinvent ships 600+ methods);
    # the engine-level default of 100 would silently truncate the family list.
    return lca.list_methods(query, limit)


@router.post("/characterization-factors", summary="Characterisation factors of up to 4 indicators")
def characterization_factors(body: CharacterizationFactorsRequest) -> dict:
    return lca.characterization_factors(body.methods, body.flow_query, body.limit)


@router.post("/lcia", summary="Compute LCIA score(s)")
def lcia(body: LciaRequest) -> dict:
    if body.method_family:
        methods, note = _family_methods(body.method_family)
        out = lca.compute_multi(body.database, body.code, methods, body.amount, body.direct_split)
        out["family"] = note
        return out
    if body.methods:
        return lca.compute_multi(body.database, body.code, body.methods, body.amount, body.direct_split)
    return lca.compute_lcia(body.database, body.code, body.method, body.amount, body.direct_split)


def _methods_of(body: LciaRequest) -> tuple[list, dict | None]:
    if body.method_family:
        methods, note = _family_methods(body.method_family)
        return methods, note
    if body.methods:
        return list(body.methods), None
    if body.method is None:
        raise PrismError("Pass method, methods or method_family.", code="method_required")
    return [body.method], None


@router.post("/jobs", summary="Start an LCIA calculation as a background job")
def start_job(body: LciaRequest) -> dict:
    """The long form of ``/lcia`` for external clients with a per-call timeout (the MCP bridge):
    answers at once with a job id; ``GET /jobs/{id}`` polls, ``?result=true`` reads the scores,
    ``POST /jobs/{id}/cancel`` stops between methods."""
    methods, note = _methods_of(body)
    job = calc_jobs.start(body.database, body.code, methods, body.amount, body.direct_split, family=note)
    return calc_jobs.snapshot(job)


@router.get("/jobs/running", summary="How many calculation jobs are running right now")
def jobs_running() -> dict:
    """For the app's own housekeeping: an instance the MCP bridge started asks this before it quits
    for want of use — a running job is work someone will come back for.
    Declared before ``/jobs/{job_id}`` so the literal path wins."""
    return {"running": calc_jobs.running_count()}


@router.get("/jobs/{job_id}", summary="Status (and, with ?result=true, the scores) of a calculation job")
def job_status(job_id: str, result: bool = False) -> dict:
    job = calc_jobs.get_in_current_project(job_id)
    if job is None:
        raise PrismError(
            f"No calculation job '{job_id}'.",
            code="job_not_found",
            status_code=404,
            hint="Jobs are kept for an hour after they finish; start a new one.",
        )
    return calc_jobs.snapshot(job, with_result=result)


@router.post("/jobs/{job_id}/cancel", summary="Cancel a calculation job (between methods)")
def job_cancel(job_id: str) -> dict:
    if calc_jobs.get_in_current_project(job_id) is None:
        raise PrismError(f"No calculation job '{job_id}'.", code="job_not_found", status_code=404)
    job = calc_jobs.cancel(job_id)
    if job is None:
        raise PrismError(f"No calculation job '{job_id}'.", code="job_not_found", status_code=404)
    return calc_jobs.snapshot(job)


@router.post("/contribution-matrix", summary="Hotspot matrix: processes × indicators, one factorisation")
def contribution_matrix(request: Request, body: ContributionMatrixRequest) -> dict:
    key = _request_key(body)
    mine = _next_gen("contribution-matrix", key)
    try:
        with scenarios.applied(ScenarioStore(), body.database, body.scenario):
            return lca.contribution_matrix(
                body.database, body.code, body.methods, body.amount, body.cutoff, body.top_n,
                should_cancel=_canceller("contribution-matrix", mine, key),
            )
    except lca.CalcCancelled as e:
        raise PrismError("Superseded by a newer request.", code="calc_superseded", status_code=409) from e


@router.post("/contribution", summary="Contribution tree (compact meta+lookups+tree)")
def contribution(request: Request, body: ContributionRequest) -> dict:
    key = _request_key(body)
    mine = _next_gen("contribution", key)
    try:
        with scenarios.applied(ScenarioStore(), body.database, body.scenario):
            out = lca.contribution(
                body.database, body.code, body.method, body.amount, body.cutoff, body.max_depth,
                body.aggregate_by, should_cancel=_canceller("contribution", mine, key),
            )
        # Say which scenario the tree was computed under — the caller passed it, the meta did not
        # repeat it, and a baseline tree and a scenario tree were indistinguishable (V391).
        if body.scenario:
            out["meta"]["scenario"] = body.scenario
        return out
    except lca.CalcCancelled as e:
        raise PrismError("Superseded by a newer request.", code="calc_superseded", status_code=409) from e


@router.post("/elementary-flows", summary="Top characterised elementary flows")
def elementary_flows(request: Request, body: ElementaryFlowsRequest) -> dict:
    with scenarios.applied(ScenarioStore(), body.database, body.scenario):
        if body.phase is not None:
            if body.raw_demand or body.direct_split:
                raise PrismError(
                    "The flows of one phase come without raw_demand and direct_split.",
                    code="phase_flows_options",
                )
            from prism_lca.engine.phase_attribution import phase_flows

            return phase_flows(
                body.database, body.code, body.method, body.phase.dimension, body.phase.value,
                body.amount, body.top_n,
            )
        return lca.elementary_flows(
            body.database, body.code, body.method, body.amount, body.top_n,
            raw_demand=body.raw_demand, direct_split=body.direct_split,
        )


class InventoryRequest(BaseModel):
    database: str
    code: str
    amount: float = 1.0
    #: Substring filter on the dataset name or its reference product.
    query: str | None = None
    limit: int = 40
    scenario: str | None = None


@router.post("/inventory", summary="Technosphere quantities per functional unit")
def inventory(request: Request, body: InventoryRequest) -> dict:
    """How much of every technosphere product one functional unit pulls in — the answer to
    "how many grams of glycerine are in one tube", which previously existed only as hand arithmetic."""
    with scenarios.applied(ScenarioStore(), body.database, body.scenario):
        return lca.technosphere_inventory(body.database, body.code, body.amount, body.query, body.limit)


class MonteCarloRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    iterations: int = 1000
    amount: float = 1.0


@router.post("/montecarlo", summary="Monte Carlo uncertainty (result distribution)")
def monte_carlo(body: MonteCarloRequest) -> dict:
    return montecarlo.run(body.database, body.code, body.method, body.iterations, body.amount)


class CompareSubject(BaseModel):
    database: str
    code: str
    label: str | None = None
    scenario: str | None = None
    amount: float = 1.0


class CompareRequest(BaseModel):
    subjects: list[CompareSubject]
    methods: list[list[str]] | None = None
    #: A whole family as the rows of the matrix — see LciaRequest.method_family.
    method_family: str | None = None
    #: `compare-stacked`'s dimensions: the stacked split comes back under "stacked", computed in the same
    #: pass — one scenario window per subject instead of one per request.
    stacked_dimensions: list[str] | None = None


@router.post("/compare", summary="Compare n subjects x m methods (matrix)")
def compare(request: Request, body: CompareRequest) -> dict:
    subjects = [s.model_dump() for s in body.subjects]
    note: dict | None = None
    methods = body.methods or []
    if body.method_family:
        methods, note = _family_methods(body.method_family)
    if not methods:
        raise PrismError("Pass \"methods\" (a list of method tuples) or \"method_family\".",
                         code="invalid_request", hint="Method tuples come from list_methods.")
    key = _request_key(body)
    mine = _next_gen("compare", key)
    try:
        out = compare_engine.compare(
            ScenarioStore(), subjects, methods,
            should_cancel=_canceller("compare", mine, key),
            stacked_dimensions=body.stacked_dimensions,
        )
        if note:
            out["family"] = note
        return out
    except lca.CalcCancelled as e:
        raise PrismError("Superseded by a newer request.", code="calc_superseded", status_code=409) from e


class CompareStackedRequest(BaseModel):
    subjects: list[CompareSubject]
    methods: list[list[str]]
    dimensions: list[str]  # e.g. ['isic','cpc','tag:Phase'] — all computed in one traversal
    cutoff: float = 0.03
    max_depth: int = 6


@router.post("/compare-stacked", summary="Per (subject, method) impact broken down for stacked bars")
def compare_stacked(request: Request, body: CompareStackedRequest) -> dict:
    subjects = [s.model_dump() for s in body.subjects]
    key = _request_key(body)
    mine = _next_gen("stacked", key)
    try:
        return lca.compare_stacked(
            subjects, body.methods, body.dimensions, body.cutoff, body.max_depth,
            should_cancel=_canceller("stacked", mine, key), store=ScenarioStore(),
        )
    except lca.CalcCancelled as e:
        raise PrismError("Superseded by a newer request.", code="calc_superseded", status_code=409) from e


class CancelRequest(BaseModel):
    channel: str  # 'stacked' | 'contribution' | 'compare'


@router.post("/cancel", summary="Cancel a running results calculation on a channel")
def cancel(body: CancelRequest) -> dict:
    # Bump every request on the channel so any in-flight traversal bails at its next checkpoint.
    if body.channel in _CHANNELS:
        _cancel_channel(body.channel)
    return {"cancelled": body.channel}


class TornadoRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    delta: float = 0.1
    amount: float = 1.0
    #: Which parameters to vary. Omitted: every parameter without a formula (the model's inputs). A
    #: parameter with a formula is varied only when named here, against its formula — its entry then
    #: carries ``replaces_formula``.
    params: list[str] | None = None


class SweepRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    param: str
    values: list[float]
    amount: float = 1.0


class BreakevenRequest(BaseModel):
    database: str
    code_a: str
    code_b: str
    method: MethodRef | None = None
    param: str
    lo: float
    hi: float
    amount: float = 1.0
    #: Sub-intervals of [lo, hi] scanned for sign changes before bisecting; each one costs one solve.
    samples: int = Field(8, ge=1, le=64)


@router.post("/sensitivity/tornado", summary="One-at-a-time tornado over parameters")
def tornado(body: TornadoRequest) -> dict:
    return sensitivity.tornado(
        body.database, body.code, body.method, body.delta, body.amount, names=body.params
    )


@router.post("/sensitivity/sweep", summary="Sweep one parameter across values")
def sweep(body: SweepRequest) -> dict:
    return sensitivity.sweep(body.database, body.code, body.method, body.param, body.values, body.amount)


@router.post("/sensitivity/breakeven", summary="Find the parameter value where A == B")
def breakeven(body: BreakevenRequest) -> dict:
    return sensitivity.breakeven(
        body.database, body.code_a, body.code_b, body.method, body.param, body.lo, body.hi, body.amount,
        samples=body.samples,
    )


class AbMonteCarloRequest(BaseModel):
    a: CompareSubject
    b: CompareSubject
    method: MethodRef | None = None
    iterations: int = 1000
    seed: int = 1234


@router.post("/montecarlo/compare", summary="Paired A/B Monte Carlo (common random numbers)")
def montecarlo_compare(request: Request, body: AbMonteCarloRequest) -> dict:
    return montecarlo.compare_ab(
        ScenarioStore(), body.a.model_dump(), body.b.model_dump(),
        body.method, body.iterations, body.seed,
    )
