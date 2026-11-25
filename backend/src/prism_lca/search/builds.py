"""Running the search-index builds: one at a time, the rest waiting their turn, the flows behind them.

A build embeds every activity of a database — minutes for a large one, on every core — so only one
runs at a time. Two kinds of caller meet that rule differently. A person pressing Index is refused
while another build runs, sees it and can press again (`build`). An import cannot: it finishes on its
own, often while the index of the database imported just before it is still being built — ecoinvent
and then BAFU straight away is the recommended order — and a refusal there left the second database
without an index and nobody to notice. So an import lines its work up (`build_when_free`,
`extend_when_free`) and the slot runs it when the build ahead of it is done.

A job belongs to the workspace it was asked in: its index can only be saved there, and another
workspace may hold a database of the same name. When the user leaves that workspace, its running build
stops between two batches of the embedding instead of computing on — for ecoinvent with the local model
that was up to two hours of every core, for an index thrown away at the end — and the next job in line
starts at once. The jobs of the workspace that was left, the stopped one and those still waiting, are
parked and lined up again when it is opened (`resume`), so whoever comes back finds the index being
built rather than missing without a word.

The queue and the parked jobs live in memory: work that never finished is not resumed after a restart,
where the Index button offers it again.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from prism_lca.engine import left_workspace
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError
from prism_lca.search.indexer import build_index

logger = logging.getLogger(__name__)

#: Databases with more activities than this are indexed on a background thread.
SYNC_INDEX_LIMIT = 2000


class IndexState(StrEnum):
    idle = "idle"
    running = "running"
    done = "done"
    error = "error"
    #: Stopped because the user left the job's workspace; it waits there for their return (`resume`).
    stopped = "stopped"


@dataclass
class IndexStatus:
    state: IndexState = IndexState.idle
    database: str | None = None
    #: The workspace the job belongs to. The database name alone does not say whose build it is: two
    #: workspaces with ecoinvent 3.13 both hold an "ecoinvent-3.13-cutoff".
    workspace: str | None = None
    detail: str = ""
    count: int = 0  # activities embedded so far (== total when done)
    total: int = 0  # activities to embed in the running/last build


@dataclass(frozen=True)
class _Job:
    workspace: str
    database: str
    #: None builds the whole index; codes append just these activities to the existing one.
    codes: tuple[str, ...] | None = None
    #: The elementary flows a database build goes on to index (`_biosphere_backlog`), stopped by a switch
    #: before they were done: on return they are built only if they still have no index.
    unless_indexed: bool = False


class _WorkspaceLeft(Exception):
    """The user has left the job's workspace: the job ends where it stands and waits for their return."""


