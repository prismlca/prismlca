"""Which processes consume a dataset — answered from the exchange table, gated on a background (V484).

The reverse read walked every process through the ORM and took 204 s over a whole background database,
asked for by a model that meant its own. Now it is one indexed query, the same answer, and a background
database is searched only with ``whole_database``.
"""
from __future__ import annotations

import pytest

from prism_lca.engine import consumers as consumers_mod
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.consumers import WHOLE_DATABASE_SHOWN, find_consumers
from prism_lca.engine.guardrails import set_read_only
from prism_lca.errors import PrismError


def _orm_consumers(database: str, input_database: str, input_code: str) -> list[dict]:
    """The answer as the old ORM walk gave it — every process, every exchange, the input resolved."""
    out = []
    for act in get_bd().Database(database):
        for ex in act.exchanges():
            if ex.get("type") == "production":
                continue
            if ex.input and tuple(ex.input.key) == (input_database, input_code):
                out.append({
                    "database": act.key[0], "code": act.key[1], "name": act.get("name") or "",
                    "uid": ex.get("prism_uid"), "amount": ex.get("amount"), "formula": ex.get("formula"),
                    "comment": ex.get("comment") or None,
                })
    return sorted(out, key=lambda r: r["name"])


def _world(bd) -> None:
    """A background with a granulate and a waste market drawing on a treatment, and a model using both."""
    bd.Database("bg").write({
        ("bg", "granulate"): {"name": "widget granulate", "unit": "kg", "exchanges": [
            {"input": ("bg", "granulate"), "amount": 1, "type": "production"}]},
        ("bg", "treatment"): {"name": "treatment of widget waste", "unit": "kg", "exchanges": [
            {"input": ("bg", "treatment"), "amount": -1, "type": "production"}]},
        ("bg", "waste-market"): {"name": "market for widget waste", "unit": "kg", "exchanges": [
            {"input": ("bg", "waste-market"), "amount": -1, "type": "production"},
            {"input": ("bg", "treatment"), "amount": -0.7, "type": "technosphere"}]},
    })
    set_read_only("bg", True)
    bd.Database("model").write({
        ("model", "moulding"): {"name": "Moulding", "unit": "kg", "exchanges": [
            {"input": ("model", "moulding"), "amount": 1, "type": "production", "prism_uid": "p" * 32},
            {"input": ("bg", "granulate"), "amount": 1.05, "type": "technosphere", "prism_uid": "a" * 32,
             "formula": "mass * 1.05", "comment": "scrap rate"}]},
        ("model", "bottle"): {"name": "Bottle", "unit": "unit", "exchanges": [
            {"input": ("model", "bottle"), "amount": 1, "type": "production"},
            {"input": ("bg", "granulate"), "amount": 0.03, "type": "technosphere", "prism_uid": "b" * 32},
            {"input": ("model", "moulding"), "amount": 0.03, "type": "technosphere", "prism_uid": "c" * 32},
            {"input": ("bg", "treatment"), "amount": -0.03, "type": "technosphere", "prism_uid": "d" * 32}]},
    })
    set_read_only("model", False)


def test_the_indexed_query_gives_what_the_orm_walk_gave(project):
    bd = get_bd()
    _world(bd)
    for wanted in (("bg", "granulate"), ("model", "moulding"), ("bg", "treatment"), ("bg", "nothing")):
        got = find_consumers("model", *wanted)
        assert got["consumers"] == _orm_consumers("model", *wanted), wanted
        assert got["count"] == len(got["consumers"])
        assert got["input"] == {"database": wanted[0], "code": wanted[1]}
    granulate = find_consumers("model", "bg", "granulate")
    assert [c["name"] for c in granulate["consumers"]] == ["Bottle", "Moulding"]
    moulding = granulate["consumers"][1]
    assert moulding["formula"] == "mass * 1.05" and moulding["comment"] == "scrap rate"
    assert moulding["uid"] == "a" * 32 and moulding["amount"] == 1.05
    # The production exchange is the process itself, not a consumer of it.
    assert find_consumers("model", "model", "moulding")["consumers"][0]["name"] == "Bottle"


def test_it_does_not_walk_the_processes(project, monkeypatch):
    """The fast path IS the fix: an ORM walk over a background database was the 204 s."""
    bd = get_bd()
    _world(bd)
    from bw2data.backends.proxies import Activity

    def walked(*_a, **_k):
        raise AssertionError("consumers walked the exchanges through the ORM")

    monkeypatch.setattr(Activity, "exchanges", walked)
    assert find_consumers("model", "bg", "granulate")["count"] == 2


def test_a_background_is_searched_only_when_asked_for_the_whole_database(project, client, token):
    bd = get_bd()
    _world(bd)
    with pytest.raises(PrismError) as refused:
        find_consumers("bg", "bg", "treatment")
    assert refused.value.code == "consumers_whole_database"
    assert "whole_database: true" in refused.value.hint and "your own model" in refused.value.hint
    # Asked for in so many words, it answers — this is how the waste market mixing a treatment is found.
    found = find_consumers("bg", "bg", "treatment", whole_database=True)
    assert [c["name"] for c in found["consumers"]] == ["market for widget waste"]
    assert "more" not in found
    # The same over HTTP, where the tool sends it.
    r = client.get("/api/v1/model/consumers/bg", params={"input_database": "bg", "input_code": "treatment"},
                   headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "consumers_whole_database"
    r = client.get("/api/v1/model/consumers/bg", headers=token, params={
        "input_database": "bg", "input_code": "treatment", "whole_database": "true"})
    assert r.status_code == 200 and r.json()["count"] == 1
    # A model needs no switch, and the switch changes nothing there.
    assert find_consumers("model", "bg", "treatment", whole_database=True)["count"] == 1


def test_a_whole_database_list_is_capped_and_says_how_many_more(project, monkeypatch):
    bd = get_bd()
    _world(bd)
    monkeypatch.setattr(consumers_mod, "WHOLE_DATABASE_SHOWN", 1)
    bd.Database("bg").write({
        **{node.key: {"name": node["name"], "unit": "kg", "exchanges": [
            {"input": ex.input.key, "amount": ex["amount"], "type": ex["type"]} for ex in node.exchanges()]}
           for node in bd.Database("bg")},
        ("bg", "second-market"): {"name": "another market for widget waste", "unit": "kg", "exchanges": [
            {"input": ("bg", "second-market"), "amount": -1, "type": "production"},
            {"input": ("bg", "treatment"), "amount": -0.2, "type": "technosphere"}]},
    })
    set_read_only("bg", True)
    found = find_consumers("bg", "bg", "treatment", whole_database=True)
    assert found["count"] == 2 and len(found["consumers"]) == 1
    assert found["more"].startswith("1 more")
    assert WHOLE_DATABASE_SHOWN >= 20  # the real cap leaves a usable list


def test_the_query_takes_the_input_index_where_bw2data_has_built_it(project):
    """bw2data builds ``exchangedataset_input`` on every large write (any background import); a small test
    project never gets one, so it is built here as the import would."""
    from bw2data.backends import sqlite3_lci_db

    bd = get_bd()
    _world(bd)
    bd.Database("bg")._add_indices()
    sql, params = consumers_mod._query("bg", "bg", "treatment").sql()
    plan = " ".join(str(row[-1]) for row in sqlite3_lci_db.execute_sql("EXPLAIN QUERY PLAN " + sql, params))
    assert "USING INDEX exchangedataset_input" in plan, plan
