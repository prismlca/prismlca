"""A sealed instance: no name lookup and no connection of this process leaves the computer, and each one
that tried is written down.

The switch is ``PRISM_SEALED``, the path of a log file. The Electron shell sets it for a driven test instance
run from source (``control-prism launch --sealed``) and seals its own side the same way (frontend
``main/seal/``); both append one JSON object per line to that file. A frozen (installed) backend ignores the
variable, so an installed app is never sealed by accident.

Python's audit hooks see every lookup and connection of the socket module — and with it every HTTP library
written in Python (httpx, requests, urllib3). They cannot be removed once added. Native code that opens its
own sockets does not pass through them; for that the shell points the proxy variables of a sealed instance at
a loopback trap that refuses and logs what honours them. This computer stays open: the shell's connection to
the backend, the backend's workers, the trap.

Installed from the package's ``__init__``: every process that runs our code imports the package first, the
server and the workers it spawns alike, and the variable reaches the workers through the environment.
"""

from __future__ import annotations

import errno
import ipaddress
import json
import os
import socket
import sys
import threading
from datetime import UTC, datetime

SEAL_ENV = "PRISM_SEALED"

_TARGET_CHARS = 500
_LOOKUPS = ("socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "socket.getnameinfo")
_SENDS = ("socket.connect", "socket.sendto", "socket.sendmsg")
_IP_FAMILIES = (socket.AF_INET, socket.AF_INET6)

_lock = threading.Lock()
_log_path: str | None = None


def sealed() -> bool:
    """Whether this process has its seal in place."""
    return _log_path is not None


def is_loopback(host: object) -> bool:
    """Whether ``host`` is this computer: ``localhost``, 127.0.0.0/8, ::1 (also IPv4-mapped), unspecified."""
    if host is None:
        return True  # a passive lookup: this computer's own addresses
    if isinstance(host, (bytes, bytearray)):
        host = bytes(host).decode("ascii", "replace")
    if not isinstance(host, str):
        return False
    name = host.strip("[]").rstrip(".").lower()
    if name in ("", "localhost"):
        return True
    try:
        ip = ipaddress.ip_address(name.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_unspecified


def _write(kind: str, target: str, via: str, outcome: str = "refused") -> None:
    if _log_path is None:
        return
    if len(target) > _TARGET_CHARS:
        target = target[:_TARGET_CHARS] + "…"
    entry = {
        "at": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "proc": "backend",
        "pid": os.getpid(),
        "kind": kind,
        "target": target,
        "via": via,
        "outcome": outcome,
    }
    with _lock:
        try:
            with open(_log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
        except OSError as exc:
            print(f"[sealed] could not write {_log_path}: {exc}", file=sys.stderr, flush=True)
    # stderr: stdout carries the handshake to the shell.
    print(f"[sealed] {outcome}: {kind} {target} ({via})", file=sys.stderr, flush=True)


def _address_text(address: object) -> str:
    if isinstance(address, tuple) and len(address) >= 2:
        return f"{address[0]}:{address[1]}"
    return str(address)


def _hook(event: str, args: tuple) -> None:
    if not event.startswith("socket."):
        return
    if event in _LOOKUPS:
        # getaddrinfo(host, port, …), gethostbyname(name), gethostbyaddr(ip), getnameinfo((host, port), …)
        first = args[0] if args else None
        host = first[0] if isinstance(first, tuple) and first else first
        if is_loopback(host):
            return
        port = f":{args[1]}" if event == "socket.getaddrinfo" and len(args) > 1 and args[1] else ""
        _write("network", f"{host}{port}", event)
        raise socket.gaierror(socket.EAI_NONAME, f"{host}: refused by the sealed instance")
    if event in _SENDS and len(args) >= 2:
        sock, address = args[0], args[1]
        if getattr(sock, "family", None) not in _IP_FAMILIES or address is None:
            return
        host = address[0] if isinstance(address, tuple) and address else address
        if is_loopback(host):
            return
        _write("network", _address_text(address), event)
        raise ConnectionRefusedError(
            errno.ECONNREFUSED, f"{_address_text(address)}: refused by the sealed instance"
        )


def install_from_env() -> None:
    """Seal this process when ``PRISM_SEALED`` names a log and the backend runs from source. Once only."""
    global _log_path
    path = os.environ.get(SEAL_ENV, "").strip()
    if not path or _log_path is not None:
        return
    if getattr(sys, "frozen", False):
        print(
            f"[sealed] {SEAL_ENV} is for a backend run from source; an installed one ignores it",
            file=sys.stderr,
        )
        return
    _log_path = path
    sys.addaudithook(_hook)
    _write("sealed", "Python name lookups and connections", "audit hook", "in place")
