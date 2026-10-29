"""Backend entrypoint.

Binds to loopback on an OS-assigned free port, then prints a single-line JSON handshake
to stdout so the Electron shell learns the port + token. UTF-8 is forced because the
Windows console default encoding otherwise crashes on non-ASCII output.
"""
from __future__ import annotations

import atexit
import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

# Before anything imports huggingface_hub (prism_lca.app pulls it in through search): the hub library
# reads these once, at import. Telemetry off, so a download sends no usage headers beyond the
# library version; and no safetensors "auto_conversion" thread, which on every model load would ask
# huggingface.co for a conversion PR (and on a first download fetch a second 2.3 GB copy). Nothing
# here may talk to huggingface.co unless the user agreed to the model download.
# setdefault, so a developer can still override either from the shell.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("DISABLE_SAFETENSORS_CONVERSION", "1")

import uvicorn  # noqa: E402

from prism_lca import _log  # noqa: E402
from prism_lca.app import create_app  # noqa: E402
from prism_lca.config import get_settings  # noqa: E402


def _pid_alive(pid: int) -> bool:
    """Is the process alive? Cross-platform WITHOUT killing anything: on Windows os.kill(pid, 0)
    would TERMINATE the process (TerminateProcess semantics), so probe via OpenProcess there."""
    if sys.platform == "win32":  # pragma: no cover - exercised only on Windows
        import ctypes

        SYNCHRONIZE = 0x00100000
        WAIT_TIMEOUT = 0x00000102
        handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            return ctypes.windll.kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:  # exists but owned by someone else
        return True


def _watch_parent(pid: int, interval: float = 5.0) -> None:
    """Self-watchdog: exit when the Electron shell (our parent) is gone. A hard-killed or
    crashed shell can't run its quit handler — without this, the backend would linger with
    gigabytes of RAM and could end up sharing the Brightway project dir with a second
    instance's backend (lock conflicts, corruption risk)."""
    while True:
        time.sleep(interval)
        if not _pid_alive(pid):
            print(
                json.dumps({"event": "prism-parent-gone", "detail": f"parent {pid} vanished — exiting"}),
                flush=True,
            )
            os._exit(0)  # daemon-thread exit must not wait on uvicorn's worker threads


def _force_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8")
            except Exception as exc:  # pragma: no cover - best effort
                _log.swallowed(exc, "_force_utf8")


def _brightway_dir(settings) -> str:
    """The directory the lock guards: whatever `bootstrap` will hand to Brightway.

    Read from the environment when it is already set — the tests and a developer both override
    ``BRIGHTWAY2_DIR``, and locking the default while working in another directory would refuse a
    start for a database nobody was touching.
    """
    import os as _os

    return _os.environ.get("BRIGHTWAY2_DIR") or str(settings.data_dir / "brightway")


def _free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def main() -> None:
    _force_utf8()
    settings = get_settings()

    # One backend per data directory, before anything opens a database. Two of them write to the
    # same SQLite files and the loser gets "database is locked" at whatever moment it happens to
    # be — once, that was the write putting a scenario's overrides back after a report render, and
    # the study's baseline silently stayed the scenario. Refused here rather than survived later.
    from prism_lca.engine import instance_lock

    holder = instance_lock.acquire(_brightway_dir(settings))
    if holder is not None:
        pid = holder.get("pid")
        print(
            json.dumps(
                {
                    "event": "prism-backend-refused",
                    "reason": (
                        "Another copy of PrismLCA is already using this data directory"
                        + (f" (process {pid})" if pid else "")
                        + ". Close it and try again — two of them would overwrite each other's "
                        "parameters and scenarios."
                    ),
                    "lock": holder.get("path", ""),
                    "holder_pid": pid,
                }
            ),
            flush=True,
        )
        raise SystemExit(3)
    atexit.register(instance_lock.release)

    # The data format comes next, still before anything opens a database: a directory written by a
    # newer PrismLCA is left alone, and the shell shows the sentence.
    from prism_lca.engine import data_version

    refusal = data_version.check_and_stamp(
        [Path(settings.data_dir), Path(_brightway_dir(settings))], settings.app_version
    )
    if refusal is not None:
        print(json.dumps({"event": "prism-backend-refused", "reason": refusal}), flush=True)
        raise SystemExit(4)

    port = settings.port or _free_port(settings.host)
    app = create_app(settings)

    handshake = {
        "event": "prism-backend-ready",
        "host": settings.host,
        "port": port,
        "token": settings.auth_token,
        "version": settings.app_version,
        "pid": os.getpid(),
    }
    print(json.dumps(handshake), flush=True)

    # The Electron shell passes its PID; standalone/dev runs without it skip the watchdog.
    parent_pid = os.environ.get("PRISM_PARENT_PID")
    if parent_pid and parent_pid.isdigit():
        threading.Thread(
            target=_watch_parent, args=(int(parent_pid),), name="prism-parent-watchdog", daemon=True
        ).start()

    # timeout_keep_alive well above uvicorn's 5 s default. The client is one long-lived Electron main
    # process whose HTTP agent pools sockets, so any request that takes longer than the keep-alive
    # window leaves the pool holding connections the server has already closed — and the next call
    # picks one up and dies with "socket hang up" before sending a byte. Measured: a
    # 13.6 s parameter write, then three of six items in the very next batch lost that way. Raising
    # this removes the race rather than papering over it; the retry in the client is the second net.
    # A Server object rather than uvicorn.run(): POST /system/shutdown sets its `should_exit`, the same
    # flag SIGTERM sets, so the shell can end this process in order on Windows too (V-2).
    server = uvicorn.Server(
        uvicorn.Config(app, host=settings.host, port=port, log_level="info", timeout_keep_alive=120)
    )
    app.state.server = server
    server.run()


if __name__ == "__main__":
    main()
