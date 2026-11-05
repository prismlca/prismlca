"""The Typst compiler, run in worker processes: offline, and within a time, memory and output budget.

A compile over its budget ends its worker, not the backend, and the next compile starts a new one.
Workers stay up between compiles (a cold start costs about half a second), and two serve at once, because
the theme gallery asks for a dozen covers together.

The wheel has no switch for its package downloader but honours the proxy variables, so each worker points
them at a loopback port it holds bound without listening, and gives the compiler an empty package
directory. Only the worker's environment changes; the backend's own HTTP clients keep theirs.
"""
from __future__ import annotations

import atexit
import multiprocessing
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from typing import Any

import typst

from prism_lca.errors import PrismError

#: Wall-clock limit of one compile. A 300-page report previews in under ten seconds.
TIME_LIMIT_S = 120.0
#: Memory a worker may hold; the largest documents we have typeset needed under 1 GB.
MEMORY_LIMIT = 2 * 1024**3
#: What a compile may hand back: 300 preview pages are about 25 MB.
OUTPUT_LIMIT = 512 * 1024**2
#: Workers that typeset at the same time.
WORKERS = 2

_POLL_S = 0.05
_EXIT_TIME = 86
_EXIT_MEMORY = 87
_PROXY_VARIABLES = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")


class CompileError(Exception):
    """The compiler's own error, carried across the process boundary with the diagnostic that locates it."""

    def __init__(self, message: str, diagnostic: str = "") -> None:
        super().__init__(message)
        self.diagnostic = diagnostic


# ---- the worker --------------------------------------------------------------------------------------


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


def _trusted_reader(memory_limit: int) -> Callable[[], int] | None:
    """`_memory_reader`, if it works here and gives a believable first reading — without one, only the
    time limit applies."""
    try:
        read = _memory_reader()
        if read is not None and read() <= memory_limit // 2:
            return read
    except Exception:  # noqa: BLE001
        pass
    return None


def _over(read: Callable[[], int] | None, limit: int) -> bool:
    try:
        return read is not None and read() > limit
    except Exception:  # noqa: BLE001 - a reading that fails is no reason to stop a compile
        return False


def _watch(started: list[float | None], time_limit: float, memory_limit: int, read) -> None:
    """End this worker when the running compile overruns its budget — a guard of its own, so a compile
    is stopped even when the backend that started it is gone. The compiler releases the GIL while it
    works, which is what lets this thread run beside it."""
    while True:
        time.sleep(_POLL_S)
        began = started[0]
        if began is None:
            continue
        if time.monotonic() - began > time_limit:
            os._exit(_EXIT_TIME)
        if _over(read, memory_limit):
            os._exit(_EXIT_MEMORY)


def _go_offline() -> socket.socket:
    """Route every proxy variable to a loopback port held bound and never listened on, so a download
    attempt is refused on this machine. Held for the worker's life, so no other program can take it."""
    trap = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows: no other socket may share the port
        trap.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    trap.bind(("127.0.0.1", 0))
    nowhere = f"http://127.0.0.1:{trap.getsockname()[1]}"
    for name in ("NO_PROXY", "no_proxy"):
        os.environ.pop(name, None)
    for name in _PROXY_VARIABLES:
        os.environ[name] = nowhere
    return trap


