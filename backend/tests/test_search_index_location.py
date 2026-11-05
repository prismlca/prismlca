"""Where a database's search index is stored: below the workspace's ``prism_search`` folder, whatever the
database is called — and where every existing index already is."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from prism_lca.engine.bootstrap import get_bd
from prism_lca.search.index_location import index_base

ROOT = Path("ws") / "prism_search"


@pytest.mark.parametrize(
    "name",
    ["ecoinvent-3.12-cutoff", "Steel water bottle (2)", "Café Modell", "BAFU 2025", "A/B", "v1.0..final"],
)
def test_an_ordinary_name_keeps_the_place_its_index_always_had(name):
    assert index_base(ROOT, name) == ROOT / name


@pytest.mark.parametrize(
    "name",
    ["../../../x", "/abs/x", "a/../../x", "..", ".", "", "...", "x\x00y", os.path.abspath("y")],
)
def test_any_other_name_maps_to_one_file_name_directly_below_the_folder(name):
    base = index_base(ROOT, name)
    assert base.parent == ROOT
    assert "~" in base.name


def test_two_names_never_share_a_place():
    names = ["../x", "/x", "x/..", "..\\x", "../x/"]
    assert len({index_base(ROOT, n) for n in names}) == len(names)


def test_a_name_spelled_like_a_hashed_place_gets_a_place_of_its_own():
    hashed = index_base(ROOT, "../victim")
    assert index_base(ROOT, hashed.name) != hashed
    assert index_base(ROOT, f"a/{hashed.name}").parent == ROOT


def _seed(name: str) -> None:
    get_bd().Database(name).write(
        {
            (name, "a"): {
                "name": "steel sheet",
                "unit": "kg",
                "location": "GLO",
                "exchanges": [{"input": (name, "a"), "amount": 1.0, "type": "production"}],
            }
        }
    )


def test_an_index_stays_inside_the_workspace_whatever_the_model_is_called(client, token, project, tmp_path):
    folder = Path(get_bd().projects.dir) / "prism_search"
    outside = tmp_path / "keep"
    name = os.path.relpath(outside, folder)
    for suffix in (".json", ".npz"):
        Path(str(outside) + suffix).write_text("untouched", encoding="utf-8")
    _seed(name)

    r = client.post("/api/v1/search/index", json={"database": name}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "done"
    r = client.post("/api/v1/search/activities", json={"query": "steel", "database": name}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["hits"]
    client.app.state.search.invalidate(name)
    client.app.state.search.drop_index(name)

    for suffix in (".json", ".npz"):
        assert Path(str(outside) + suffix).read_text(encoding="utf-8") == "untouched"
    assert not list(tmp_path.glob("*.tmp"))


def test_a_selector_that_is_no_database_opens_no_index(client, token, project):
    _seed("indexed")
    r = client.post("/api/v1/search/index", json={"database": "indexed"}, headers=token)
    assert r.status_code == 200, r.text
    service = client.app.state.search
    service.forget_loaded()
    del get_bd().databases["indexed"]
    r = client.post("/api/v1/search/activities", json={"query": "steel", "database": "indexed"}, headers=token)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "not_indexed"
