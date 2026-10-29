"""Market vectors blended with their suppliers' for the ranking (search/market_vectors.py)."""

from __future__ import annotations

import sqlite3
import threading
import uuid
from pathlib import Path

import numpy as np
import pytest

from prism_lca.engine.backgrounds import common
from prism_lca.engine.bootstrap import get_bd
from prism_lca.search import market_vectors
from prism_lca.search.index import VectorIndex
from prism_lca.search.market_vectors import blend
from prism_lca.search.ranking import WEAK_TRIGGER
from prism_lca.search.variants import fuse


def _unit(*xs) -> np.ndarray:
    v = np.asarray(xs, dtype="float32")
    return v / np.linalg.norm(v)


def _norm(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v)


def test_a_market_is_blended_with_the_mean_of_its_three_biggest_suppliers():
    m, a, b, c, d = (_unit(1, 0, 0, 0), _unit(0, 1, 0, 0), _unit(0, 0, 1, 0), _unit(0, 0, 0, 1),
                     _unit(1, 1, 1, 1))
    matrix = np.stack([m, a, b, c, d])
    meta = [{"code": "m", "atype": "M"}] + [{"code": k, "atype": "P"} for k in "abcd"]
    before = matrix.copy()
    rows, vecs = blend(matrix, meta, {"m": ["a", "b", "c", "d"]}, 0.5)
    assert rows.tolist() == [0]  # producers keep their own vectors
    assert np.allclose(vecs[0], _norm(m + 0.5 * _norm((a + b + c) / 3)), atol=1e-6)  # d is the fourth
    assert np.array_equal(matrix, before)  # read, never written


def test_suppliers_outside_the_index_do_not_count_toward_the_three():
    """Filtered first, then the three taken — taking three and filtering after would drop "c"."""
    m, a, b, c = _unit(1, 0, 0, 0), _unit(0, 1, 0, 0), _unit(0, 0, 1, 0), _unit(0, 0, 0, 1)
    meta = [{"code": "m", "atype": "M"}] + [{"code": k, "atype": "P"} for k in "abc"]
    _, vecs = blend(np.stack([m, a, b, c]), meta, {"m": ["gone", "a", "b", "c"]}, 0.5)
    assert np.allclose(vecs[0], _norm(m + 0.5 * _norm((a + b + c) / 3)), atol=1e-6)


def test_fuse_keeps_the_better_ranking_value_beside_the_better_cosine():
    raw = [{"database": "d", "code": "m", "dense": 0.30, "order": 0.64, "fused": 0.02}]
    alt = [{"database": "d", "code": "m", "dense": 0.35, "order": 0.60, "fused": 0.03}]
    (merged,) = fuse(raw, alt, 1.0, 1.0)
    assert (merged["dense"], merged["order"]) == (0.35, 0.64)


def test_a_market_group_is_blended_with_the_raw_vectors_of_its_markets():
    """Measured that way: no chain — a group does not inherit its markets' blends."""
    g, m, p = _unit(1, 0, 0), _unit(0, 1, 0), _unit(0, 0, 1)
    meta = [{"code": "g", "atype": "G"}, {"code": "m", "atype": "M"}, {"code": "p", "atype": "P"}]
    rows, vecs = blend(np.stack([g, m, p]), meta, {"g": ["m"], "m": ["p"]}, 0.5)
    assert rows.tolist() == [0, 1]
    assert np.allclose(vecs[0], _norm(g + 0.5 * m), atol=1e-6)


def test_a_market_without_suppliers_keeps_its_vector():
    meta = [{"code": "m", "atype": "M"}, {"code": "p", "atype": "P"}]
    rows, vecs = blend(np.stack([_unit(1, 0), _unit(0, 1)]), meta, {}, 0.5)
    assert rows.size == 0 and vecs.shape == (0, 2)


# -- against a real workspace ------------------------------------------------------------------------


def _background(bd, name: str, complete: bool = True) -> None:
    def act(code, nm, prod, unit="kilogram", ref=1.0, inputs=()):
        exchanges = [{"input": (name, code), "amount": ref, "type": "production"}]
        exchanges += [{"input": (name, c), "amount": a, "type": "technosphere"} for c, a in inputs]
        return {"name": nm, "reference product": prod, "location": "GLO", "unit": unit, "exchanges": exchanges}

    bd.Database(name).write({
        (name, "acid_a"): act("acid_a", "sulfuric acid production, route A", "sulfuric acid"),
        (name, "acid_b"): act("acid_b", "sulfuric acid production, route B", "sulfuric acid"),
        (name, "lorry"): act("lorry", "transport, freight, lorry", "transport, freight, lorry", unit="ton kilometer"),
        (name, "acid_market"): act("acid_market", "market for sulfuric acid", "sulfuric acid",
                                   inputs=[("acid_a", 0.3), ("acid_b", 0.7), ("lorry", 5.0)]),
        (name, "landfill"): act("landfill", "treatment of waste glass, sanitary landfill", "waste glass", ref=-1.0),
        (name, "glass_market"): act("glass_market", "market for waste glass", "waste glass", ref=-1.0,
                                    inputs=[("landfill", -1.0)]),
    })
    bd.databases[name][common.COMPLETE_KEY] = complete
    bd.databases.flush()


