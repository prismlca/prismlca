"""The wizard's endpoints. The split that matters: only /commit writes."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.dataimport import session
from prism_lca.engine.library import LIBRARY_DB

FIXTURES = Path(__file__).parent / "fixtures" / "import"


@pytest.fixture
def biosphere(client: TestClient, token: dict[str, str], project: str):
    get_bd().Database("biosphere3").write(
        {
            ("biosphere3", "co2-air"): {
                "name": "Carbon dioxide, fossil", "unit": "kilogram",
                "categories": ("air",), "type": "emission",
            },
        }
    )
    yield
    session.cancel()


def test_detect_answers_without_reading_the_whole_thing(client: TestClient, token, project):
    r = client.post("/api/v1/import/detect", json={"path": str(FIXTURES / "ilcd-unitprocess")}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["format"] == "ilcd"
    assert r.json()["files"] == 8


def test_a_path_that_is_not_there_says_so(client: TestClient, token, project):
    r = client.post("/api/v1/import/detect", json={"path": "/nope/nothing"}, headers=token)
    assert r.status_code >= 400
    assert "import_not_found" in r.text


def test_the_whole_way_through(client: TestClient, token, biosphere):
    start = client.post("/api/v1/import/start", json={"path": str(FIXTURES / "ilcd-unitprocess")}, headers=token)
    assert start.status_code == 200, start.text
    assert start.json()["datasets"] == 1

    state = client.get("/api/v1/import/state", headers=token).json()
    assert state["active"] is True
    assert state["bands"]["good"] >= 1

    # The band is a filter, which is the whole reason for having one.
    good = client.get("/api/v1/import/rows?confidence=good", headers=token).json()["rows"]
    assert good and all(r["confidence"] == "good" for r in good)
    still_open = client.get("/api/v1/import/rows?only_open=true", headers=token).json()["rows"]
    assert all(r["target"] is None for r in still_open)

    # Nothing written yet.
    assert LIBRARY_DB not in get_bd().databases

    done = client.post(
        "/api/v1/import/commit", json={"label": "from the API", "unmatched": "park"}, headers=token
    )
    assert done.status_code == 200, done.text
    # No index on the library yet, and building one from inside an import is not this button's job.
    assert done.json()["index"] == {"added": 0, "exists": False}
    assert done.json()["database"] == LIBRARY_DB
    assert LIBRARY_DB in get_bd().databases
    assert client.get("/api/v1/import/state", headers=token).json()["active"] is False

    # The import is listed as an import, and it can be taken back out again.
    listed = client.get("/api/v1/import/batches", headers=token).json()
    assert [b["label"] for b in listed["batches"]] == ["from the API"]
    batch = listed["batches"][0]["batch"]
    gone = client.post("/api/v1/import/batches/delete", json={"batch": batch}, headers=token)
    assert gone.status_code == 200, gone.text
    assert client.get("/api/v1/import/batches", headers=token).json()["batches"] == []
    assert LIBRARY_DB in get_bd().databases  # the library stays


def test_an_import_lands_in_the_search_index_it_belongs_in(client: TestClient, token, biosphere):
    """Otherwise the datasets just imported are exactly the ones the search cannot find — the
    index would sit stale behind a button until somebody happened to press it."""
    client.post("/api/v1/import/start", json={"path": str(FIXTURES / "ilcd-unitprocess")}, headers=token)
    client.post("/api/v1/import/commit", json={"label": "first"}, headers=token)
    built = client.post("/api/v1/search/index", json={"database": LIBRARY_DB}, headers=token)
    assert built.status_code == 200, built.text

    second = client.post(
        "/api/v1/import/start", json={"path": str(FIXTURES / "simapro-inventory.csv")}, headers=token
    )
    assert second.status_code == 200, second.text
    done = client.post("/api/v1/import/commit", json={"label": "second"}, headers=token)
    assert done.status_code == 200, done.text
    assert done.json()["index"] == {"added": done.json()["datasets"], "exists": True}, done.text

    found = client.post(
        "/api/v1/search/activities",
        json={"query": "hot water tank", "database": LIBRARY_DB, "limit": 10},
        headers=token,
    )
    assert found.status_code == 200, found.text
    assert any("hot water tank" in h["name"].lower() for h in found.json()["hits"]), found.json()

    # …and removing that import takes its datasets back out, leaving the first import indexed.
    batch = next(b for b in client.get("/api/v1/import/batches", headers=token).json()["batches"]
                 if b["label"] == "second")["batch"]
    client.post("/api/v1/import/batches/delete", json={"batch": batch}, headers=token)
    after = client.post(
        "/api/v1/search/activities",
        json={"query": "hot water tank", "database": LIBRARY_DB, "limit": 10},
        headers=token,
    ).json()
    assert not any("hot water tank" in h["name"].lower() for h in after["hits"])
    assert client.app.state.search.index_info(LIBRARY_DB)["indexed_count"] == 1


def test_cancel_throws_the_import_away(client: TestClient, token, biosphere):
    client.post("/api/v1/import/start", json={"path": str(FIXTURES / "ilcd-unitprocess")}, headers=token)
    assert client.post("/api/v1/import/cancel", headers=token).json()["active"] is False
    assert client.get("/api/v1/import/state", headers=token).json()["active"] is False


def test_a_reviewer_can_look_up_a_flow_the_shortlist_never_offered(client: TestClient, token, biosphere):
    """The shortlist is what the RULES found, not the vocabulary. Without a way to say what you
    actually meant, "none of these" stops being a judgement and becomes a dead end."""
    client.post("/api/v1/import/start", json={"path": str(FIXTURES / "ilcd-unitprocess")}, headers=token)

    found = client.get("/api/v1/import/candidates?q=carbon+dioxide&kind=biosphere", headers=token)
    assert found.status_code == 200, found.text
    hits = found.json()["candidates"]
    assert hits, found.json()
    # Across compartments, because a reviewer may be correcting the compartment itself — and each
    # one says which compartment it is, because that is what the characterisation factor is per.
    assert all("categories" in h for h in hits)

    row = next(r for r in client.get("/api/v1/import/rows", headers=token).json()["rows"])
    pick = hits[0]
    applied = client.post(
        "/api/v1/import/decide",
        json={
            "decisions": [
                {
                    "dataset": row["dataset"],
                    "index": row["index"],
                    "database": pick["database"],
                    "code": pick["code"],
                    "confidence": "medium",
                    "evidence": "looked up by hand",
                }
            ]
        },
        headers=token,
    )
    assert applied.json()["applied"] == 1
    after = next(
        r for r in client.get("/api/v1/import/rows", headers=token).json()["rows"]
        if r["index"] == row["index"]
    )
    assert after["target"]["code"] == pick["code"]
    # …and the unit arithmetic was redone for it, not inherited from whatever was there before.
    assert after["scaled_amount"] == after["amount"] * after["factor"]


def test_a_commit_invalidates_calculations_that_drew_on_the_library(client: TestClient, token, biosphere):
    """A library write bypasses the command bus, so it has to bump the model generation itself —
    otherwise a foreground model answers its next calculation from the factorisation built before the
    import."""
    from prism_lca.engine import lca

    client.post("/api/v1/import/start", json={"path": str(FIXTURES / "ilcd-unitprocess")}, headers=token)
    before = lca.model_generation()
    done = client.post("/api/v1/import/commit", json={"label": "bump"}, headers=token)
    assert done.status_code == 200, done.text
    assert lca.model_generation() > before


def test_an_index_failure_after_the_write_is_not_a_failed_import(client: TestClient, token, biosphere):
    """By the time the index is extended the datasets are written and the session is gone. A provider
    error there used to fail the whole request — the wizard showed an error over a finished job, and
    the retry met import_no_session."""
    client.post("/api/v1/import/start", json={"path": str(FIXTURES / "ilcd-unitprocess")}, headers=token)

    def boom(*_a, **_k):
        raise RuntimeError("embedding provider down")

    client.app.state.search.extend = boom
    done = client.post("/api/v1/import/commit", json={"label": "landed"}, headers=token)
    assert done.status_code == 200, done.text
    body = done.json()
    assert body["datasets"] == 1
    assert body["index"]["exists"] is False
    assert "embedding provider down" in body["index"]["error"]
    # The datasets are really in.
    assert LIBRARY_DB in get_bd().databases
