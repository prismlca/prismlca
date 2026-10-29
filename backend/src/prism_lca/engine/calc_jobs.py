"""Background LCIA jobs: start, poll, read, cancel.

The synchronous ``/calc/lcia`` is right for one method on one process. An external MCP client has
a per-call timeout (Codex: 60 s by default), and a whole method family or a long family on a deep
model is longer than that — and a client that gives up and calls again starts the same calculation
twice. So a long calculation becomes a *job*: started at once with an id, computed method by method
in a worker thread under the LCA lock like every other calculation, read back when done, kept for a
while, cancellable between methods (the matrix solve of one method is not interruptible).

The job remembers the model generation it started under; a reader sees ``stale`` when the model
changed meanwhile, so a result from before an edit is not mistaken for the current state.
Same pattern as the background import (``engine/ecoinvent.py``: start in a thread, poll a status).
"""
from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from prism_lca.engine import lca
from prism_lca.engine._store import now_iso
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError

#: Finished jobs are kept this long (seconds) or until this many newer ones exist — whichever first.
RETENTION_SECONDS = 3600
RETENTION_COUNT = 50

Compute = Callable[..., dict]


@dataclass
class CalcJob:
    id: str
    database: str
    code: str
    methods: list
    amount: float
    direct_split: bool
    family: dict | None
    model_generation: int
    #: The Brightway project the job was started in. Each method is computed against the CURRENT
    #: project, so a switch mid-job would mix two projects' same-named models — checked before every
    #: method, under the LCA lock a switch holds.
    project: str | None
    started_at: str
    state: str = "running"  # running | done | error | cancelled | invalidated
    finished_at: str | None = None
    done: int = 0
    results: list[dict] = field(default_factory=list)
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    @property
    def total(self) -> int:
        return len(self.methods)


_LOCK = threading.Lock()
_JOBS: dict[str, CalcJob] = {}


def _prune() -> None:
    """Under _LOCK. Drop finished jobs past the retention, oldest first."""
    now = time.time()
    finished = [j for j in _JOBS.values() if j.state != "running"]
    finished.sort(key=lambda j: j.finished_at or "")
    for j in finished:
        age_ok = j.finished_at is None or (now - _epoch(j.finished_at)) < RETENTION_SECONDS
        if not age_ok or len([x for x in _JOBS.values() if x.state != "running"]) > RETENTION_COUNT:
            _JOBS.pop(j.id, None)


def _epoch(iso: str) -> float:
    from datetime import datetime

    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return time.time()


def start(
    database: str,
    code: str,
    methods: list,
    amount: float = 1.0,
    direct_split: bool = False,
    family: dict | None = None,
    compute: Compute | None = None,
    run_in_thread: bool = True,
) -> CalcJob:
    # Resolved at call time, not at definition: a test (or a future engine swap) that replaces
    # lca.compute_lcia must reach the jobs too.
    compute = compute or lca.compute_lcia
    job = CalcJob(
        id=uuid.uuid4().hex[:12],
        database=database,
        code=code,
        methods=list(methods),
        amount=amount,
        direct_split=direct_split,
        family=family,
        model_generation=lca.model_generation(),
        project=_current_project(),
        started_at=now_iso(),
    )
    with _LOCK:
        _prune()
        _JOBS[job.id] = job
    if run_in_thread:
        threading.Thread(target=_run, args=(job, compute), daemon=True, name=f"calc-job-{job.id}").start()
    else:
        _run(job, compute)
    return job


def _run(job: CalcJob, compute: Compute) -> None:
    try:
        for m in job.methods:
            if job.cancel.is_set():
                job.state = "cancelled"
                break
            # One method at a time, under the LCA lock for the check AND the compute (the lock is
            # re-entrant; compute takes it again inside) — a project switch or a model edit cannot
            # land between "still the same model?" and the solve. Released between methods, so a
            # cancel lands there and a user's edit never waits for the whole family.
            with lca._LCA_LOCK:
                _assert_unchanged(job)
                job.results.append(compute(job.database, job.code, m, job.amount, job.direct_split))
            job.done += 1
        else:
            job.state = "done"
    except JobInvalidated as exc:
        job.state = "invalidated"
        job.error = str(exc)
    except Exception as exc:  # noqa: BLE001 - the job carries the error to its reader
        job.state = "error"
        job.error = str(exc) or exc.__class__.__name__
    finally:
        job.finished_at = now_iso()


def _current_project() -> str | None:
    try:
        return get_bd().projects.current or None
    except Exception:  # noqa: BLE001 - no project is an answer, not a crash
        return None


class JobInvalidated(RuntimeError):
    """The ground moved under a running job: another project is active, or the model changed."""


def _assert_unchanged(job: CalcJob) -> None:
    current = _current_project()
    if current != job.project:
        raise JobInvalidated(
            f'The active workspace changed while computing (started in "{job.project}", now "{current}"); '
            "the job stopped so that no scores from two workspaces are mixed."
        )
    if lca.model_generation() != job.model_generation:
        raise JobInvalidated("The model changed while computing; the job stopped. Start it again for the current state.")


def running_count() -> int:
    """Jobs still computing, across projects — what a quit of the process would destroy."""
    return sum(1 for j in _JOBS.values() if j.state == "running")


def get(job_id: str) -> CalcJob | None:
    with _LOCK:
        return _JOBS.get(job_id)


def get_in_current_project(job_id: str) -> CalcJob | None:
    """A job is read back only from the project it was started in: a reader in another project would
    get numbers about a model of the same name that is not theirs."""
    job = get(job_id)
    if job is None:
        return None
    if job.project != _current_project():
        raise PrismError(
            f'Calculation job "{job_id}" belongs to workspace "{job.project}", not to the active one.',
            code="job_other_project",
            status_code=409,
            hint="Switch back to that workspace to read it, or start a new job here.",
        )
    return job


def cancel(job_id: str) -> CalcJob | None:
    job = get(job_id)
    if job is None:
        return None
    if job.state == "running":
        job.cancel.set()
    return job


def snapshot(job: CalcJob, with_result: bool = False) -> dict:
    out: dict = {
        "job_id": job.id,
        "state": job.state,
        "activity": {"database": job.database, "code": job.code},
        "amount": job.amount,
        "progress": {"done": job.done, "total": job.total},
        "project": job.project,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        # The model moved on since the job started: the numbers describe the model as it WAS.
        "stale": lca.model_generation() != job.model_generation,
    }
    if job.family:
        out["family"] = job.family
    if job.error:
        out["error"] = job.error
    if with_result and job.state in ("done", "cancelled") and job.results:
        keys = ("method", "unit", "score") + (("direct", "upstream", "direct_share") if job.direct_split else ())
        out["result"] = {
            "activity": job.results[0]["activity"],
            "amount": job.amount,
            "results": [{k: r[k] for k in keys if k in r} for r in job.results],
        }
        if job.state == "cancelled":
            out["result"]["note"] = f"Cancelled after {job.done} of {job.total} methods; the rest were not computed."
    return out


def _reset_for_tests() -> None:
    with _LOCK:
        _JOBS.clear()
