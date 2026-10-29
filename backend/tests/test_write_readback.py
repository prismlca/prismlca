"""Answer == re-read: every write answer must describe the state it left behind.

Five separately discovered defects were one defect wearing five names:
V41 (a formula write answered ``amount: 0`` while the database held the evaluated value), V97
(``carried_over.comment`` was ``false`` exactly when a comment was written), V111 (``commented:
true`` beside the comment from BEFORE the write), and the read-side siblings V85/V92. Each was
found in live use, each cost the model a round of re-checking or a wrong sentence in a
study, and each was fixed alone. This sweep closes the class where it starts: for every write
endpoint, the fields the answer names must equal what a subsequent GET returns. A new write
endpoint belongs in here the day it is added.

The tool layer has the same sweep for its own combining logic (tools.test.ts) — this one guards
the backend half, with the real engine underneath, because V41 lived exactly there.
"""
from __future__ import annotations

import uuid


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    assert r.status_code == 200, r.text
    return db


def _create(client, token, db, name, **kw) -> str:
    r = client.post(
        "/api/v1/model/activities",
        json={"database": db, "name": name, **kw},
        headers=token,
    )
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


def _exchange(client, token, db, code, uid) -> dict:
    detail = client.get(f"/api/v1/model/activities/{db}/{code}", headers=token).json()
    return next(e for e in detail["exchanges"] if e["uid"] == uid)


def _reflects(answer: dict, readback: dict, label: str, *fields: str) -> None:
    """Every named field the answer carries must equal the re-read — no stale snapshots."""
    for f in fields:
        if f in answer:
            assert answer[f] == readback.get(f), (
                f"{label}: the answer says {f}={answer[f]!r}, "
                f"but re-reading the model says {readback.get(f)!r}"
            )


def test_exchange_writes_answer_with_what_a_reread_shows(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A", unit="kg")
    b = _create(client, token, db, "B", unit="kg")

    # add
    r = client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a,
              "input_database": db, "input_code": b, "amount": 2.0},
        headers=token,
    )
    assert r.status_code == 200, r.text
    made = r.json()["exchange"]
    uid = made["uid"]
    _reflects(made, _exchange(client, token, db, a, uid), "add", "amount", "formula", "comment", "type")

    # set amount
    r = client.post(
        "/api/v1/model/exchanges/amount",
        json={"activity_database": db, "activity_code": a, "uid": uid, "amount": 5.0},
        headers=token,
    )
    assert r.status_code == 200, r.text
    _reflects(r.json()["exchange"], _exchange(client, token, db, a, uid),
              "set amount", "amount", "formula", "comment")

    # set formula — the V41 case: the answer must carry the EVALUATED amount, not a placeholder
    assert client.post(
        "/api/v1/params", json={"database": db, "name": "mass", "amount": 2.0}, headers=token
    ).status_code == 200
    r = client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": "mass * 3"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    answered = r.json()["exchange"]
    reread = _exchange(client, token, db, a, uid)
    assert reread["amount"] == 6.0  # the engine really evaluated it
    _reflects(answered, reread, "set formula", "amount", "formula", "comment")

    # set comment
    r = client.post(
        "/api/v1/model/exchanges/comment",
        json={"activity_database": db, "activity_code": a, "uid": uid,
              "comment": "why this amount has this sign"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    _reflects(r.json().get("exchange", {}), _exchange(client, token, db, a, uid),
              "set comment", "amount", "formula", "comment")


def test_parameter_writes_answer_with_what_a_reread_shows(client, token, project):
    db = _fg(client, token)

    r = client.post(
        "/api/v1/params",
        json={"database": db, "name": "density", "amount": 700.0, "unit": "kg/m3",
              "description": "assumed MDF density"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    answered = next(
        (p for p in r.json().get("parameters", []) if p.get("name") == "density"), None
    )
    assert answered is not None, r.text

    def _listed() -> dict:
        got = client.get("/api/v1/params", params={"database": db}, headers=token).json()
        rows = got.get("parameters", got) if isinstance(got, dict) else got
        return next(p for p in rows if p["name"] == "density")

    _reflects(answered, _listed(), "create parameter", "amount", "formula", "unit", "description")

    # update it — the answer must reflect the new value, not echo the old record
    r = client.post(
        "/api/v1/params",
        json={"database": db, "name": "density", "amount": 684.0},
        headers=token,
    )
    assert r.status_code == 200, r.text
    answered = next(p for p in r.json().get("parameters", []) if p.get("name") == "density")
    reread = _listed()
    assert reread["amount"] == 684.0
    _reflects(answered, reread, "update parameter", "amount", "formula", "unit", "description")


def test_scenario_and_study_writes_answer_with_what_a_reread_shows(client, token, project):
    db = _fg(client, token)
    assert client.post(
        "/api/v1/params", json={"database": db, "name": "n_cycles", "amount": 12.0}, headers=token
    ).status_code == 200

    r = client.post(
        "/api/v1/scenarios",
        json={"database": db, "name": "worst case", "description": "5 cycles",
              "overrides": {"n_cycles": 5.0}},
        headers=token,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    scenarios = body.get("scenarios", [body]) if isinstance(body, dict) else body
    answered = next(s for s in scenarios if s.get("name") == "worst case")
    listed = client.get("/api/v1/scenarios", params={"database": db}, headers=token).json()
    listed_scenarios = listed.get("scenarios", listed) if isinstance(listed, dict) else listed
    reread = next(s for s in listed_scenarios if s.get("name") == "worst case")
    _reflects(answered, reread, "create scenario", "name", "description", "overrides")

    r = client.post(
        "/api/v1/study",
        json={"database": db, "goal": "screening", "functional_unit": "1 jar"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    reread = client.get("/api/v1/study", params={"database": db}, headers=token).json()
    assert reread["goal"] == "screening"
    assert reread["functional_unit"] == "1 jar"
    answered = r.json()
    if isinstance(answered, dict):
        _reflects(answered, reread, "set study", "goal", "functional_unit")
