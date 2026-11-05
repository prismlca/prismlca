"""Worker processes that run one job at a time within a time and memory budget.

A job over its budget ends its worker, not the backend, and the next job starts a new one. Workers stay up
between jobs, because a cold start costs a new interpreter and its imports. The Typst compiler
(``typst_worker``) and the PDF reader of chat attachments (``attachment_pdf``) run in such workers; each
brings its own job handler and says in its own words why a job was stopped.

Each job carries its own time limit; the memory limit belongs to the worker. A worker watches itself and
exits with :data:`EXIT_TIME` or :data:`EXIT_MEMORY` when its job overruns, so a job is stopped even when the
backend that started it is gone; the backend also stops a worker that has not answered shortly after the
time limit.
"""
from __future__ import annotations

import atexit
import multiprocessing
import os
import sys
import threading
import time
from collections.abc import Callable
from typing import Any

#: Exit codes of a worker that stopped its own job: over its time limit, over its memory limit.
EXIT_TIME = 86
EXIT_MEMORY = 87
_POLL_S = 0.05
#: How long the backend waits past a job's time limit before it stops the worker itself: the worker's own
#: guard ends it at the limit, this covers a start and a reply under load.
GRACE_S = 10.0


# ---- inside a worker ---------------------------------------------------------------------------------


def _memory_reader() -> Callable[[], int] | None:
    """How this process reads its own memory in use, or None where it cannot."""
    if sys.platform.startswith("linux"):
        page = os.sysconf("SC_PAGE_SIZE")

        def resident() -> int:
            with open("/proc/self/statm", "rb") as statm:
                return int(statm.read().split()[1]) * page

        return resident
    if sys.platform == "darwin":
        import resource

        # The peak rather than the current size, which is all `getrusage` gives; in bytes on macOS.
        return lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t)
                for name in (
                    "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                    "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage",
                )
            ]

        query = ctypes.WinDLL("psapi").GetProcessMemoryInfo
        query.argtypes = (wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD)
        query.restype = wintypes.BOOL
        this_process = wintypes.HANDLE(-1)

        def committed() -> int:
            counters = Counters(cb=ctypes.sizeof(Counters))
            if not query(this_process, ctypes.byref(counters), counters.cb):
                raise OSError("GetProcessMemoryInfo failed")
            return max(counters.WorkingSetSize, counters.PagefileUsage)

        return committed
    return None


def trusted_reader(memory_limit: int) -> Callable[[], int] | None:
    """`_memory_reader`, if it works here and gives a believable first reading — without one, only the
    time limit applies."""
    try:
        read = _memory_reader()
        if read is not None and read() <= memory_limit // 2:
            return read
    except Exception:  # noqa: BLE001
        pass
    return None


def over(read: Callable[[], int] | None, limit: int) -> bool:
    try:
        return read is not None and read() > limit
    except Exception:  # noqa: BLE001 - a reading that fails is no reason to stop a job
        return False


def _watch(running: list[tuple[float, float] | None], memory_limit: int, read) -> None:
    """End this worker when the running job overruns its budget. A job in pure Python hands this thread the
    GIL at the interpreter's switch interval; compiled code (the Typst compiler, zlib) releases it while it
    works. Should a call hold it regardless, the backend still stops the worker after the grace."""
    while True:
        time.sleep(_POLL_S)
        job = running[0]
        if job is None:
            continue
        began, time_limit = job
        if time.monotonic() - began > time_limit:
            os._exit(EXIT_TIME)
        if over(read, memory_limit):
            os._exit(EXIT_MEMORY)


def serve(conn: Any, handle: Callable[[Any], Any], memory_limit: int) -> None:
    """A worker's loop: `handle` answers one job per message, until the backend closes the pipe.

    A message is ``(time_limit, job)``; the reply goes back with whether this worker should be retired.
    `handle` turns its job's own errors into replies — an exception that escapes it ends the worker.
    """
    read = trusted_reader(memory_limit)
    running: list[tuple[float, float] | None] = [None]
    threading.Thread(target=_watch, args=(running, memory_limit, read), daemon=True).start()
    while True:
        try:
            time_limit, job = conn.recv()
        except (EOFError, OSError):
            return
        running[0] = (time.monotonic(), time_limit)
        try:
            reply = handle(job)
        finally:
            running[0] = None
        # A worker that has grown past half its budget is replaced after this reply, so what a job leaves
        # behind cannot add up to a refusal of a later job that fits.
        conn.send((reply, over(read, memory_limit // 2)))


# ---- the backend's side ------------------------------------------------------------------------------


class Stopped(Exception):
    """A worker gave no reply. `code` is its exit code — :data:`EXIT_TIME`, :data:`EXIT_MEMORY` or another
    one — or None when the backend stopped it for not answering in time. The worker is gone afterwards."""

    def __init__(self, code: int | None) -> None:
        super().__init__(f"worker stopped (exit code {code})")
        self.code = code


class Worker:
    """One worker process and the pipe to it. `target(conn, *args)` runs in the new process; `cleanup`
    runs in the backend once the worker is stopped."""

    def __init__(
        self, target: Callable[..., None], args: tuple, *, name: str, cleanup: Callable[[], None] | None = None
    ) -> None:
        context = multiprocessing.get_context("spawn")
        self.conn, child = context.Pipe()
        self._cleanup = cleanup
        self.process = context.Process(target=target, args=(child, *args), name=name, daemon=True)
        self.process.start()
        child.close()

    def stop(self) -> None:
        if self.process.is_alive():
            self.process.kill()
        self.process.join(5)
        self.conn.close()
        if self._cleanup is not None:
            self._cleanup()


class Pool:
    """Up to `size` workers at once, started by `start` when none is idle; idle ones are kept for the next
    job and stopped when the backend exits."""

    def __init__(self, start: Callable[[], Worker], size: int) -> None:
        self._start = start
        self._slots = threading.BoundedSemaphore(size)
        self._idle: list[Worker] = []
        self._idle_lock = threading.Lock()
        atexit.register(self.shutdown)

    def run(self, job: Any, time_limit: float) -> Any:
        """The worker's reply to `job`, or :class:`Stopped` when the worker ended without one."""
        with self._slots:
            with self._idle_lock:
                worker = self._idle.pop() if self._idle else None
            if worker is None or not worker.process.is_alive():
                if worker is not None:
                    worker.stop()
                worker = self._start()
            try:
                worker.conn.send((time_limit, job))
                answer = worker.conn.recv() if worker.conn.poll(time_limit + GRACE_S) else None
            except (EOFError, OSError):
                raise _stopped(worker, answered=True) from None
            except BaseException:
                worker.stop()
                raise
            if answer is None:
                raise _stopped(worker, answered=False)
            reply, retire = answer
            if retire:
                worker.stop()
            else:
                with self._idle_lock:
                    self._idle.append(worker)
        return reply

    def shutdown(self) -> None:
        """Stop the idle workers; a running job keeps its own until it ends."""
        with self._idle_lock:
            workers, self._idle[:] = list(self._idle), []
        for worker in workers:
            worker.stop()


def _stopped(worker: Worker, *, answered: bool) -> Stopped:
    if answered:  # it closed the pipe: it ended, and its exit code says why
        worker.process.join(5)
    code = worker.process.exitcode
    worker.stop()
    return Stopped(code)
