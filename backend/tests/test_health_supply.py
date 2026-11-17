"""The same dataset taken twice by one process: separate uses stay a note, an input entered twice warns.

Two exchanges from one dataset compute like one with their sum. That is right for separate uses and twice
too much for an input entered twice — and the two look alike except in what computes: an input entered
twice has the same amount and no formula of its own. The cases are the ones runs produced: a link added
again (1 and 1), an edit that added copies beside the originals (same formula on both), and the counter-case
of two ingredients on one proxy whose formulas read different shares that happen to be equal.
"""
from __future__ import annotations

import uuid

from prism_lca.engine.model import get_activity


def _fg(client, token) -> str:
    db = "fg-" + uuid.uuid4().hex[:6]
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _create(client, token, db, name) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def _edge(client, token, db, a, b, amount=1.0) -> str:
    return client.post(
        "/api/v1/model/exchanges",
        json={"activity_database": db, "activity_code": a, "input_database": db, "input_code": b, "amount": amount},
        headers=token,
    ).json()["exchange"]["uid"]


def _param(client, token, db, name, amount) -> None:
    assert client.post(
        "/api/v1/params", json={"database": db, "name": name, "amount": amount}, headers=token
    ).status_code == 200


def _formula(client, token, db, a, uid, formula) -> None:
    assert client.post(
        "/api/v1/params/exchange-formula",
        json={"activity_database": db, "activity_code": a, "uid": uid, "formula": formula},
        headers=token,
    ).status_code == 200


def _comment(client, token, db, a, uid, comment) -> None:
    assert client.post(
        "/api/v1/model/exchanges/comment",
        json={"activity_database": db, "activity_code": a, "uid": uid, "comment": comment},
        headers=token,
    ).status_code == 200


def _health(client, token, db) -> dict:
    return client.get(f"/api/v1/model/health/{db}", headers=token).json()


def _found(health, code) -> list[dict]:
    return [f for f in health["findings"] if f["code"] == code]


def test_a_link_added_again_with_the_same_amount_warns(client, token, project):
    """A run hung its final assembly under distribution a second time, 1 and 1: the result doubled, and the
    info that said so was read past."""
    db = _fg(client, token)
    sales, assembly = _create(client, token, db, "Distribution"), _create(client, token, db, "Final assembly")
    first = _edge(client, token, db, sales, assembly, 1.0)
    second = _edge(client, token, db, sales, assembly, 1.0)

    h = _health(client, token, db)
    found = _found(h, "identical_duplicate_input")
    assert len(found) == 1, [f["code"] for f in h["findings"]]
    assert found[0]["severity"] == "warning"
    assert found[0]["uids"] == [first, second]
    assert found[0]["uid"] == first
    assert "entered twice" in found[0]["message"] and "twice" in found[0]["message"]
    # One finding for one pair: not a warning and a note on top of it.
    assert not _found(h, "duplicate_input")
    # A warning, not an error: two equal uses are possible, and `ok` speaks only of errors.
    assert h["ok"] is True and h["summary"]["warning"] == 1


def test_copies_with_the_same_formula_warn_even_with_their_own_comments(client, token, project):
    """An edit meant to change fourteen exchanges added fourteen beside them: the same formulas, comments
    rewritten in some pairs and kept in others. A comment cannot be what tells them apart — every exchange a
    model writes has one."""
    db = _fg(client, token)
    _param(client, token, db, "frame_kg", 7.0)
    shelf, steel = _create(client, token, db, "Shelf frame"), _create(client, token, db, "Steel")
    old = _edge(client, token, db, shelf, steel, 7.0)
    new = _edge(client, token, db, shelf, steel, 7.0)
    _formula(client, token, db, shelf, old, "frame_kg")
    _formula(client, token, db, shelf, new, "1 * frame_kg")
    _comment(client, token, db, shelf, old, "Hot-rolled strip for the frame, 7 kg.")
    _comment(client, token, db, shelf, new, "Steel strip per frame (parameter frame_kg).")

    found = _found(_health(client, token, db), "identical_duplicate_input")
    assert len(found) == 1 and found[0]["severity"] == "warning"
    assert sorted(found[0]["uids"]) == sorted([old, new])


def test_a_formula_and_the_number_it_equals_warn(client, token, project):
    """The old exchange typed, the copy with a formula: nothing that computes tells them apart. A formula that
    is only a number reads no parameter, so it counts as the number."""
    db = _fg(client, token)
    _param(client, token, db, "box_kg", 0.8)
    a, box, metal = _create(client, token, db, "Shipping"), _create(client, token, db, "Box"), _create(
        client, token, db, "Metal working"
    )
    typed = _edge(client, token, db, a, box, 0.8)
    _formula(client, token, db, a, _edge(client, token, db, a, box, 0.8), "box_kg")
    _edge(client, token, db, a, metal, 1.0)
    _formula(client, token, db, a, _edge(client, token, db, a, metal, 1.0), "1")

    found = _found(_health(client, token, db), "identical_duplicate_input")
    assert len(found) == 2, found
    assert typed in found[0]["uids"] + found[1]["uids"]


