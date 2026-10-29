"""The model's reference process, derived rather than guessed.

Two features used to pick an arbitrary activity: a new report titled itself after an end-of-life
sub-process and reported on it, and the results view pre-selected every foreground process at once so
packaging components were compared with each other. Both now ask for the root of the tree, so the rule
lives here once.
"""
from __future__ import annotations

import uuid


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def _edge(client, token, db, consumer, supplier, amount=1.0) -> None:
    client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": consumer, "input_database": db,
              "input_code": supplier, "amount": amount},
        headers=token,
    )


def _candidates(client, token, db) -> list[dict]:
    r = client.get(f"/api/v1/model/reference/{db}", headers=token)
    assert r.status_code == 200
    return r.json()["candidates"]


def test_the_process_nothing_consumes_comes_first(client, token, project):
    db = _fg(client, token)
    product = _create(client, token, db, "Apple juice, in 1 L glass bottle, at retail")
    bottle = _create(client, token, db, "Glass bottle, 1 L")
    eol = _create(client, token, db, "End-of-life — glass bottle")
    _edge(client, token, db, product, bottle)
    _edge(client, token, db, product, eol)

    cands = _candidates(client, token, db)
    assert cands[0]["code"] == product
    assert cands[0]["name"].startswith("Apple juice")
    assert cands[0]["is_root"] is True
    # The consumed sub-processes are still offered, so the user can pick one deliberately.
    assert {c["code"] for c in cands} >= {product}
    assert all(c["is_root"] for c in cands)  # only roots are listed while a root exists


def test_several_roots_are_ranked_by_what_they_pull_in(client, token, project):
    db = _fg(client, token)
    big = _create(client, token, db, "Zebra product")  # last alphabetically, most inputs
    small = _create(client, token, db, "Alpha product")
    part_a = _create(client, token, db, "Part A")
    part_b = _create(client, token, db, "Part B")
    _edge(client, token, db, big, part_a)
    _edge(client, token, db, big, part_b)
    _edge(client, token, db, small, part_a)

    cands = _candidates(client, token, db)
    assert [c["code"] for c in cands[:2]] == [big, small]


def test_a_cycle_still_yields_a_best_guess(client, token, project):
    db = _fg(client, token)
    a = _create(client, token, db, "A")
    b = _create(client, token, db, "B")
    _edge(client, token, db, a, b)
    _edge(client, token, db, b, a)  # nothing is a root

    cands = _candidates(client, token, db)
    assert len(cands) == 2
    assert all(c["is_root"] is False for c in cands)


def test_a_single_process_is_its_own_reference(client, token, project):
    db = _fg(client, token)
    only = _create(client, token, db, "Only")
    assert [c["code"] for c in _candidates(client, token, db)] == [only]


def test_a_stated_reference_quantity_is_the_reference_whatever_else_hangs_free(client, token, project):
    """The divider on top says which process is the functional unit; a leftover that pulls in more
    must not be calculated, reported or named by the health check in its place."""
    db = _fg(client, token)
    product = _create(client, token, db, "Inverter, per installation")
    _edge(client, token, db, product, _create(client, token, db, "Housing"))
    leftover = _create(client, token, db, "Leftover draft")
    for part in ("P1", "P2", "P3"):
        _edge(client, token, db, leftover, _create(client, token, db, part))
    r = client.post("/api/v1/params", json={"database": db, "name": "lifetime_energy", "amount": 11000.0},
                    headers=token)
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/model/reference-quantity",
        json={"database": db, "code": product, "parameter": "lifetime_energy",
              "name": "Electricity, per kWh", "unit": "kilowatt hour"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    divider = r.json()["activity"]["code"]

    assert _candidates(client, token, db)[0]["code"] == divider
    loose = [f for f in client.get(f"/api/v1/model/health/{db}", headers=token).json()["findings"]
             if f["code"] == "disconnected_process"]
    assert [f["activity"]["code"] for f in loose] == [leftover]
    assert "'Electricity, per kWh'" in loose[0]["message"]

