"""The sealed backend (prism_lca/seal.py): with PRISM_SEALED set, lookups and connections to other computers
are refused and written down, this computer stays reachable, spawned workers are sealed too, and an
installed (frozen) backend ignores the variable.

An audit hook cannot be removed again, so every sealed check runs in a process of its own. The remote names
are under .invalid, so a seal that failed would ask for a name that cannot exist rather than reach a server.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

import prism_lca
from prism_lca.seal import is_loopback, sealed

SRC = str(Path(prism_lca.__file__).resolve().parents[1])


def _run(tmp_path: Path, script: str, *, seal: bool = True) -> tuple[subprocess.CompletedProcess, list]:
    log = tmp_path / "sealed.jsonl"
    env = {
        k: v
        for k, v in os.environ.items()
        if k.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "prism_sealed")
    }
    env["PYTHONPATH"] = SRC
    if seal:
        env["PRISM_SEALED"] = str(log)
    path = tmp_path / "check.py"
    path.write_text(textwrap.dedent(script), encoding="utf-8")
    done = subprocess.run(
        [sys.executable, str(path)], env=env, cwd=tmp_path, capture_output=True, text=True, timeout=120
    )
    lines = (
        [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
        if log.exists()
        else []
    )
    return done, lines


def test_sealed_process_refuses_remote_lookups_and_connections_and_logs_each(tmp_path: Path) -> None:
    done, lines = _run(
        tmp_path,
        """
        import socket

        import httpx

        from prism_lca import seal

        print("sealed", seal.sealed())
        try:
            socket.getaddrinfo("news.example.invalid", 443)
            print("lookup WENT OUT")
        except socket.gaierror:
            print("lookup refused")
        s = socket.socket()
        try:
            s.connect(("192.0.2.1", 80))
            print("connect WENT OUT")
        except ConnectionRefusedError:
            print("connect refused")
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            u.sendto(b"x", ("192.0.2.53", 53))
            print("sendto WENT OUT")
        except ConnectionRefusedError:
            print("sendto refused")
        try:
            httpx.get("https://feed.example.invalid/feed.xml", timeout=5)
            print("httpx WENT OUT")
        except httpx.ConnectError:
            print("httpx refused")
        srv = socket.create_server(("127.0.0.1", 0))
        with socket.create_connection(("localhost", srv.getsockname()[1]), timeout=5):
            print("loopback open")
        """,
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.split("\n")[:6] == [
        "sealed True",
        "lookup refused",
        "connect refused",
        "sendto refused",
        "httpx refused",
        "loopback open",
    ]
    assert lines[0]["kind"] == "sealed" and lines[0]["outcome"] == "in place"
    assert lines[0]["proc"] == "backend"
    refused = [(e["target"], e["via"]) for e in lines[1:]]
    assert refused == [
        ("news.example.invalid:443", "socket.getaddrinfo"),
        ("192.0.2.1:80", "socket.connect"),
        ("192.0.2.53:53", "socket.sendto"),
        ("feed.example.invalid:443", "socket.getaddrinfo"),
    ]
    assert all(e["kind"] == "network" and e["outcome"] == "refused" for e in lines[1:])
    assert "[sealed] refused: network 192.0.2.1:80" in done.stderr


def test_a_spawned_worker_is_sealed_too(tmp_path: Path) -> None:
    done, lines = _run(
        tmp_path,
        """
        import multiprocessing

        from prism_lca import seal

        if __name__ == "__main__":
            with multiprocessing.get_context("spawn").Pool(1) as pool:
                print("worker sealed", pool.apply(seal.sealed))
        """,
    )
    assert done.returncode == 0, done.stderr
    assert "worker sealed True" in done.stdout
    assert len({e["pid"] for e in lines if e["kind"] == "sealed"}) == 2


def test_without_the_variable_nothing_is_sealed(tmp_path: Path) -> None:
    done, lines = _run(
        tmp_path,
        """
        import socket

        from prism_lca import seal

        print("sealed", seal.sealed())
        # A numeric address is not looked up anywhere: unsealed, it simply resolves.
        print("resolved", socket.getaddrinfo("192.0.2.1", 80)[0][4][0])
        """,
        seal=False,
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.split("\n")[:2] == ["sealed False", "resolved 192.0.2.1"]
    assert lines == []
    assert not sealed()  # nor is the test process


def test_an_installed_backend_ignores_the_variable(tmp_path: Path) -> None:
    done, lines = _run(
        tmp_path,
        """
        import sys

        sys.frozen = True  # what PyInstaller sets in the installed backend

        from prism_lca import seal

        print("sealed", seal.sealed())
        """,
    )
    assert done.returncode == 0, done.stderr
    assert "sealed False" in done.stdout
    assert lines == []
    assert "an installed one ignores it" in done.stderr


@pytest.mark.parametrize(
    ("host", "local"),
    [
        (None, True),
        ("", True),
        ("localhost", True),
        ("LOCALHOST.", True),
        ("127.0.0.1", True),
        ("127.8.9.10", True),
        ("::1", True),
        ("[::1]", True),
        ("::ffff:127.0.0.1", True),
        ("0.0.0.0", True),
        (b"127.0.0.1", True),
        ("prismlca.com", False),
        ("localhost.example.com", False),
        ("192.0.2.1", False),
        ("::ffff:192.0.2.1", False),
        ("2001:db8::1", False),
        (12345, False),
    ],
)
def test_is_loopback(host: object, local: bool) -> None:
    assert is_loopback(host) is local