def test_two_shares_that_happen_to_be_equal_stay_a_note(client, token, project):
    """Perfume and preservative on one proxy dataset, 0.00255 kg each: the formulas read different shares,
    and a scenario on either moves them apart. That is two uses, not one entered twice."""
    db = _fg(client, token)
    _param(client, token, db, "fill_kg", 0.51)
    _param(client, token, db, "share_perfume", 0.005)
    _param(client, token, db, "share_preservative", 0.005)
    soap, proxy = _create(client, token, db, "Formulation"), _create(client, token, db, "Organic chemical")
    _formula(client, token, db, soap, _edge(client, token, db, soap, proxy, 1.0), "fill_kg * share_perfume")
    _formula(client, token, db, soap, _edge(client, token, db, soap, proxy, 1.0), "fill_kg * share_preservative")

    h = _health(client, token, db)
    assert not _found(h, "identical_duplicate_input")
    note = _found(h, "duplicate_input")
    assert len(note) == 1 and note[0]["severity"] == "info"


def test_only_the_equal_pair_of_three_warns(client, token, project):
    db = _fg(client, token)
    a, b = _create(client, token, db, "A"), _create(client, token, db, "B")
    first = _edge(client, token, db, a, b, 1.0)
    _edge(client, token, db, a, b, 2.0)
    third = _edge(client, token, db, a, b, 1.0)

    h = _health(client, token, db)
    found = _found(h, "identical_duplicate_input")
    assert len(found) == 1 and found[0]["uids"] == [first, third]
    assert "twice" in found[0]["message"]
    assert not _found(h, "duplicate_input")


def test_a_treatment_taken_twice_with_the_same_amount_warns(client, token, project):
    """The copies in that run included four end-of-life treatments; a negative pair is no credit pair."""
    db = _fg(client, token)
    a, t = _create(client, token, db, "End of life"), _create(client, token, db, "Incineration")
    act = get_activity(db, t)
    for ex in act.exchanges():
        if ex.get("type") == "production":
            ex["amount"] = -1.0
            ex.save()
    _edge(client, token, db, a, t, -0.1056)
    _edge(client, token, db, a, t, -0.1056)

    found = _found(_health(client, token, db), "identical_duplicate_input")
    assert len(found) == 1 and found[0]["severity"] == "warning"


def test_different_amounts_and_an_add_and_credit_pair_stay_quiet(client, token, project):
    db = _fg(client, token)
    a, b, c = _create(client, token, db, "A"), _create(client, token, db, "B"), _create(client, token, db, "C")
    _edge(client, token, db, a, b, 1.3)
    _edge(client, token, db, a, b, 7.8)
    _edge(client, token, db, a, c, 1.0)
    _edge(client, token, db, a, c, -1.0)

    h = _health(client, token, db)
    assert not _found(h, "identical_duplicate_input")
    assert len(_found(h, "duplicate_input")) == 1


def test_a_typed_figure_does_not_join_two_shares_into_one_set(client, token, project):
    """A typed figure equal to two shares matches each of them, but the shares stay apart: two pairs, each
    with one share, never one input entered three times."""
    db = _fg(client, token)
    _param(client, token, db, "fill_kg", 0.51)
    _param(client, token, db, "share_perfume", 0.005)
    _param(client, token, db, "share_preservative", 0.005)
    soap, proxy = _create(client, token, db, "Formulation"), _create(client, token, db, "Organic chemical")
    perfume = _edge(client, token, db, soap, proxy, 1.0)
    _formula(client, token, db, soap, perfume, "fill_kg * share_perfume")
    typed = _edge(client, token, db, soap, proxy, 0.00255)
    preservative = _edge(client, token, db, soap, proxy, 1.0)
    _formula(client, token, db, soap, preservative, "fill_kg * share_preservative")

    found = _found(_health(client, token, db), "identical_duplicate_input")
    assert [f["uids"] for f in found] == [[perfume, typed], [typed, preservative]]
    assert all("twice" in f["message"] for f in found)


def test_a_copy_inside_a_mix_still_warns(client, token, project):
    """Two datasets supplying one product are judged as a mix or a replacement; a copy of one of them still
    counts double, and the mix's own note must not hide it."""
    from prism_lca.engine.bootstrap import get_bd

    db = _fg(client, token)
    consumer = _create(client, token, db, "Glycerine supply")
    bd = get_bd()
    for code, name in (("gly-syn", "glycerine, synthetic"), ("gly-veg", "glycerine, vegetable")):
        act = bd.Database(db).new_activity(code=code, name=name, unit="kilogram", location="RER")
        act["reference product"] = "glycerine"
        act["type"] = "process"
        act.save()
        prod = act.new_edge(input=act, amount=1.0, type="production")
        prod["prism_uid"] = code + "-prod"
        prod.save()
    syn = _edge(client, token, db, consumer, "gly-syn", 0.33)
    veg = _edge(client, token, db, consumer, "gly-veg", 0.67)
    copy = _edge(client, token, db, consumer, "gly-syn", 0.33)
    for uid, text in ((syn, "Petrochemical share."), (veg, "Rape-oil share."), (copy, "Petrochemical share.")):
        _comment(client, token, db, consumer, uid, text)

    h = _health(client, token, db)
    found = _found(h, "identical_duplicate_input")
    assert len(found) == 1 and found[0]["uids"] == [syn, copy]
    # The mix is still judged as before (every exchange commented), next to the warning.
    assert len(_found(h, "deliberate_mix")) == 1
    assert not _found(h, "duplicate_input")
