"""A substance number in a query (search/identifiers.py): the datasets carrying it lead, nothing else moves."""

from __future__ import annotations

import uuid

import pytest

from prism_lca.engine.backgrounds import common
from prism_lca.engine.bootstrap import get_bd
from prism_lca.search.identifiers import Found, normalise


@pytest.mark.parametrize(("written", "number"), [
    ("1310-73-2", "1310-73-2"),
    ("001310-73-2", "1310-73-2"),  # ecoinvent pads the first block with zeros
    ("1310-73-3", ""),  # the check digit is wrong
    ("16-32", ""),  # a size class, not a number
])
def test_a_number_is_read_without_its_zeros_and_only_with_a_valid_check_digit(written, number):
    assert normalise(written) == number


def _row(name, atype="P", database="db", reserved=False, geo="GLO"):
    return {"database": database, "name": name, "product": name, "atype": atype, "geo": geo, "code": name + geo,
            **({"reserved": True} if reserved else {})}


def test_the_block_leads_and_every_database_keeps_its_rows_within_the_list_length():
    ranked = [_row("a"), _row("b"), _row("c"), _row("d", database="small", reserved=True)]
    found = Found("1310-73-2", [_row("market x", "M"), _row("x production")])
    pinned = found.pin(ranked, lambda rows: rows, keep=1)
    assert [h["name"] for h in pinned] == ["market x", "x production", "a", "d"]
    assert pinned[0]["score"] == 1.0  # an exact match, not a near one


def test_markets_lead_the_block_and_a_promoted_row_is_no_longer_a_reserve():
    ranked = [_row("x production", reserved=True), _row("a")]
    found = Found("1310-73-2", [_row("x production"), _row("market x", "M")])
    pinned = found.pin(ranked, lambda rows: rows)
    assert [h["name"] for h in pinned] == ["market x", "x production"]
    assert not any(h.get("reserved") for h in pinned)  # the assistant lists reserved rows as "not matches"


def test_a_chosen_region_is_shown_through_the_rankings_own_proxy_chain():
    rows = [_row("market x", "M", geo="GLO"), _row("market x", "M", geo="RER")]
    pinned = Found("1310-73-2", rows).pin([_row("a")], lambda rows: rows[:1], target_geo="DE")
    assert pinned[0]["geo"] == "RER"  # DE → RER before GLO, as in the ranking


# -- through the search ------------------------------------------------------------------------------


def _background(bd, name: str) -> None:
    def act(code, nm, number="", amount=1.0):
        exchange = {"input": (name, code), "amount": amount, "type": "production"}
        if number:
            exchange["CAS number"] = number
        return {"name": nm, "reference product": nm.removeprefix("market for "), "location": "GLO",
                "unit": "kilogram", "exchanges": [exchange]}

    bd.Database(name).write({
        (name, "naoh-m"): act("naoh-m", "market for sodium hydroxide, without water", "001310-73-2"),
        (name, "naoh-p"): act("naoh-p", "chlor-alkali electrolysis", "1310-73-2"),
        (name, "naoh-w"): act("naoh-w", "market for waste sodium hydroxide", "1310-73-2", amount=-1.0),
        (name, "hexenal"): act("hexenal", "market for 2-ethyl-2-hexenal"),
        (name, "hcl"): act("hcl", "market for hydrochloric acid", "7647-01-0"),
    })
    bd.databases[name][common.COMPLETE_KEY] = True
    bd.databases.flush()


def _search(client, token, db, query):
    r = client.post("/api/v1/search/activities", json={"query": query, "database": db, "limit": 5}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def indexed(client, token, project):
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(get_bd(), db)
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200
    return db


def test_the_datasets_carrying_the_number_lead_without_waste_and_without_false_alarms(client, token, indexed):
    answer = _search(client, token, indexed, "1310-73-2")
    assert [h["code"] for h in answer["hits"][:2]] == ["naoh-m", "naoh-p"]  # the market first
    assert "naoh-w" not in [h["code"] for h in answer["hits"][:2]]  # the treatment carries it too
    assert answer["unmatched_terms"] == []  # "1310", "73" are in no name — the rows carry the number
    assert not answer["weak_match"]
    for labelled in ("CAS 1310-73-2", "CAS-Nr.: 1310-73-2", "1310-73-2 (CAS)"):
        answer = _search(client, token, indexed, labelled)
        assert answer["hits"][0]["code"] == "naoh-m" and answer["terms_not_in_results"] == [], labelled


def test_a_query_asking_for_waste_keeps_the_treatment(client, token, indexed):
    codes = [h["code"] for h in _search(client, token, indexed, "waste sodium hydroxide 1310-73-2")["hits"][:3]]
    assert "naoh-w" in codes


def test_a_number_no_database_carries_changes_nothing(client, token, indexed, monkeypatch):
    unknown = _search(client, token, indexed, "64-17-5")
    monkeypatch.setattr(client.app.state.search._identifiers, "find", lambda *a, **k: None)
    assert _search(client, token, indexed, "64-17-5")["hits"] == unknown["hits"]


def test_two_numbers_are_two_searches(client, token, indexed):
    assert (_search(client, token, indexed, "1310-73-2")["content_terms"]
            != _search(client, token, indexed, "7647-01-0")["content_terms"])
