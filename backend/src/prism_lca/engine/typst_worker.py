"""The Typst compiler, run in worker processes: offline, and within a time, memory and output budget.

A compile over its budget ends its worker, not the backend, and the next compile starts a new one. Workers stay up
between compiles (a cold start costs about half a second), and two serve at once, because the theme gallery asks
for a dozen covers together. The process machinery is ``bounded_worker``'s.

The wheel has no switch for its package downloader but honours the proxy variables, so each worker points
them at a loopback port it holds bound without listening, and gives the compiler an empty package
directory. Only the worker's environment changes; the backend's own HTTP clients keep theirs.
"""
from __future__ import annotations

import os
import shutil
import socket
import tempfile
from typing import Any

import typst

from prism_lca.engine import bounded_worker
from prism_lca.errors import PrismError

#: Wall-clock limit of one compile. A 300-page report previews in under ten seconds.
TIME_LIMIT_S = 120.0
#: Memory a worker may hold; the largest documents we have typeset needed under 1 GB.
MEMORY_LIMIT = 2 * 1024**3
#: What a compile may hand back: 300 preview pages are about 25 MB.
OUTPUT_LIMIT = 512 * 1024**2
#: Workers that typeset at the same time.
WORKERS = 2

#: How much of a compiler error crosses back: the message, and the diagnostic's location lines.
_ERROR_CHARS = 2000
_LOCATION_LINES = 5
_LOCATION_CHARS = 500
_PROXY_VARIABLES = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")


class CompileError(Exception):
    """The compiler's own error, carried across the process boundary with the diagnostic that locates it."""

    def __init__(self, message: str, diagnostic: str = "") -> None:
        super().__init__(message)
        self.diagnostic = diagnostic


# ---- the worker --------------------------------------------------------------------------------------


def _bounded_error(exc: Exception) -> tuple[str, str]:
    """A compiler error at a bounded size: the message cut short, and of the diagnostic only the lines
    under its box rule that name a file, a line and a column — all `typst_render` reads from it."""
    message = str(exc)
    if len(message) > _ERROR_CHARS:
        message = message[:_ERROR_CHARS] + "…"
    diagnostic = str(getattr(exc, "diagnostic", "") or "")
    located = [line[:_LOCATION_CHARS] for line in diagnostic.splitlines() if "┌─" in line]
    return message, "\n".join(located[:_LOCATION_LINES])


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


def _serve(conn: Any, packages: str, memory_limit: int, output_limit: int) -> None:
    """The worker: one compile per message, until the backend closes the pipe. The compiler releases the
    GIL while it works, which is what lets the worker's own guard run beside it."""
    trap = _go_offline()

    def handle(job: tuple[str, dict]) -> tuple:
        input_path, options = job
        try:
            result = typst.compile(input_path, package_path=packages, package_cache_path=packages, **options)
        except Exception as exc:  # noqa: BLE001 - typst.TypstError and anything the extension raises
            return ("error", *_bounded_error(exc))
        size = sum(map(len, result)) if isinstance(result, list) else len(result)
        return ("ok", result) if size <= output_limit else ("too_large", size)

    try:
        bounded_worker.serve(conn, handle, memory_limit)
    finally:
        trap.close()


# ---- the backend's side ----------------------------------------------------------------------------


def _start() -> bounded_worker.Worker:
    packages = tempfile.mkdtemp(prefix="prism-typst-packages-")
    try:
        return bounded_worker.Worker(
            _serve,
            (packages, MEMORY_LIMIT, OUTPUT_LIMIT),
            name="prism-typst",
            cleanup=lambda: shutil.rmtree(packages, ignore_errors=True),
        )
    except BaseException:
        shutil.rmtree(packages, ignore_errors=True)
        raise


_pool = bounded_worker.Pool(_start, WORKERS)


def _stopped(code: int | None) -> PrismError:
    """Why a worker gave no reply, as the error the compile ends with."""
    if code is None or code == bounded_worker.EXIT_TIME:
        return PrismError(
            f"Typesetting took longer than {TIME_LIMIT_S:.0f} seconds and was stopped.",
            code="typst_timeout",
            hint="If a custom theme is in use, check it or switch to a shipped theme.",
        )
    if code == bounded_worker.EXIT_MEMORY:
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
    _pool.shutdown()


def compile(input_path: str, **options: Any) -> bytes | list[bytes]:
    """`typst.compile(input_path, **options)`, run in a worker. A compiler error comes back as
    `CompileError`; a compile over its budget ends as a PrismError, with its worker replaced."""
    try:
        reply = _pool.run((input_path, options), TIME_LIMIT_S)
    except bounded_worker.Stopped as stopped:
        raise _stopped(stopped.code) from None
    if reply[0] == "ok":
        return reply[1]
    if reply[0] == "too_large":
        raise PrismError(
            f"The typeset document is {reply[1] // 1024**2} MB, more than PrismLCA can show or save at once.",
            code="typst_output_too_large",
            hint="If a custom theme is in use, check it or switch to a shipped theme.",
        )
    raise CompileError(reply[1], reply[2])