def _serve(conn: Any, packages: str, time_limit: float, memory_limit: int, output_limit: int) -> None:
    """The worker's loop: one compile per message, until the backend closes the pipe."""
    trap = _go_offline()
    read = _trusted_reader(memory_limit)
    started: list[float | None] = [None]
    threading.Thread(target=_watch, args=(started, time_limit, memory_limit, read), daemon=True).start()
    try:
        while True:
            try:
                job = conn.recv()
            except (EOFError, OSError):
                return
            input_path, options = job
            started[0] = time.monotonic()
            try:
                result = typst.compile(input_path, package_path=packages, package_cache_path=packages, **options)
            except Exception as exc:  # noqa: BLE001 - typst.TypstError and anything the extension raises
                reply: tuple = ("error", str(exc), str(getattr(exc, "diagnostic", "") or ""))
            else:
                size = sum(map(len, result)) if isinstance(result, list) else len(result)
                reply = ("ok", result) if size <= output_limit else ("too_large", size)
            finally:
                started[0] = None
            # A worker that has grown past half its budget is replaced after this reply, so what the
            # compiler keeps between documents cannot add up to a refusal of a document that fits.
            conn.send((reply, _over(read, memory_limit // 2)))
    finally:
        trap.close()


# ---- the backend's side ----------------------------------------------------------------------------


class _Worker:
    def __init__(self) -> None:
        context = multiprocessing.get_context("spawn")
        self.packages = tempfile.mkdtemp(prefix="prism-typst-packages-")
        self.conn, child = context.Pipe()
        self.process = context.Process(
            target=_serve,
            args=(child, self.packages, TIME_LIMIT_S, MEMORY_LIMIT, OUTPUT_LIMIT),
            name="prism-typst",
            daemon=True,
        )
        self.process.start()
        child.close()

    def stop(self) -> None:
        if self.process.is_alive():
            self.process.kill()
        self.process.join(5)
        self.conn.close()
        shutil.rmtree(self.packages, ignore_errors=True)


_slots = threading.BoundedSemaphore(WORKERS)
_idle: list[_Worker] = []
_idle_lock = threading.Lock()


def _stopped(worker: _Worker, *, answered: bool) -> PrismError:
    """Why a worker gave no reply, as the error the compile ends with. The worker is gone afterwards."""
    if answered:  # it closed the pipe: it ended, and its exit code says why
        worker.process.join(5)
    code = worker.process.exitcode
    worker.stop()
    if code is None or code == _EXIT_TIME:
        return PrismError(
            f"Typesetting took longer than {TIME_LIMIT_S:.0f} seconds and was stopped.",
            code="typst_timeout",
            hint="If a custom theme is in use, check it or switch to a shipped theme.",
        )
    if code == _EXIT_MEMORY:
        return PrismError(
            f"Typesetting needed more than {MEMORY_LIMIT / 1024**3:g} GB of memory and was stopped.",
            code="typst_out_of_memory",
            hint="If a custom theme, a large cover image or a large logo is in use, check it or switch "
            "to a shipped theme.",
        )
    return PrismError(
        f"The typesetting process stopped unexpectedly (exit code {code}).",
        code="typst_worker_failed",
        hint="Try again: the next attempt starts a new process.",
    )


def shutdown() -> None:
    """Stop the idle workers; a running compile keeps its own until it ends."""
    with _idle_lock:
        workers, _idle[:] = list(_idle), []
    for worker in workers:
        worker.stop()


atexit.register(shutdown)


def compile(input_path: str, **options: Any) -> bytes | list[bytes]:
    """`typst.compile(input_path, **options)`, run in a worker. A compiler error comes back as
    `CompileError`; a compile over its budget ends as a PrismError, with its worker replaced."""
    with _slots:
        with _idle_lock:
            worker = _idle.pop() if _idle else None
        if worker is None or not worker.process.is_alive():
            if worker is not None:
                worker.stop()
            worker = _Worker()
        try:
            worker.conn.send((input_path, options))
            # The worker stops itself at the limit; the grace covers a start and a reply under load.
            reply = worker.conn.recv() if worker.conn.poll(TIME_LIMIT_S + 10) else None
        except (EOFError, OSError):
            raise _stopped(worker, answered=True) from None
        except BaseException:
            worker.stop()
            raise
        if reply is None:
            raise _stopped(worker, answered=False)
        reply, retire = reply
        if retire:
            worker.stop()
        else:
            with _idle_lock:
                _idle.append(worker)
    if reply[0] == "ok":
        return reply[1]
    if reply[0] == "too_large":
        raise PrismError(
            f"The typeset document is {reply[1] // 1024**2} MB, more than PrismLCA can show or save at once.",
            code="typst_output_too_large",
            hint="If a custom theme is in use, check it or switch to a shipped theme.",
        )
    raise CompileError(reply[1], reply[2])
