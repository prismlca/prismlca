"""Sensitivity runs as background jobs: start, poll progress, read, cancel.

A tornado over thirty parameters is sixty-odd steps; a parameter curve over three variants three dozen.
Scored from the system the model already has (engine/sensitivity_fast.py) that is seconds, but a model the
fast path does not take writes every step, and that is minutes. The UI shows a progress bar and a Cancel
button for that, and neither works over one blocking request. So a run becomes a job: started at once with
an id, computed in a worker thread, polled for ``done``/``total`` and the step it is on, cancelled between
two steps (one solve is not interruptible).

Same shape as the LCIA jobs (engine/calc_jobs.py) and kept beside them rather than inside: those step
through methods, these through parameter values — inside one crash-marked window when the steps are
written — and a job that stops early has to leave through that window's ``finally``, which is why stopping
is an exception raised at a checkpoint, not a loop that breaks.

A job remembers the model generation and the workspace it started in, and the checkpoint refuses to go on
once either moved, the same guard the LCIA jobs keep. A run that writes its steps holds the LCA lock for its
whole span, so an edit through the parameter routes waits for it; a fast run lets go of the lock after
reading the model, and an edit during its steps stops it at the next checkpoint instead.
"""
from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from prism_lca.engine import lca
from prism_lca.engine._store import now_iso
from prism_lca.engine.calc_jobs import JobInvalidated, _current_project
from prism_lca.errors import PrismError

#: Finished jobs are kept this long (seconds) or until this many newer ones exist — whichever first.
RETENTION_SECONDS = 3600
RETENTION_COUNT = 20

#: ``run(progress, checkpoint) -> result``: the analysis, with the job's two hooks wired in.
Run = Callable[[Callable[[int, int, str], None], Callable[[], None]], dict]


@dataclass
class SensitivityJob:
    id: str
    kind: str  # tornado | curve
    database: str
    code: str
    model_generation: int
    project: str | None
    started_at: str
    state: str = "running"  # running | done | error | cancelled | invalidated
    finished_at: str | None = None
    done: int = 0
    total: int = 0
    #: What the job is doing now. Until the run holds the LCA lock it is waiting for another calculation,
    #: and the bar says so instead of sitting at zero.
    label: str = "Waiting for another calculation to finish…"
    result: dict | None = None
    error: str | None = None
    seconds: float | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


_LOCK = threading.Lock()
_JOBS: dict[str, SensitivityJob] = {}


def _prune() -> None:
    """Under _LOCK. Drop finished jobs past the retention, oldest first."""
    finished = sorted((j for j in _JOBS.values() if j.state != "running"), key=lambda j: j.finished_at or "")
    cutoff = time.time() - RETENTION_SECONDS
    for i, j in enumerate(finished):
        too_many = len(finished) - i > RETENTION_COUNT
        if too_many or (j.seconds is not None and _finished_epoch(j) < cutoff):
            _JOBS.pop(j.id, None)


def _finished_epoch(job: SensitivityJob) -> float:
    from datetime import datetime

    try:
        return datetime.fromisoformat(job.finished_at or "").timestamp()
    except ValueError:
        return time.time()


def start(kind: str, database: str, code: str, run: Run, run_in_thread: bool = True) -> SensitivityJob:
    job = SensitivityJob(
        id=uuid.uuid4().hex[:12],
        kind=kind,
        database=database,
        code=code,
        model_generation=lca.model_generation(),
        project=_current_project(),
        started_at=now_iso(),
    )
    with _LOCK:
        _prune()
        _JOBS[job.id] = job
    if run_in_thread:
        threading.Thread(target=_run, args=(job, run), daemon=True, name=f"sensitivity-{job.id}").start()
    else:
        _run(job, run)
    return job


def _run(job: SensitivityJob, run: Run) -> None:
    t0 = time.monotonic()

    def progress(done: int, total: int, label: str) -> None:
        job.done, job.total, job.label = done, total, label

    def checkpoint() -> None:
        if job.cancel.is_set():
            raise lca.CalcCancelled("cancelled")
        if _current_project() != job.project:
            raise JobInvalidated("The active workspace changed while computing; the run stopped.")
        if lca.model_generation() != job.model_generation:
            raise JobInvalidated("The model changed while computing; the run stopped. Start it again.")

    try:
        job.result = run(progress, checkpoint)
        job.state = "done"
    except lca.CalcCancelled:
        job.state = "cancelled"
    except JobInvalidated as exc:
        job.state = "invalidated"
        job.error = str(exc)
    except PrismError as exc:
        job.state = "error"
        job.error = exc.message
    except Exception as exc:  # noqa: BLE001 - the job carries the error to its reader
        job.state = "error"
        job.error = str(exc) or exc.__class__.__name__
    finally:
        job.seconds = round(time.monotonic() - t0, 1)
        job.finished_at = now_iso()


def running_count() -> int:
    """Runs still computing, across projects — what a quit of the process would destroy (api/v1/system.py)."""
    return sum(1 for j in _JOBS.values() if j.state == "running")


def get_in_current_project(job_id: str) -> SensitivityJob:
    with _LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise PrismError(
            f"No sensitivity run '{job_id}'.",
            code="job_not_found",
            status_code=404,
            hint="Runs are kept for an hour after they finish; start a new one.",
        )
    if job.project != _current_project():
        raise PrismError(
            f"Sensitivity run '{job_id}' belongs to workspace \"{job.project}\", not to the active one.",
            code="job_other_project",
            status_code=409,
            hint="Switch back to that workspace to read it, or start a new run here.",
        )
    return job


def cancel(job_id: str) -> SensitivityJob:
    job = get_in_current_project(job_id)
    if job.state == "running":
        job.cancel.set()
    return job


def snapshot(job: SensitivityJob, with_result: bool = False) -> dict:
    out: dict = {
        "job_id": job.id,
        "kind": job.kind,
        "state": job.state,
        "activity": {"database": job.database, "code": job.code},
        "progress": {"done": job.done, "total": job.total, "label": job.label},
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "seconds": job.seconds,
        "stale": lca.model_generation() != job.model_generation,
    }
    if job.error:
        out["error"] = job.error
    if with_result and job.state == "done" and job.result is not None:
        out["result"] = job.result
    return out


def _reset_for_tests() -> None:
    with _LOCK:
        _JOBS.clear()
