"""The backend as the shell starts it: the socket it serves on and the handshake it prints (server.main)."""
from __future__ import annotations

import json
import socket

import pytest
from backend_process import dotenv_folder, spawn, stop, wait_for_start

#: Stands in for uvicorn's serving loop: reports the sockets it was handed and keeps them, so the test sees
#: the port in the state the shell finds it in when it reads the handshake.
_REPORT_SOCKETS = """
import json, socket, threading, uvicorn
def _run(self, sockets=None):
    socks = sockets or []
    print(json.dumps({
        "event": "test-serving",
        "ports": [s.getsockname()[1] for s in socks],
        "listening": [s.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) for s in socks],
    }), flush=True)
    threading.Event().wait()
uvicorn.Server.run = _run
"""


@pytest.fixture(scope="module")
def started(tmp_path_factory):
    """The backend from source, started in a folder with a ``.env`` of its own."""
    root = tmp_path_factory.mktemp("start")
    proc = spawn(
        {"PRISM_DATA_DIR": str(root / "data")},
        frozen=False,
        prelude=_REPORT_SOCKETS,
        cwd=dotenv_folder(root / "folder"),
    )
    try:
        ready, _ = wait_for_start(proc)
        assert ready["event"] == "prism-backend-ready", ready
        yield ready, proc
    finally:
        stop(proc)


def test_the_announced_port_is_already_held_and_served_from_that_socket(started):
    ready, proc = started
    other = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    other.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        with pytest.raises(OSError):
            other.bind((ready["host"], ready["port"]))
            other.listen()
    finally:
        other.close()
    serving = json.loads(proc.stdout.readline())
    assert serving == {"event": "test-serving", "ports": [ready["port"]], "listening": [1]}


def test_the_handshake_does_not_come_from_a_dotenv_in_the_working_directory(started):
    ready, _ = started
    assert ready["token"] != "token-from-file"
    assert ready["port"] != 4321
    assert ready["host"] == "127.0.0.1"
