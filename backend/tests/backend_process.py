"""The backend as the shell starts it: a child process running ``server.main``, read through its handshake.

For tests about start-up itself, which the in-process TestClient never reaches. ``frozen`` stands in for
the PyInstaller bundle (``sys.frozen``), the switch ``server.main`` reads.

Both pipes are read on threads of their own from the moment the child starts: a blocking ``readline`` on
the test's thread would let a silent child hold the test past every deadline, and a child that fills its
stderr pipe while nobody reads it stalls. Read the child's output through :func:`next_line` and end it with
:func:`stop`, never through ``proc.stdout`` or ``communicate``.
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

_MAIN = "from prism_lca.server import main; main()"


class _Drain:
    """The child's stdout as a queue of lines (``None`` once it closes) and its stderr as collected text."""

    def __init__(self, proc: subprocess.Popen) -> None:
        self.lines: queue.Queue[str | None] = queue.Queue()
        self._err: list[str] = []
        self._threads = [
            threading.Thread(target=self._pump_out, args=(proc.stdout,), daemon=True),
            threading.Thread(target=self._pump_err, args=(proc.stderr,), daemon=True),
        ]
        for t in self._threads:
            t.start()

    def _pump_out(self, pipe) -> None:
        for line in pipe:
            self.lines.put(line)
        self.lines.put(None)

    def _pump_err(self, pipe) -> None:
        for line in pipe:
            self._err.append(line)

    def stderr(self) -> str:
        return "".join(self._err)

    def join(self, timeout: float) -> None:
        for t in self._threads:
            t.join(timeout)


_drains: dict[subprocess.Popen, _Drain] = {}


def spawn(
    env: dict[str, str], *, frozen: bool, prelude: str = "", cwd: Path | None = None
) -> subprocess.Popen:
    """Start the backend with ``env`` on top of a clean copy of this environment. ``prelude`` is code run
    before ``server.main`` (to stand in for part of it), ``cwd`` the working directory it starts in."""
    base = {
        k: v for k, v in os.environ.items() if not k.startswith(("PRISM_", "BRIGHTWAY", "PYTEST", "COV_"))
    }
    base.update(PYTHONPATH=os.pathsep.join(sys.path), PRISM_EMBEDDING_BACKEND="hashing")
    proc = subprocess.Popen(
        [sys.executable, "-c", f"import sys; sys.frozen = {frozen}\n{prelude}\n" + _MAIN],
        env={**base, **env},
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    _drains[proc] = _Drain(proc)
    return proc


def next_line(proc: subprocess.Popen, timeout: float) -> str | None:
    """The child's next line of stdout, ``None`` once it has closed it; fails after ``timeout`` seconds."""
    try:
        return _drains[proc].lines.get(timeout=max(timeout, 0))
    except queue.Empty:
        raise AssertionError(
            f"no output within {timeout:.0f}s; stderr: {_drains[proc].stderr()[-2000:]}"
        ) from None


def wait_for_start(proc: subprocess.Popen, timeout: float = 180.0) -> tuple[dict, list[dict]]:
    """The ready or refused event, and every progress event before it."""
    progress: list[dict] = []
    deadline = time.monotonic() + timeout
    # The deadline is checked on every line: next_line alone would keep handing out queued output, so a
    # child that talks without ever announcing itself would run on past it.
    while (remaining := deadline - time.monotonic()) > 0:
        line = next_line(proc, remaining)
        if line is None:
            break
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if not isinstance(msg, dict):
            continue
        if msg.get("event") == "prism-backend-progress":
            progress.append(msg)
        elif msg.get("event", "").startswith("prism-backend-"):
            return msg, progress
    raise AssertionError(f"no start-up event within {timeout:.0f}s; stderr: {_drains[proc].stderr()[-2000:]}")


def get(ready: dict, path: str, wait: float = 60.0):
    """GET with the token, retrying while uvicorn is not yet listening (the handshake comes first)."""
    req = urllib.request.Request(
        f"http://{ready['host']}:{ready['port']}{path}", headers={"X-Prism-Token": ready["token"]}
    )
    end = time.monotonic() + wait
    while True:
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read())
        except urllib.error.URLError:
            if time.monotonic() > end:
                raise
            time.sleep(0.3)


def stop(proc: subprocess.Popen, *, terminate: bool = True) -> str:
    """End the backend — or, for one that refused, wait for it to end by itself; its stderr. A child still
    running after a minute is killed, so a failing test leaves no process behind."""
    if terminate and proc.poll() is None:
        proc.terminate()
    try:
        proc.wait(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)
        raise
    finally:
        drain = _drains.pop(proc)
        drain.join(timeout=10)
    return drain.stderr()


def snapshot(folder: Path) -> dict[str, bytes]:
    """Every file under ``folder`` with its bytes — to show a directory was left exactly as it was."""
    return {p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file()}


#: Settings a ``.env`` in the backend's working directory would set, were it read.
DOTENV_VALUES = {
    "PRISM_AUTH_TOKEN": "token-from-file",
    "PRISM_PORT": "4321",
    "PRISM_EMBEDDING_BACKEND": "openrouter",
    "PRISM_OPENROUTER_BASE_URL": "http://example.invalid/api/v1",
}


def dotenv_folder(folder: Path) -> Path:
    """``folder``, created, with a ``.env`` holding :data:`DOTENV_VALUES`."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / ".env").write_text("".join(f"{k}={v}\n" for k, v in DOTENV_VALUES.items()), encoding="utf-8")
    return folder