class IndexBuilds:
    """The build slot, the jobs waiting for it, and the status the search panel polls.

    ``service`` supplies the index itself (`_provider_`, `_install`, `index_info`, `extend`), so a
    subclass of the service that moves them (the eval harness) moves them here too.
    """

    def __init__(self, service) -> None:
        self._svc = service
        self._status = IndexStatus()
        self._status_lock = threading.Lock()
        #: Guards the two below. The slot is held from a job's start until the next one has taken it
        #: over — not just while the status says "running": between a database's build and its
        #: flows, or between two queued jobs, the status reads "done" for a moment, and a job that
        #: took the slot then would run beside the one that still owns it.
        self._slot = threading.Lock()
        self._busy = False
        self._queue: list[_Job] = []
        #: Jobs of workspaces the user has left, in the order they were asked for (`resume`).
        self._parked: list[_Job] = []

    # -- what the panel and the quit check read --------------------------------------------------
    def status(self) -> IndexStatus:
        return self._status

    def busy(self) -> bool:
        """A job running or waiting — work that quitting now would lose."""
        with self._slot:
            return self._busy or bool(self._queue)

    def queued(self) -> list[str]:
        """The databases of the current workspace waiting for a full build, in turn order. Appending
        to an index that exists is not listed: the database is searchable meanwhile."""
        workspace = str(get_bd().projects.current)
        with self._slot:
            names = [j.database for j in self._queue if j.workspace == workspace and j.codes is None]
        return list(dict.fromkeys(names))

    def building(self, db_name: str) -> bool:
        """Whether this database of the CURRENT workspace is being indexed — a same-named one of the
        workspace that was just left, still finishing its batch, is not."""
        workspace = str(get_bd().projects.current)
        with self._status_lock:
            st = self._status
            return st.state == IndexState.running and st.database == db_name and st.workspace == workspace

    def _set(self, **kw) -> None:
        with self._status_lock:
            for k, v in kw.items():
                setattr(self._status, k, v)

    # -- asking for work ---------------------------------------------------------------------------
    def build(self, db_name: str) -> IndexStatus:
        """Build now, or refuse with ``index_busy`` while the slot is taken."""
        return self._submit(self._job(db_name, None), wait=False)

    def build_when_free(self, db_name: str) -> IndexStatus:
        """Build now, or once the running job and those queued before this one are done."""
        return self._submit(self._job(db_name, None), wait=True)

    def extend_when_free(self, db_name: str, codes: list[str]) -> IndexStatus:
        """Append these activities to the database's index, in turn like a build — a build queued or
        running for the same database would otherwise replace the index it was appended to."""
        return self._submit(self._job(db_name, tuple(codes)), wait=True)

    def resume(self) -> None:
        """Line up again what was parked when the user left the workspace that is current now — called
        whenever the workspace may have changed (`_project_changed` in api/v1/projects.py).

        Each job on a thread of its own, whatever its size: this runs in the request that opened the
        workspace. Under PROJECT_LOCK, so the workspace whose jobs are taken is the one they are checked
        against and queued for.
        """
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK:
            bd = get_bd()
            workspace = str(bd.projects.current)
            with self._slot:
                back = [j for j in self._parked if j.workspace == workspace]
                self._parked = [j for j in self._parked if j.workspace != workspace]
            for job in back:
                if job.database not in bd.databases:
                    continue  # deleted while the user was away: nothing left to index
                try:
                    self._submit(job, wait=True, inline=False)
                except Exception as exc:  # noqa: BLE001 - the Index button still offers it
                    logger.warning("parked index job for %s not lined up again: %s", job.database, exc)

    def forget(self, workspace: str) -> None:
        """Drop what was parked for a workspace that is deleted: a new one of the same name is not the
        one the work was asked for."""
        with self._slot:
            self._parked = [j for j in self._parked if j.workspace != workspace]

    @staticmethod
    def _job(db_name: str, codes: tuple[str, ...] | None) -> _Job:
        bd = get_bd()
        if db_name not in bd.databases:
            raise PrismError(
                f"Database '{db_name}' not found in the active workspace.",
                code="database_not_found",
                status_code=404,
                hint="Import a background database or create the database first (see /api/v1/databases).",
            )
        return _Job(str(bd.projects.current), db_name, codes)

    def _submit(self, job: _Job, wait: bool, inline: bool = True) -> IndexStatus:
        db_name = job.database
        with self._slot:
            if self._busy:
                if not wait:
                    raise PrismError("An index build is already running.", code="index_busy",
                                     status_code=409, hint="Poll GET /api/v1/search/status.",
                                     situational=True)
                if job not in self._queue:
                    self._queue.append(job)
                    logger.info("index job for %s queued behind the running build", db_name)
                return self._status
            self._busy = True
        # Until `_run` has begun, handing the slot on is this method's job; from then on it is
        # `_run`'s alone. Releasing it from both places started two queued jobs side by side.
        try:
            inline = self._prepare(job, inline=inline)
            if not inline:
                self._spawn(job)
        except Exception as exc:
            self._set(state=IndexState.error, database=db_name, workspace=job.workspace, detail=str(exc))
            self._release()
            raise
        if inline:
            self._run(job)
        return self._status

    def _prepare(self, job: _Job, inline: bool) -> bool:
        """Show the job as running; answer whether it runs on the caller's thread. A small build does,
        so the request that asked for it answers with the index in place; everything else gets its own."""
        if job.codes is None:
            count = len(get_bd().Database(job.database))
            self._set(state=IndexState.running, database=job.database, workspace=job.workspace,
                      detail="indexing…", count=0, total=count)
            return inline and count <= SYNC_INDEX_LIMIT
        self._set(state=IndexState.running, database=job.database, workspace=job.workspace,
                  detail="adding the new entries to the index…", count=0, total=len(job.codes))
        return False

    def _spawn(self, job: _Job) -> None:
        threading.Thread(
            target=left_workspace.reader(self._run), args=(job,), name="prism-index-build", daemon=True
        ).start()

    def _run(self, job: _Job) -> None:
        """Do the job, then hand the slot on — whatever happened, and from nowhere else."""
        try:
            if job.codes is None:
                self._build(job)
            else:
                self._extend(job)
        except Exception as exc:  # noqa: BLE001 - the status carries it to the panel
            logger.warning("index job for %s failed: %s", job.database, exc)
            self._set(state=IndexState.error, database=job.database, workspace=job.workspace,
                      detail=str(exc))
        finally:
            self._release()

    def _release(self) -> None:
        """Hand the slot to the next job in line, or free it."""
        while True:
            with self._slot:
                if not self._queue:
                    self._busy = False
                    return
                job = self._queue.pop(0)
            try:
                from prism_lca.engine.commands import PROJECT_LOCK

                with PROJECT_LOCK:  # not judged in the middle of a switch; see `_check`
                    bd = get_bd()
                    if str(bd.projects.current) != job.workspace:
                        self._park(job)
                        continue
                    if job.database not in bd.databases:
                        logger.warning("queued index job for %s dropped: the database is gone", job.database)
                        continue
                    self._prepare(job, inline=False)
                self._spawn(job)
                return
            except Exception as exc:  # noqa: BLE001 - one job that cannot start must not stall the rest
                logger.warning("queued index job for %s could not start: %s", job.database, exc)
                self._set(state=IndexState.error, database=job.database, workspace=job.workspace,
                          detail=str(exc))

    def _park(self, job: _Job) -> str:
        """Set a job of a workspace the user has left aside until they open it again. Answers what
        became of it: "parked", "requeued" or "dropped".

        Under PROJECT_LOCK, like `resume`, which takes the parked jobs of the workspace just opened: the
        user may have come back between the look that stopped the job and this, and a job parked after
        `resume` had looked would wait for the next switch. Then it goes back to the head of the queue.
        A workspace left by deleting it gets nothing back (see `forget`).
        """
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK:
            bd = get_bd()
            if str(bd.projects.current) == job.workspace:
                with self._slot:
                    if job not in self._queue:
                        self._queue.insert(0, job)
                return "requeued"
            if job.workspace not in bd.projects:
                logger.info("index job for %s dropped: workspace '%s' is gone", job.database, job.workspace)
                return "dropped"
            logger.info("index job for %s parked until workspace '%s' is opened again",
                        job.database, job.workspace)
            with self._slot:
                if job not in self._parked:
                    self._parked.append(job)
            return "parked"

    def _stop(self, job: _Job) -> None:
        """A running job that met a switch: parked, and said so in the status."""
        outcome = self._park(job)
        if outcome == "requeued":
            return  # the user is back: `_release` starts it again straight away
        detail = (
            f"Stopped when the workspace changed; it continues when “{job.workspace}” is opened again."
            if outcome == "parked"
            else "Stopped: its workspace was deleted."
        )
        self._set(state=IndexState.stopped, database=job.database, workspace=job.workspace, detail=detail)

    # -- the work ----------------------------------------------------------------------------------
    def _biosphere_backlog(self, db_name: str) -> str | None:
        """Whether this build should pull the elementary flows in behind it.

        The import matcher needs a shortlist of *flows*, not of activities, and a word-overlap
        search cannot produce one across languages: "Distickstoffmonoxid" and "Dinitrogen monoxide"
        share no word at all. So the biosphere gets an index too — built here, in the step where the
        big one is built, because a second button nobody presses is the same as no index.

        It stays a SEPARATE index on purpose. One index per database is what keeps the process
        search unchanged: the BM25 corpus is derived per index, so a shared corpus would shift the
        IDF statistics and therefore the ranking, without anyone touching a line of ranking code.
        """
        bio = "biosphere3"
        if db_name == bio or bio not in get_bd().databases:
            return None
        return None if self._svc.index_info(bio).get("indexed") else bio

    @staticmethod
    def _check(job: _Job) -> None:
        """Stop the job if the user has left its workspace — asked before the work, around the read of
        the database (`_reading`) and between two batches of the embedding.

        The job is bound to the workspace it was asked in, not to the one current when its thread
        starts: the save path and the cache key are read from whatever workspace is current by then —
        a switch in between once saved A's index under B and reported success. And a build that goes on
        in a workspace nobody is in computes for nothing; `_destination` would refuse its save anyway.

        Asked under PROJECT_LOCK, and so never in the middle of a switch. Every switch holds it, and so
        do the steps that go into another workspace for a while and come back (restoring a backup over an
        existing workspace): a look inside one would stop a build whose workspace never went away. The
        build waits for such a step instead; nothing it could do meanwhile would be of use.
        """
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK:
            current = str(get_bd().projects.current)
        if current != job.workspace:
            raise _WorkspaceLeft(job.workspace)

    @contextmanager
    def _reading(self, job: _Job) -> Iterator[None]:
        """Read the database to be indexed with its workspace checked and kept current throughout.

        Under PROJECT_LOCK: a switch, or a step into another workspace and back, that fell into the
        read would hand it the other workspace's database of the same name, and the check before the
        save would pass once the step had come back. A switch waits the seconds the read takes.
        """
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK:
            self._check(job)
            yield

    def _destination(self, job: _Job, db_name: str) -> tuple[Path, str]:
        """Where the job's index is saved and cached: its own workspace's file and key.

        Checked and captured under PROJECT_LOCK, which every switch holds, so the two belong to the
        workspace that was verified. The save itself runs outside it — a switch meanwhile no longer
        moves where it lands, and need not wait for the file to be written.
        """
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK:
            if str(get_bd().projects.current) != job.workspace:
                raise _WorkspaceLeft(job.workspace)
            return self._svc._index_base(db_name), self._svc._cache_key(db_name)

    def _build(self, job: _Job) -> None:
        svc = self._svc
        db_name = job.database
        try:
            self._check(job)
            if job.unless_indexed and svc.index_info(db_name).get("indexed"):
                self._set(state=IndexState.done, database=db_name, detail="Already indexed.", count=0, total=0)
                return
            bd = get_bd()
            index = build_index(
                bd, db_name, svc._provider_(),
                on_progress=lambda done, total: self._set(count=done, total=total),
                checkpoint=lambda: self._check(job),
                reading=lambda: self._reading(job),
            )
            svc._install(index, *self._destination(job, db_name))
            self._set(state=IndexState.done, database=db_name,
                      detail=f"Indexed {len(index)} activities.", count=len(index), total=len(index))
        except _WorkspaceLeft:
            self._stop(job)
            return
        except Exception as exc:  # noqa: BLE001 - the status carries it to the panel
            logger.warning("building the search index of %s failed: %s", db_name, exc)
            self._set(state=IndexState.error, database=db_name, detail=str(exc))
            return
        # …and then the elementary flows, if they have no index yet. Deliberately after, and
        # deliberately not failing the build: the background index is what the user pressed the
        # button for, and it is finished. A biosphere index that fails leaves the matcher on its
        # word-overlap shortlist, which is worse but not broken.
        flows_job = _Job(job.workspace, "biosphere3", unless_indexed=True)
        try:
            # Asked first: what the backlog reads below is the current workspace's biosphere.
            self._check(job)
            backlog = self._biosphere_backlog(db_name)
            if not backlog:
                return
            self._set(state=IndexState.running, database=backlog,
                      detail="indexing the elementary flows…", count=0,
                      total=len(get_bd().Database(backlog)))
            flows = build_index(
                get_bd(), backlog, svc._provider_(),
                on_progress=lambda done, total: self._set(count=done, total=total),
                checkpoint=lambda: self._check(job),
                reading=lambda: self._reading(job),
            )
            svc._install(flows, *self._destination(job, backlog))
            self._set(state=IndexState.done, database=backlog,
                      detail=f"Indexed {len(index)} activities and {len(flows)} flows.",
                      count=len(flows), total=len(flows))
        except _WorkspaceLeft:
            # The database's own index is in place; only the flows are left for the return.
            if db_name != flows_job.database:
                self._stop(flows_job)
        except Exception as exc:  # noqa: BLE001
            logger.warning("indexing the elementary flows after %s failed: %s", db_name, exc)
            self._set(state=IndexState.done, database=db_name,
                      detail=f"Indexed {len(index)} activities; the elementary flows failed.")

    def _extend(self, job: _Job) -> None:
        db_name, codes = job.database, list(job.codes or ())
        try:
            self._check(job)
            added = self._svc.extend(db_name, codes)["added"]
            self._set(state=IndexState.done, database=db_name,
                      detail=f"Added {added} entries to the index.", count=len(codes), total=len(codes))
        except _WorkspaceLeft:
            self._stop(job)
        except Exception as exc:  # noqa: BLE001 - the status carries it to the panel
            logger.warning("adding %d entries to the search index of %s failed: %s", len(codes), db_name, exc)
            self._set(state=IndexState.error, database=db_name, detail=str(exc))
