"""The parameter routes do their blocking work in the threadpool, one writer at a time.

`POST /params/recalculate` was measured at 9.8–12.9 s on a real model, and it ran on the event
loop — so every other request (the report page's freshness check, the audit log, the assistant)
waited behind it. Moving that work into the threadpool is only safe as long as the writes stay
serialised, because the parameter store is SQLite and the scenario/sensitivity windows write the
same rows from their own threads. These tests pin both halves: the loop is free, and no two
writes overlap.

Nothing here waits on wall-clock time to decide whether the code is correct. Where a test has to
bound a wait, the bound is one-sided: on broken code the event it waits for arrives in
milliseconds, and on correct code it can never arrive at all, so a slow machine can only make the
test weaker, never red.
"""
from __future__ import annotations

import ast
import asyncio
import itertools
import threading
import uuid
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from prism_lca.engine import lca, params


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def _exchange(client, token, db, a, b) -> str:
    return client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db,
              "input_code": b, "amount": 0},
        headers=token,
    ).json()["exchange"]["uid"]


def _param(client, token, db, name, **body):
    return client.post("/api/v1/params", json={"database": db, "name": name, **body}, headers=token)


def _held_by_another_thread() -> bool:
    """Whether someone else holds the LCA lock. Asked from a fresh thread on purpose: the lock is
    an RLock, so the holder's own thread would always be able to take it again and answer wrongly."""
    got: list[bool] = []

    def probe() -> None:
        acquired = lca._LCA_LOCK.acquire(blocking=False)
        if acquired:
            lca._LCA_LOCK.release()  # an RLock may only be released by the thread that took it
        got.append(acquired)

    t = threading.Thread(target=probe)
    t.start()
    t.join(timeout=30)
    assert got, "the probe thread never finished"
    return not got[0]


# --------------------------------------------------------------------------- #
# The payload
# --------------------------------------------------------------------------- #
def test_recalculate_answers_what_it_always_answered(client, token, project):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200

    r = client.post(f"/api/v1/params/recalculate?database={db}", headers=token)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "ok": True,
        "parameters": client.get("/api/v1/params", params={"database": db}, headers=token).json(),
    }
    assert r.json()["parameters"][0]["name"] == "mass"

    # Without a model there is nothing to list, and the route still answers.
    assert client.post("/api/v1/params/recalculate", headers=token).json() == {"ok": True, "parameters": []}


# --------------------------------------------------------------------------- #
# Serialisation
# --------------------------------------------------------------------------- #
def test_a_recalculation_waits_for_the_lock_the_parameter_windows_hold(client, token, project, monkeypatch):
    """A scenario window writes overrides into these same rows and holds the LCA lock while it
    does. Now that the recalculation runs in a thread, that lock is the only thing keeping the two
    apart — so a recalculation must not start while it is held."""
    db = _fg(client, token)
    entered = threading.Event()
    monkeypatch.setattr(params, "recalc_database", lambda *a, **k: entered.set())

    answered: list[int] = []
    lca._LCA_LOCK.acquire()
    try:
        t = threading.Thread(
            target=lambda: answered.append(
                TestClient(client.app).post(f"/api/v1/params/recalculate?database={db}",
                                            headers=token).status_code
            )
        )
        t.start()
        # One-sided: without the lock the recalculation is reached in milliseconds.
        assert not entered.wait(1.0), "the recalculation started while the lock was held"
    finally:
        lca._LCA_LOCK.release()
    t.join(timeout=60)
    assert entered.is_set() and answered == [200]


