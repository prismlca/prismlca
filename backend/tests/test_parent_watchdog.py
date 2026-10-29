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
