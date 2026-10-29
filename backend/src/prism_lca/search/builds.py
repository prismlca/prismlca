"""Running the search-index builds: one at a time, the rest waiting their turn, the flows behind them.

A build embeds every activity of a database — minutes for a large one, on every core — so only one
runs at a time. Two kinds of caller meet that rule differently. A person pressing Index is refused
while another build runs, sees it and can press again (`build`). An import cannot: it finishes on its
own, often while the index of the database imported just before it is still being built — ecoinvent
and then BAFU straight away is the recommended order — and a refusal there left the second database
without an index and nobody to notice. So an import lines its work up (`build_when_free`,
`extend_when_free`) and the slot runs it when the build ahead of it is done.

The queue lives in memory: work that never started is not resumed after a restart, where the Index
button offers it again. Each job remembers the workspace it was asked in and is dropped if another one
is current by its turn — it would index a database of the wrong workspace, or not find it.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

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


@dataclass
class IndexStatus:
    state: IndexState = IndexState.idle
    database: str | None = None
    detail: str = ""
    count: int = 0  # activities embedded so far (== total when done)
    total: int = 0  # activities to embed in the running/last build


@dataclass(frozen=True)
class _Job:
    workspace: str
    database: str
    #: None builds the whole index; codes append just these activities to the existing one.
    codes: tuple[str, ...] | None = None


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
        with self._status_lock:
            return self._status.state == IndexState.running and self._status.database == db_name

    def _set(self, **kw) -> None:
        with self._status_lock:
            for k, v in kw.items():
                setattr(self._status, k, v)

    # -- asking for work ---------------------------------------------------------------------------
    def build(self, db_name: str) -> IndexStatus:
        """Build now, or refuse with ``index_busy`` while the slot is taken."""
        return self._submit(db_name, None, wait=False)

    def build_when_free(self, db_name: str) -> IndexStatus:
        """Build now, or once the running job and those queued before this one are done."""
        return self._submit(db_name, None, wait=True)

    def extend_when_free(self, db_name: str, codes: list[str]) -> IndexStatus:
        """Append these activities to the database's index, in turn like a build — a build queued or
        running for the same database would otherwise replace the index it was appended to."""
        return self._submit(db_name, tuple(codes), wait=True)

    def _submit(self, db_name: str, codes: tuple[str, ...] | None, wait: bool) -> IndexStatus:
        bd = get_bd()
        if db_name not in bd.databases:
            raise PrismError(
                f"Database '{db_name}' not found in the active workspace.",
                code="database_not_found",
                status_code=404,
                hint="Import a background database or create the database first (see /api/v1/databases).",
            )
        job = _Job(str(bd.projects.current), db_name, codes)
        with self._slot:
            if self._busy:
                if not wait:
                    raise PrismError("An index build is already running.", code="index_busy",
                                     status_code=409, hint="Poll GET /api/v1/search/status.")
                if job not in self._queue:
                    self._queue.append(job)
                    logger.info("index job for %s queued behind the running build", db_name)
                return self._status
            self._busy = True
        # Until `_run` has begun, handing the slot on is this method's job; from then on it is
        # `_run`'s alone. Releasing it from both places started two queued jobs side by side.
        try:
            inline = self._prepare(job, inline=True)
            if not inline:
                self._spawn(job)
        except Exception as exc:
            self._set(state=IndexState.error, database=db_name, detail=str(exc))
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
            self._set(state=IndexState.running, database=job.database, detail="indexing…",
                      count=0, total=count)
            return inline and count <= SYNC_INDEX_LIMIT
        self._set(state=IndexState.running, database=job.database,
                  detail="adding the new entries to the index…", count=0, total=len(job.codes))
        return False

    def _spawn(self, job: _Job) -> None:
        threading.Thread(target=self._run, args=(job,), name="prism-index-build", daemon=True).start()

    def _run(self, job: _Job) -> None:
        """Do the job, then hand the slot on — whatever happened, and from nowhere else."""
        try:
            if job.codes is None:
                self._build(job)
            else:
                self._extend(job)
        except Exception as exc:  # noqa: BLE001 - the status carries it to the panel
            logger.warning("index job for %s failed: %s", job.database, exc)
            self._set(state=IndexState.error, database=job.database, detail=str(exc))
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
                bd = get_bd()
                if str(bd.projects.current) != job.workspace or job.database not in bd.databases:
                    logger.warning("queued index job for %s dropped: workspace '%s' is no longer "
                                   "current, or the database is gone", job.database, job.workspace)
                    continue
                self._prepare(job, inline=False)
                self._spawn(job)
                return
            except Exception as exc:  # noqa: BLE001 - one job that cannot start must not stall the rest
                logger.warning("queued index job for %s could not start: %s", job.database, exc)
                self._set(state=IndexState.error, database=job.database, detail=str(exc))

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
    def _require_workspace(job: _Job) -> None:
        """Refuse a job whose workspace is no longer the current one.

        The job is bound to the workspace it was asked in, not to the one current when its thread
        starts: the embedding can run for minutes, and the save path and the cache key are read from
        whatever workspace is current by then — a switch in between saved A's index under B and
        reported success. Checked before the work, and again in `_destination` before anything is saved.
        """
        if str(get_bd().projects.current) != job.workspace:
            raise PrismError(
                f"The workspace changed from '{job.workspace}' while the index was being built; "
                "nothing was saved.",
                code="index_project_changed",
            )

    def _destination(self, job: _Job, db_name: str) -> tuple[Path, str]:
        """Where the job's index is saved and cached: its own workspace's file and key.

        Checked and captured under PROJECT_LOCK, which every switch holds, so the two belong to the
        workspace that was verified. The save itself runs outside it — a switch meanwhile no longer
        moves where it lands, and need not wait for the file to be written.
        """
        from prism_lca.engine.commands import PROJECT_LOCK

        with PROJECT_LOCK:
            self._require_workspace(job)
            return self._svc._index_base(db_name), self._svc._cache_key(db_name)

    def _build(self, job: _Job) -> None:
        svc = self._svc
        db_name = job.database
        try:
            self._require_workspace(job)
            bd = get_bd()
            index = build_index(
                bd, db_name, svc._provider_(),
                on_progress=lambda done, total: self._set(count=done, total=total),
            )
            svc._install(index, *self._destination(job, db_name))
            self._set(state=IndexState.done, database=db_name,
                      detail=f"Indexed {len(index)} activities.", count=len(index), total=len(index))
        except Exception as exc:  # noqa: BLE001 - the status carries it to the panel
            logger.warning("building the search index of %s failed: %s", db_name, exc)
            self._set(state=IndexState.error, database=db_name, detail=str(exc))
            return
        # …and then the elementary flows, if they have no index yet. Deliberately after, and
        # deliberately not failing the build: the background index is what the user pressed the
        # button for, and it is finished. A biosphere index that fails leaves the matcher on its
        # word-overlap shortlist, which is worse but not broken.
        try:
            backlog = self._biosphere_backlog(db_name)
            if not backlog:
                return
            self._set(state=IndexState.running, database=backlog,
                      detail="indexing the elementary flows…", count=0,
                      total=len(get_bd().Database(backlog)))
            flows = build_index(
                get_bd(), backlog, svc._provider_(),
                on_progress=lambda done, total: self._set(count=done, total=total),
            )
            svc._install(flows, *self._destination(job, backlog))
            self._set(state=IndexState.done, database=backlog,
                      detail=f"Indexed {len(index)} activities and {len(flows)} flows.",
                      count=len(flows), total=len(flows))
        except Exception as exc:  # noqa: BLE001
            logger.warning("indexing the elementary flows after %s failed: %s", db_name, exc)
            self._set(state=IndexState.done, database=db_name,
                      detail=f"Indexed {len(index)} activities; the elementary flows failed.")

    def _extend(self, job: _Job) -> None:
        db_name, codes = job.database, list(job.codes or ())
        try:
            self._require_workspace(job)
            added = self._svc.extend(db_name, codes)["added"]
            self._set(state=IndexState.done, database=db_name,
                      detail=f"Added {added} entries to the index.", count=len(codes), total=len(codes))
        except Exception as exc:  # noqa: BLE001 - the status carries it to the panel
            logger.warning("adding %d entries to the search index of %s failed: %s", len(codes), db_name, exc)
            self._set(state=IndexState.error, database=db_name, detail=str(exc))