def test_two_recalculations_never_run_at_the_same_time(client, token, project, monkeypatch):
    """Both requests are in the threadpool and past the point of no return before the first one is
    released, so the second really does contend for the gate. The assertion is on what ran, not on
    how long anything took: the tripwire fires the moment two bodies are inside, and the recorded
    order shows the second one waited for the first to finish."""
    db = _fg(client, token)
    import prism_lca.api.v1.params as params_api

    order: list[str] = []
    tripwire = threading.Lock()  # never contended if the gate works; a plain lock, so it says so
    first_inside, release = threading.Event(), threading.Event()
    at_the_gate = [threading.Event(), threading.Event()]
    nth = itertools.count()

    def recalc_all(*_a, **_k) -> None:
        assert tripwire.acquire(blocking=False), "two recalculations ran at the same time"
        try:
            order.append("enter")
            if not first_inside.is_set():
                first_inside.set()
                assert release.wait(30), "the test never released the first recalculation"
            order.append("exit")
        finally:
            tripwire.release()

    real_run_in_threadpool = params_api.run_in_threadpool

    async def announce(fn, *a, **k):
        """Announce arrival from the worker thread itself — one lock acquisition before the body."""
        i = next(nth)

        def wrapped(*aa, **kk):
            if i < len(at_the_gate):
                at_the_gate[i].set()
            return fn(*aa, **kk)

        return await real_run_in_threadpool(wrapped, *a, **k)

    monkeypatch.setattr(params, "recalc_database", recalc_all)
    monkeypatch.setattr(params_api, "run_in_threadpool", announce)

    url = f"/api/v1/params/recalculate?database={db}"
    codes: list[int] = []
    threads = [
        threading.Thread(target=lambda: codes.append(TestClient(client.app).post(url, headers=token).status_code))
        for _ in range(2)
    ]
    threads[0].start()
    assert first_inside.wait(30), "the first recalculation never started"
    threads[1].start()
    assert at_the_gate[1].wait(30), "the second request never reached the gate"
    release.set()
    for t in threads:
        t.join(timeout=60)

    assert codes == [200, 200]
    assert order == ["enter", "exit", "enter", "exit"]


def test_a_parameter_write_holds_the_lock_for_its_whole_span(client, token, project, monkeypatch):
    """Not just around the lock call: the recalculation itself must run inside it, or the window it
    is meant to exclude could start halfway through."""
    db = _fg(client, token)
    held: list[bool] = []
    real = params.recalc_database

    def recalc_all(*a, **k):
        held.append(_held_by_another_thread())
        return real(*a, **k)

    monkeypatch.setattr(params, "recalc_database", recalc_all)

    assert _param(client, token, db, "mass", amount=2.0).status_code == 200  # set_param recalculates
    assert client.post(f"/api/v1/params/recalculate?database={db}", headers=token).status_code == 200
    assert held and all(held), "the parameter store was written without the LCA lock held"