def _db_file() -> Path:
    return Path(get_bd().projects.dir) / "lci" / "databases.db"


def test_suppliers_sell_the_markets_product_biggest_first_and_waste_markets_count_their_treatments(project):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    got = market_vectors.suppliers(_db_file(), db, {"acid_market", "glass_market"})
    assert got == {"acid_market": ["acid_b", "acid_a"],  # the lorry sells transport, not acid
                   "glass_market": ["landfill"]}  # negative treatment of a negative reference: a supplier


def test_a_file_without_the_index_markets_is_refused(project):
    """A workspace switch mid-search would otherwise pair this index with another workspace's suppliers."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    with pytest.raises(market_vectors.Mismatch):
        market_vectors.suppliers(_db_file(), db, {"acid_market", "not-in-this-workspace"})


def _indexed(client, token, db):
    assert client.post("/api/v1/search/index", json={"database": db}, headers=token).status_code == 200
    service = client.app.state.search
    service.forget_loaded()
    index = service._require_index(db)
    q = service._provider_().embed(["sulfuric acid"], is_query=True)[0]
    rows = {m["code"]: i for i, m in enumerate(index.meta)}
    return service, index, q, rows


def test_only_market_rows_are_ordered_differently_and_the_switch_turns_it_off(client, token, project, monkeypatch):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    service, index, q, rows = _indexed(client, token, db)
    cos = index.matrix @ q
    order = service._markets.order(db, index, cos, q)
    assert order[rows["acid_market"]] != cos[rows["acid_market"]]
    blended = service._markets._blended(db, index)[0].tolist()
    assert sorted(blended) == sorted([rows["acid_market"], rows["glass_market"]])
    for code in ("acid_a", "acid_b", "lorry", "landfill"):
        assert order[rows[code]] == cos[rows[code]]
    monkeypatch.setattr(service._settings, "search_market_blend", 0.0)
    assert np.array_equal(service._markets.order(db, index, cos, q), cos)


def test_a_market_hit_shows_its_own_similarity_not_the_blended_one(client, token, project):
    """The blend orders; it does not make a market claim to match better than its own text. A market whose own
    cosine is under the weak bar and whose blended one is far above it is shown
    with its own score and flagged weak."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    service, index, q, rows = _indexed(client, token, db)
    q = q / np.linalg.norm(q)
    other = np.zeros_like(q)
    other[int(np.argmin(np.abs(q)))] = 1.0
    other = _norm(other - (other @ q) * q)  # orthogonal to the query
    index.matrix[rows["acid_market"]] = _norm(0.3 * q + np.sqrt(1 - 0.09) * other)
    for code in ("acid_a", "acid_b"):
        index.matrix[rows[code]] = q
    index.generation += 1
    blended = service._markets._blended(db, index)
    at = blended[0].tolist().index(rows["acid_market"])
    assert float(blended[1][at] @ q) > WEAK_TRIGGER > 0.3  # the ranking sees a strong market…
    r = client.post("/api/v1/search/activities", json={"query": "sulfuric acid", "database": db, "limit": 10},
                    headers=token)
    assert r.status_code == 200, r.text
    hit = next(h for h in r.json()["hits"] if h["code"] == "acid_market")
    assert hit["score"] == pytest.approx(0.3, abs=1e-3) and hit["weak"] is True  # …the answer shows its own


def test_without_hybrid_search_nothing_is_blended(client, token, project, monkeypatch):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    service, *_ = _indexed(client, token, db)
    monkeypatch.setattr(service._settings, "search_hybrid", False)

    def boom(*a, **k):
        raise AssertionError("the dense-only path must not blend")

    monkeypatch.setattr(service._markets, "order", boom)
    r = client.post("/api/v1/search/activities", json={"query": "sulfuric acid", "database": db}, headers=token)
    assert r.status_code == 200, r.text


