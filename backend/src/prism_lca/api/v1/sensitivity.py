"""Sensitivity endpoints: what a run may vary, the tornado and the parameter curve as jobs, break-even.

The jobs are what the Sensitivity analysis tab drives — a run takes minutes and the page shows its
progress and can stop it (engine/sensitivity_jobs.py). The synchronous tornado and curve stay for a
caller that wants the answer in one request and can wait for it.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from prism_lca.api.v1.deps import MethodRef, require_token
from prism_lca.engine import sensitivity, sensitivity_jobs

router = APIRouter(prefix="/calc/sensitivity", tags=["calc"], dependencies=[Depends(require_token)])


class TornadoRequest(BaseModel):
    database: str
    code: str
    #: The indicators to score at every step; one factorisation per step serves them all.
    methods: list[MethodRef] = Field(default_factory=list)
    #: Kept for a caller that asks for one indicator.
    method: MethodRef | None = None
    delta: float = 0.1
    amount: float = 1.0
    #: Which parameters to vary. Omitted: every input — the parameters without a formula, and those whose
    #: formula is numbers alone. A parameter calculated from others is varied only when named here,
    #: against its formula; its entry then carries ``replaces_formula``.
    params: list[str] | None = None
    #: The scenario whose values are the starting point; omitted: the baseline.
    scenario: str | None = None

    def method_list(self) -> list:
        return list(self.methods) or [self.method]


class CurveRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    param: str
    values: list[float]
    #: One curve per entry: a scenario id, or null for the baseline. Omitted: the baseline alone.
    scenarios: list[str | None] | None = None
    amount: float = 1.0


class JobRequest(BaseModel):
    kind: Literal["tornado", "curve"]
    tornado: TornadoRequest | None = None
    curve: CurveRequest | None = None


class ChangedRequest(BaseModel):
    database: str
    #: The indicators the stored run used.
    methods: list[MethodRef]
    #: When the stored run started (the job's ``started_at``).
    since: str


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


@router.get("/inputs", summary="The parameters a sensitivity run may vary, with their values and rules")
def inputs(database: str, scenario: str | None = None) -> dict:
    return sensitivity.inputs(database, scenario)


def _tornado(body: TornadoRequest, progress=None, checkpoint=None) -> dict:
    return sensitivity.tornado(
        body.database, body.code, body.method_list(), body.delta, body.amount, names=body.params,
        scenario_id=body.scenario, progress=progress, checkpoint=checkpoint,
    )


def _curve(body: CurveRequest, progress=None, checkpoint=None) -> dict:
    return sensitivity.curve(
        body.database, body.code, body.method, body.param, body.values, body.scenarios, body.amount,
        progress=progress, checkpoint=checkpoint,
    )


@router.post("/tornado", summary="One-at-a-time tornado over parameters (waits for the answer)")
def tornado(body: TornadoRequest) -> dict:
    return _tornado(body)


@router.post("/curve", summary="One indicator across values of one parameter, per variant (waits)")
def curve(body: CurveRequest) -> dict:
    return _curve(body)


@router.post("/jobs", summary="Start a tornado or a parameter curve as a background job")
def start_job(body: JobRequest) -> dict:
    if body.kind == "tornado":
        req = body.tornado
        if req is None:
            from prism_lca.errors import PrismError

            raise PrismError("A tornado job needs its settings under 'tornado'.", code="sensitivity_job_body")
        job = sensitivity_jobs.start("tornado", req.database, req.code, lambda p, c: _tornado(req, p, c))
    else:
        req = body.curve
        if req is None:
            from prism_lca.errors import PrismError

            raise PrismError("A curve job needs its settings under 'curve'.", code="sensitivity_job_body")
        job = sensitivity_jobs.start("curve", req.database, req.code, lambda p, c: _curve(req, p, c))
    return sensitivity_jobs.snapshot(job)


@router.get("/jobs/{job_id}", summary="Progress (and, with ?result=true, the answer) of a sensitivity job")
def job_status(job_id: str, result: bool = False) -> dict:
    return sensitivity_jobs.snapshot(sensitivity_jobs.get_in_current_project(job_id), with_result=result)


@router.post("/jobs/{job_id}/cancel", summary="Stop a sensitivity job between two steps")
def job_cancel(job_id: str) -> dict:
    return sensitivity_jobs.snapshot(sensitivity_jobs.cancel(job_id))


def _after(stamp: str, since: datetime) -> bool:
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")) > since
    except ValueError:
        return False


@router.post("/changed", summary="Whether anything that moves a stored run's result changed since it started")
def changed(request: Request, body: ChangedRequest) -> dict:
    """A stored run outlives the session it was computed in, so the in-memory model generation cannot
    vouch for it. Two persisted traces can: the audit log, for every edit of this model and every
    workspace-wide change (an import, a background swap); and the saved factors of each method the run
    used, whose file is rewritten when a factor is edited — which the audit log does not record. Edits in
    OTHER models are not counted: they cannot move this model's result."""
    from prism_lca.engine import lca
    from prism_lca.engine.bootstrap import get_bd

    since = datetime.fromisoformat(body.since.replace("Z", "+00:00"))
    # The whole log, newest first: a limit keeps the model's own entries before the workspace's, and a model
    # with hundreds of edits pushed a newer workspace-wide change out of the slice.
    entries = request.app.state.command_bus.audit(database=body.database, limit=None)
    for e in reversed(entries):
        if (e.database is None or e.database == body.database) and _after(e.timestamp, since):
            return {"changed": True, "reason": "model", "summary": e.summary}
    bd = get_bd()
    for m in body.methods:
        try:
            path = bd.Method(lca.resolve_method(m)).filepath_processed()
            mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=since.tzinfo)
        except Exception:  # noqa: BLE001 - a method that is gone or unreadable is a change too
            return {"changed": True, "reason": "method"}
        if mtime > since:
            return {"changed": True, "reason": "method"}
    return {"changed": False}


@router.post("/breakeven", summary="Find the parameter value where A == B")
def breakeven(body: BreakevenRequest) -> dict:
    return sensitivity.breakeven(
        body.database, body.code_a, body.code_b, body.method, body.param, body.lo, body.hi, body.amount,
        samples=body.samples,
    )