def test_only_lock_free_lca_calls_from_the_command_bus():
    """The gate is taken before the command bus's lock, which is only safe while nothing takes the
    two the other way round. The bus holds its lock across `Command.execute`, so a command that
    reached into the LCA lock — directly or through the scenario / sensitivity / Monte-Carlo
    helpers, which hold it across their whole span — would close the cycle. Anything added to this
    list has to be lock-free."""
    lock_free = {"invalidate_lca_cache", "cache_generation", "model_generation"}
    holders = {"scenarios", "sensitivity", "montecarlo", "compare", "background"}
    source = Path(lca.__file__).parent / "commands.py"
    tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))

    used = {
        node.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "lca"
    }
    imported = {
        alias.name.split(".")[-1]
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in node.names
    }
    assert not (used - lock_free), f"commands.py calls lca.{used - lock_free} — is that lock-free?"
    assert not (imported & holders), f"commands.py imports {imported & holders}, which hold the LCA lock"


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #
def test_a_cheap_request_is_answered_while_a_recalculation_is_in_flight(
    client, token, project, monkeypatch
):
    """The honest form of "the loop is free": a second endpoint answers while the recalculation is
    still inside its own body. One event loop for both requests, so there is nowhere else for the
    cheap one to have been served from."""
    db = _fg(client, token)
    inside = threading.Event()
    release = threading.Event()
    left = threading.Event()

    def recalc_all(*_a, **_k) -> None:
        inside.set()
        release.wait(20)
        left.set()

    monkeypatch.setattr(params, "recalc_database", recalc_all)

    async def drive() -> None:
        transport = httpx.ASGITransport(app=client.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://prism") as ac:
            slow = asyncio.create_task(
                ac.post(f"/api/v1/params/recalculate?database={db}", headers=token, timeout=60)
            )
            await asyncio.to_thread(inside.wait, 20)
            assert inside.is_set(), "the recalculation never started"

            cheap = await ac.get("/api/v1/params/groups", params={"database": db}, headers=token)
            assert cheap.status_code == 200, cheap.text
            # The recalculation is STILL in its body — so the loop answered while it was blocked,
            # rather than after it finished.
            assert not left.is_set(), "the recalculation had already returned"

            release.set()
            r = await slow
            assert r.status_code == 200, r.text

    asyncio.run(drive())


# --------------------------------------------------------------------------- #
# Every route that moved still does its job
# --------------------------------------------------------------------------- #
def test_listing_parameters_with_usage_still_reports_the_blast_radius(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    ).status_code == 200

    plain = client.get("/api/v1/params", params={"database": db}, headers=token).json()
    assert [p["name"] for p in plain] == ["mass"] and "used_by" not in plain[0]
    with_usage = client.get(
        "/api/v1/params", params={"database": db, "with_usage": True}, headers=token
    ).json()
    assert with_usage[0]["used_by_count"] == 1
    assert with_usage[0]["used_by"][0]["uid"] == uid


def test_setting_a_parameter_still_writes_the_value_and_the_dependent_amount(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    ).json()["exchange"]["amount"] == 6.0

    r = _param(client, token, db, "mass", amount=5.0)
    assert r.status_code == 200, r.text
    assert next(p["amount"] for p in r.json()["parameters"] if p["name"] == "mass") == 5.0
    d = client.get(f"/api/v1/model/activities/{db}/{a}", headers=token).json()
    assert next(e["amount"] for e in d["exchanges"] if e["uid"] == uid) == 15.0


def test_deleting_a_parameter_still_removes_it(client, token, project):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    r = client.post("/api/v1/params/delete", json={"database": db, "name": "mass"}, headers=token)
    assert r.status_code == 200 and r.json() == {"deleted": "mass"}
    assert client.get("/api/v1/params", params={"database": db}, headers=token).json() == []


def test_clearing_an_exchange_formula_still_detaches_it(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    uid = _exchange(client, token, db, a, b)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    ).status_code == 200

    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": None},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert not r.json()["exchange"].get("formula")
    assert _param(client, token, db, "mass", amount=9.0).status_code == 200
    d = client.get(f"/api/v1/model/activities/{db}/{a}", headers=token).json()
    assert next(e["amount"] for e in d["exchanges"] if e["uid"] == uid) == 6.0  # no longer driven


def test_the_group_routes_still_create_rename_assign_and_delete(client, token, project):
    db = _fg(client, token)
    assert _param(client, token, db, "mass", amount=2.0).status_code == 200

    created = client.post("/api/v1/params/groups", json={"database": db, "name": "Yields"}, headers=token)
    assert created.status_code == 200, created.text
    gid = created.json()["group"]["id"]

    renamed = client.post(
        "/api/v1/params/groups/rename", json={"database": db, "id": gid, "name": "Masses"}, headers=token
    )
    assert [g["name"] for g in renamed.json()["groups"]] == ["Masses"]

    assigned = client.post(
        "/api/v1/params/group", json={"database": db, "name": "mass", "group_id": gid}, headers=token
    )
    assert next(p["group"] for p in assigned.json()["parameters"] if p["name"] == "mass") == "Masses"

    deleted = client.post("/api/v1/params/groups/delete", json={"database": db, "id": gid}, headers=token)
    assert deleted.status_code == 200 and deleted.json()["groups"] == []
    # The parameter survives the group, un-assigned.
    listed = client.get("/api/v1/params", params={"database": db}, headers=token).json()
    assert listed[0]["name"] == "mass" and listed[0]["group_id"] is None
