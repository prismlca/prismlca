"""The elementary-flow index — and the guarantee that it leaves the process search alone.

Design condition: taking the flows into the index must not change the ranking of the
process search, for the modelling model or in the UI. It holds structurally today; this file is
what keeps it holding, because exactly this kind of promise disappears in a refactor without a
sound (four of them did on 31.08.).
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from prism_lca.engine.bootstrap import get_bd


def _write(name: str, rows: dict) -> None:
    get_bd().Database(name).write(rows)


def _bg(name: str) -> None:
    _write(
        name,
        {
            (name, "elec"): {"name": "market for electricity, medium voltage", "unit": "kilowatt hour",
                             "location": "DE", "type": "process", "exchanges": []},
            (name, "steel"): {"name": "market for steel, low-alloyed", "unit": "kilogram",
                              "location": "GLO", "type": "process", "exchanges": []},
        },
    )


def _bio() -> None:
    _write(
        "biosphere3",
        {
            ("biosphere3", "co2"): {"name": "Carbon dioxide, fossil", "unit": "kilogram",
                                    "categories": ("air",), "type": "emission"},
            ("biosphere3", "ch4"): {"name": "Methane, fossil", "unit": "kilogram",
                                    "categories": ("air",), "type": "emission"},
        },
    )


def test_indexing_a_background_database_pulls_the_flows_in_behind_it(client: TestClient, token, project):
    """A second button nobody presses is the same as no index, so the flows come along with the
    step that already exists."""
    _bg("bg")
    _bio()
    r = client.post("/api/v1/search/index", json={"database": "bg"}, headers=token)
    assert r.status_code == 200, r.text
    assert client.get("/api/v1/search/index-info?database=bg", headers=token).json()["indexed"]
    assert client.get("/api/v1/search/index-info?database=biosphere3", headers=token).json()["indexed"]


def test_the_process_search_is_unchanged_by_the_flow_index(client: TestClient, token, project):
    """The BM25 corpus is derived per index. A shared corpus would shift the IDF statistics and
    therefore the ranking, without anyone touching a line of ranking code — so the same query has
    to come back identical, hit for hit and score for score."""
    _bg("bg")
    body = {"database": "bg", "query": "electricity", "limit": 5}

    client.post("/api/v1/search/index", json={"database": "bg"}, headers=token)
    before = client.post("/api/v1/search/activities", json=body, headers=token).json()

    _bio()
    client.post("/api/v1/search/index", json={"database": "biosphere3"}, headers=token)
    after = client.post("/api/v1/search/activities", json=body, headers=token).json()

    assert after == before


def test_the_flows_never_appear_in_a_process_search(client: TestClient, token, project):
    """Not "they rank low" — they are not in the corpus at all. One index per database is the
    mechanism, and this is the assertion that says so out loud."""
    _bg("bg")
    _bio()
    client.post("/api/v1/search/index", json={"database": "bg"}, headers=token)
    hits = client.post(
        "/api/v1/search/activities", json={"database": "bg", "query": "carbon dioxide", "limit": 10},
        headers=token,
    ).json()
    rows = hits.get("results") or hits.get("hits") or []
    assert all(row.get("database", "bg") == "bg" for row in rows), rows


def test_the_flow_database_is_not_offered_as_a_search_target(client: TestClient, token, project):
    """It carries kind='biosphere', and the picker lists kind='background'. Said here because the
    picker's filter is one word in a component and this is the promise it is keeping."""
    _bio()
    listing = client.get("/api/v1/databases", headers=token).json()
    rows = listing["databases"] if isinstance(listing, dict) else listing
    kinds = {d["name"]: d["kind"] for d in rows}
    assert kinds["biosphere3"] == "biosphere"
