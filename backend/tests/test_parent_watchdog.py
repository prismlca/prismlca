"""The backend self-watchdog: exit when the Electron parent process disappears."""
from __future__ import annotations

import os
import subprocess
import sys

from prism_lca.server import _pid_alive


def test_pid_alive_for_own_process():
    assert _pid_alive(os.getpid()) is True


def test_pid_alive_false_for_exited_process():
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    assert _pid_alive(p.pid) is False


# A backend that watches the given parent and reports on stderr once its watchdog runs. Its stdout is the
# pipe the shell read; the shell's death closes the reading end, so the farewell line has nowhere to go.
_WATCHED_CHILD = """
import sys, threading, time
from prism_lca.server import _watch_parent
threading.Thread(target=_watch_parent, args=(int(sys.argv[1]), 0.2), daemon=True).start()
print("watching", file=sys.stderr, flush=True)
time.sleep(120)
"""


def test_the_backend_leaves_when_its_shell_is_gone_and_took_the_output_pipe_with_it():
    # Seen on Windows: the shell had exited, the backend outlived it by minutes — the farewell print
    # raised on the dead pipe and took the watchdog thread down before it could exit.
    shell = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    backend = subprocess.Popen(
        [sys.executable, "-c", _WATCHED_CHILD, str(shell.pid)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert backend.stderr.readline().strip() == b"watching"
        backend.stdout.close()  # the shell's reading end, gone with the shell
        shell.kill()
        shell.wait()
        assert backend.wait(timeout=30) == 0
    finally:
        for p in (backend, shell):
            if p.poll() is None:
                p.kill()
                p.wait()
        backend.stderr.close()