def test_the_index_keeps_its_raw_vectors_in_memory_and_on_disk(client, token, project):
    """Were the blend written into ``index.matrix``, the next save would persist it and the next load would
    blend a blended vector."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    service, index, q, _ = _indexed(client, token, db)
    before = index.matrix.copy()
    service._markets.order(db, index, index.matrix @ q, q)
    assert np.array_equal(index.matrix, before)
    index.save(service._index_base(db))
    assert np.array_equal(VectorIndex.load(service._index_base(db)).matrix, before)


def test_a_drop_and_an_add_of_as_many_rows_blend_anew(client, token, project):
    """Same length, every row position moved: the stamp is the index's generation, not its length."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    service, index, q, rows = _indexed(client, token, db)
    first = service._markets._blended(db, index)
    vec, meta = index.matrix[rows["acid_a"]].copy(), dict(index.meta[rows["acid_a"]])
    index.drop({"acid_a"})
    index.add(vec[None, :], [meta])
    again = service._markets._blended(db, index)
    assert again is not first
    moved = {m["code"]: i for i, m in enumerate(index.meta)}
    assert moved["acid_market"] in again[0].tolist()


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.mark.parametrize("failure", [sqlite3.OperationalError("database is locked"),
                                     market_vectors.Mismatch("another workspace")])
def test_a_failure_is_kept_one_minute_then_read_again(client, token, project, monkeypatch, failure):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    service, index, q, _ = _indexed(client, token, db)
    clock = _Clock()
    monkeypatch.setattr(market_vectors.time, "monotonic", clock)
    real = market_vectors.suppliers
    calls = {"n": 0}

    def flaky(db_file, name, codes):
        calls["n"] += 1
        if calls["n"] == 1:
            raise failure
        return real(db_file, name, codes)

    monkeypatch.setattr(market_vectors, "suppliers", flaky)
    cos = index.matrix @ q
    assert np.array_equal(service._markets.order(db, index, cos, q), cos)  # today's search this time
    clock.now += market_vectors.RETRY_AFTER - 1
    assert np.array_equal(service._markets.order(db, index, cos, q), cos)  # not re-read on every search
    assert calls["n"] == 1
    clock.now += 1
    assert not np.array_equal(service._markets.order(db, index, cos, q), cos)  # the minute is over
    assert calls["n"] == 2


def test_a_database_missing_from_the_current_workspace_is_asked_again_later(client, token, project, monkeypatch):
    """A switch mid-search makes `source` say "not a background here"; the index must blend again once its
    workspace is back."""
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    service, index, q, _ = _indexed(client, token, db)
    clock = _Clock()
    monkeypatch.setattr(market_vectors.time, "monotonic", clock)
    real = service._markets.source
    asked = {"n": 0}

    def counted(name):
        asked["n"] += 1
        return real(name)

    monkeypatch.setattr(service._markets, "source", lambda name: None)
    assert service._markets._blended(db, index) is None
    monkeypatch.setattr(service._markets, "source", counted)
    clock.now += market_vectors.RETRY_AFTER - 1
    assert service._markets._blended(db, index) is None and asked["n"] == 0  # kept for the minute…
    clock.now += 1
    assert service._markets._blended(db, index) is not None and asked["n"] == 1  # …then asked again


def test_concurrent_first_searches_build_the_blend_once(client, token, project, monkeypatch):
    bd = get_bd()
    db = "bg-" + uuid.uuid4().hex[:6]
    _background(bd, db)
    service, index, q, _ = _indexed(client, token, db)
    real = market_vectors.suppliers
    started, release = threading.Event(), threading.Event()
    calls = {"n": 0}

    def slow(db_file, name, codes):
        calls["n"] += 1
        started.set()
        release.wait(5)
        return real(db_file, name, codes)

    monkeypatch.setattr(market_vectors, "suppliers", slow)
    real_source = service._markets.source
    waiting = threading.Event()

    def source(name):  # the second caller passes here right before it waits for the build lock
        path = real_source(name)
        if started.is_set():
            waiting.set()
        return path

    monkeypatch.setattr(service._markets, "source", source)
    results = []
    first = threading.Thread(target=lambda: results.append(service._markets._blended(db, index)))
    first.start()
    assert started.wait(5)
    second = threading.Thread(target=lambda: results.append(service._markets._blended(db, index)))
    second.start()
    assert waiting.wait(5)  # the second build is under way before the first may finish
    release.set()
    first.join(5)
    second.join(5)
    assert not first.is_alive() and not second.is_alive()
    assert calls["n"] == 1 and len(results) == 2 and results[0] is results[1]


def test_a_library_is_left_alone(client, token, project):
    bd = get_bd()
    db = "lib-" + uuid.uuid4().hex[:6]
    _background(bd, db, complete=False)
    service, index, q, _ = _indexed(client, token, db)
    cos = index.matrix @ q
    assert np.array_equal(service._markets.order(db, index, cos, q), cos)
