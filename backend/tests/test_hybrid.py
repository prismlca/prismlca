from __future__ import annotations

import uuid

from test_search import _seed

from prism_lca.engine.bootstrap import get_bd
from prism_lca.search.fusion import reciprocal_rank_fusion
from prism_lca.search.lexical import Bm25Index


def test_bm25_ranking_and_idf():
    docs = [
        ["electricity", "high", "voltage"],
        ["electricity", "low", "voltage"],
        ["steel", "production"],
    ]
    idx = Bm25Index(docs)
    # a term unique to one doc ranks that doc first
    assert idx.top("steel", 3)[0][0] == 2
    # a term shared by two docs returns exactly those two, none of the others
    assert {i for i, _ in idx.top("electricity", 3)} == {0, 1}
    # a term in no doc scores nothing
    assert idx.top("aluminium", 3) == []


def test_bm25_from_meta():
    meta = [
        {"name": "market for electricity", "product": "electricity, low voltage"},
        {"name": "steel production", "product": "steel"},
    ]
    idx = Bm25Index.from_meta(meta)
    assert idx.top("steel", 2)[0][0] == 1


def test_rrf_fusion_values():
    dense = ["a", "b", "c"]
    sparse = ["b", "d", "a"]
    fused = reciprocal_rank_fusion([dense, sparse])
    # b is rank-1 in dense and rank-0 in sparse -> highest; c only appears once (low)
    order = sorted(fused, key=lambda k: -fused[k])
    assert order[0] == "b"
    assert fused["b"] > fused["a"] > fused["d"] > fused["c"]


def test_hybrid_search_exact_product_token(client, token, project):
    bd = get_bd()
    db = "syn-" + uuid.uuid4().hex[:6]
    _seed(bd, db)
    client.post("/api/v1/search/index", json={"database": db}, headers=token)

    # a precise lexical query must return the matching activity as the top hit (BM25 + dense agree)
    r = client.post(
        "/api/v1/search/activities",
        json={"query": "polyethylene terephthalate", "database": db, "limit": 5},
        headers=token,
    )
    assert r.status_code == 200, r.text
    hits = r.json()["hits"]
    assert hits
    assert "polyethylene" in hits[0]["name"].lower()
