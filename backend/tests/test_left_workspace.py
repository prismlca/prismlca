"""A read the workspace switch falls into lets go of the left workspace once it ends (engine/left_workspace.py).

The switch's own collection is covered in test_projects.py; these are the reads that were still in the middle of
a query at that moment — their cursor keeps the connection alive through it.
"""
from __future__ import annotations

import gc
import os
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path

import pytest
from open_files import open_files_under

from prism_lca.engine import left_workspace


def _folder_is_free(folder: Path) -> bool:
    """Nothing in ``folder`` is held open: /proc says so where it can, elsewhere Windows lets it be renamed."""
    still_open = open_files_under(folder)
    if still_open is not None:
        return not still_open
    moved = folder.with_name(folder.name + ".moved")
    try:
        os.rename(folder, moved)
    except OSError:
        return False
    os.rename(moved, folder)
    return True


def _a_workspace_with_parameters(client, token) -> Path:
    from bw2data.parameters import ProjectParameter

    from prism_lca.engine.bootstrap import get_bd

    name = "crossed-" + uuid.uuid4().hex[:8]
    assert client.post("/api/v1/projects", json={"name": name}, headers=token).status_code == 200
    ProjectParameter.create(name="a", amount=1.0)
    ProjectParameter.create(name="b", amount=2.0)
    return Path(get_bd().projects.dir)


def _in_a_request(client, token, read: Callable[[], None]) -> threading.Thread:
    """``read`` as a route handler, called from a thread of its own — a request still being answered."""
    client.app.add_api_route("/api/v1/test-crossed-read", lambda: read() or {}, methods=["GET"])
    return threading.Thread(
        target=lambda: client.get("/api/v1/test-crossed-read", headers=token), daemon=True
    )


def _in_a_background_thread(_client, _token, read: Callable[[], None]) -> threading.Thread:
    return threading.Thread(target=left_workspace.reader(read), daemon=True)


@pytest.mark.parametrize("runs_in", [_in_a_request, _in_a_background_thread], ids=["request", "background"])
def test_a_read_the_switch_fell_into_lets_go_of_the_left_workspace_when_it_ends(client, token, runs_in):
    """The parameter list and the background warm-ups read without the switch's locks, so the switch can land
    in the middle of their query. Once such a read has ended, the connection it kept must close on its own,
    not at whatever collection happens to come next, which in an app with a large heap can be a long time
    away; until then Windows will not let the left workspace's folder be moved or deleted."""
    from bw2data.parameters import ProjectParameter

    folder = _a_workspace_with_parameters(client, token)
    reading, switched = threading.Event(), threading.Event()

    def read() -> None:
        rows = iter(ProjectParameter.select())  # a query under way: its cursor holds the connection
        next(rows)
        reading.set()
        assert switched.wait(60)
        list(rows)

    thread = runs_in(client, token, read)
    gc.disable()  # only the collections the code asks for may close it, not an automatic one by chance
    try:
        thread.start()
        try:
            assert reading.wait(60), "the read never started"
            r = client.post("/api/v1/projects/default/activate", headers=token)
            assert r.status_code == 200, r.text
            held = open_files_under(folder)
            if held is not None:
                assert held, "the read held nothing open across the switch, so this test would prove nothing"
        finally:
            switched.set()
            thread.join(60)
        assert not thread.is_alive(), "the read never ended"

        deadline = time.monotonic() + 10
        while not _folder_is_free(folder):
            assert time.monotonic() < deadline, f"still open after the read ended: {open_files_under(folder)}"
            time.sleep(0.05)
    finally:
        gc.enable()


def test_a_switch_is_no_crossing_for_the_request_that_makes_it(client, token, monkeypatch):
    """The request that switches is in flight while it does so; its own switch must not cost a second
    collection — the switch has collected already."""
    collections: list[str] = []
    monkeypatch.setattr(left_workspace, "_collect_soon", lambda: collections.append("asked"))

    _a_workspace_with_parameters(client, token)
    assert client.post("/api/v1/projects/default/activate", headers=token).status_code == 200
    assert collections == []

    # A switch made elsewhere while the bracket is open is one.
    with left_workspace.reading():
        other = threading.Thread(target=left_workspace._let_go, args=(None,))
        other.start()
        other.join(60)
    assert collections == ["asked"]


#: Threads that touch no workspace, and so need no bracket — with what they do instead.
_THREADS_WITHOUT_BRIGHTWAY = {
    ("server.py", "_watch_parent"): "watches the Electron shell's process",
    ("engine/bounded_worker.py", "_watch"): "watches a worker process's memory",
    ("search/model_store.py", "self._run"): "downloads the search model",
}


def test_every_thread_that_touches_brightway_lets_go_of_a_switch_it_ran_across():
    """A thread of ours that reads Brightway without the switch's locks can be in the middle of a query when the
    user switches, and nothing else would collect its connection afterwards. So every thread target goes through
    `left_workspace.reader`, unless the thread touches no workspace at all — then it is listed above."""
    import ast

    import prism_lca

    root = Path(prism_lca.__file__).parent
    unbracketed: dict[tuple[str, str], int] = {}
    for path in sorted(root.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not (isinstance(node, ast.Call) and ast.unparse(node.func) in {"threading.Thread", "Thread"}):
                continue
            target = next((kw.value for kw in node.keywords if kw.arg == "target"), None)
            assert target is not None, f"{path}:{node.lineno}: a thread without target= cannot be checked here"
            if isinstance(target, ast.Call) and ast.unparse(target.func) == "left_workspace.reader":
                continue
            unbracketed[(path.relative_to(root).as_posix(), ast.unparse(target))] = node.lineno

    missing = {key: line for key, line in unbracketed.items() if key not in _THREADS_WITHOUT_BRIGHTWAY}
    assert not missing, (
        "start these threads with target=left_workspace.reader(...), or list them above if they touch no "
        f"workspace: {missing}"
    )
    assert set(_THREADS_WITHOUT_BRIGHTWAY) <= set(unbracketed), "a listed thread is gone or bracketed now"
