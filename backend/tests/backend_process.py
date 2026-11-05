"""The backend as the shell starts it: a child process running ``server.main``, read through its handshake.

For tests about start-up itself, which the in-process TestClient never reaches. ``frozen`` stands in for
the PyInstaller bundle (``sys.frozen``), the switch ``server.main`` reads.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

_MAIN = "from prism_lca.server import main; main()"


def spawn(
    env: dict[str, str], *, frozen: bool, prelude: str = "", cwd: Path | None = None
) -> subprocess.Popen:
    """Start the backend with ``env`` on top of a clean copy of this environment. ``prelude`` is code run
    before ``server.main`` (to stand in for part of it), ``cwd`` the working directory it starts in."""
    base = {
        k: v for k, v in os.environ.items() if not k.startswith(("PRISM_", "BRIGHTWAY", "PYTEST", "COV_"))
    }
    base.update(PYTHONPATH=os.pathsep.join(sys.path), PRISM_EMBEDDING_BACKEND="hashing")
    return subprocess.Popen(
        [sys.executable, "-c", f"import sys; sys.frozen = {frozen}\n{prelude}\n" + _MAIN],
        env={**base, **env},
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )


def wait_for_start(proc: subprocess.Popen, timeout: float = 180.0) -> tuple[dict, list[dict]]:
    """The ready or refused event, and every progress event before it."""
    progress: list[dict] = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
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
    raise AssertionError(f"no start-up event; stderr: {proc.stderr.read()[-2000:]}")


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
    """End the backend — or, for one that refused, wait for it to end by itself; its stderr."""
    if terminate and proc.poll() is None:
        proc.terminate()
    _, err = proc.communicate(timeout=60)
    return err


def snapshot(folder: Path) -> dict[str, bytes]:
    """Every file under ``folder`` with its bytes — to show a directory was left exactly as it was."""
    return {str(p.relative_to(folder)): p.read_bytes() for p in folder.rglob("*") if p.is_file()}


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
