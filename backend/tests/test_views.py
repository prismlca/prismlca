"""A model's view state: stored with the model, follows a rename, dies with a delete.

The point of these tests is not the round trip — it is the two things that were broken while this
lived in the renderer's localStorage (a rename stranded the arrangement, a delete left residue) and
the one rule the model bundle will depend on: a client that does not know a section must not be able
to delete it.
"""
from __future__ import annotations

import json

from prism_lca.engine.view_store import ViewStore


def _view_path(client):
    from pathlib import Path

    from prism_lca.engine.bootstrap import get_bd

    del client
    return Path(get_bd().projects.dir) / "prism_meta" / "views.json"


def _model(client, token, name: str) -> str:
    """A foreground model to hang a view on (`project` is a project, not a database)."""
    r = client.post("/api/v1/databases/foreground", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    return name


def test_a_model_without_a_view_answers_empty(client, token, project):
    del project
    r = client.get("/api/v1/views/nonexistent-model", headers=token)
    assert r.status_code == 200
    assert r.json() == {"schema": 1, "database": "nonexistent-model", "view": {}}


def test_put_then_get_round_trips(client, token, project):
    del project
    _model(client, token, "Model A")
    view = {
        "layout": {"pos": {"abc": [120, 340]}, "refs": ["ecoinvent-3.12-cutoff/xyz"]},
        "colors": {"abc": "#93c120"},
    }
    r = client.put("/api/v1/views/Model A", json={"view": view}, headers=token)
    assert r.status_code == 200
    assert r.json()["view"] == view
    assert client.get("/api/v1/views/Model A", headers=token).json()["view"] == view


def test_groups_are_a_section_like_any_other(client, token, project):
    """Canvas groups are view state, not model data: a list of boxes with an explicit member list.

    A group says nothing about the LCA — it is an arrangement, like a position or a colour — so it
    travels the same path and, like the rest of the entry, must not disturb the other sections.
    """
    del project
    _model(client, token, "Model G")
    groups = [
        {"id": "g1", "color": "#93c120", "members": ["M/a", "M/b"]},
        {"id": "g2", "color": "#9f5987", "members": ["M/b", "M/c"]},  # overlapping is legal
    ]
    client.put("/api/v1/views/Model G", json={"view": {"colors": {"M/a": "#93c120"}}}, headers=token)
    client.put("/api/v1/views/Model G", json={"view": {"groups": groups}}, headers=token)
    view = client.get("/api/v1/views/Model G", headers=token).json()["view"]
    assert view["groups"] == groups
    assert view["colors"] == {"M/a": "#93c120"}

    # Ungrouping the last box is an empty list, not a missing section — and it must stick.
    client.put("/api/v1/views/Model G", json={"view": {"groups": []}}, headers=token)
    assert client.get("/api/v1/views/Model G", headers=token).json()["view"]["groups"] == []


def test_a_section_not_sent_is_left_alone(client, token, project):
    """Dragging a node must not wipe the results setup — two independent writers, one entry."""
    del project
    _model(client, token, "Model B")
    client.put("/api/v1/views/Model B", json={"view": {"results": {"picked": ["m1"]}}}, headers=token)
    client.put("/api/v1/views/Model B", json={"view": {"layout": {"pos": {"a": [1, 2]}}}}, headers=token)
    view = client.get("/api/v1/views/Model B", headers=token).json()["view"]
    assert view["results"] == {"picked": ["m1"]}
    assert view["layout"] == {"pos": {"a": [1, 2]}}


def test_an_unknown_section_survives_a_write_from_an_older_client(client, token, project):
    """The rule the bundle format rests on, practised here: read what you know, keep what you don't.

    A newer PrismLCA stores `uncertainty`; running this version once must not delete it.
    """
    del project
    _model(client, token, "Model C")
    ViewStore().put("Model C", {"uncertainty": {"seed": 7}, "layout": {"pos": {}}})
    client.put("/api/v1/views/Model C", json={"view": {"layout": {"pos": {"a": [3, 4]}}}}, headers=token)
    view = client.get("/api/v1/views/Model C", headers=token).json()["view"]
    assert view["uncertainty"] == {"seed": 7}
    assert view["layout"] == {"pos": {"a": [3, 4]}}


def test_an_explicit_null_clears_a_section(client, token, project):
    del project
    _model(client, token, "Model D")
    client.put("/api/v1/views/Model D", json={"view": {"colors": {"a": "#fff"}}}, headers=token)
    client.put("/api/v1/views/Model D", json={"view": {"colors": None}}, headers=token)
    assert client.get("/api/v1/views/Model D", headers=token).json()["view"] == {}


def test_a_broken_file_costs_the_view_and_not_the_app(client, token, project):
    """Half a file from a hard kill: the model is intact, so the app must come up anyway."""
    del project
    _model(client, token, "Model E")
    client.put("/api/v1/views/Model E", json={"view": {"colors": {"a": "#fff"}}}, headers=token)
    path = _view_path(client)
    path.write_text('{"schema": 1, "models": {"Model E": {"col', encoding="utf-8")
    assert client.get("/api/v1/views/Model E", headers=token).json()["view"] == {}
    # and it heals: the next write produces a valid file again
    client.put("/api/v1/views/Model E", json={"view": {"colors": {"b": "#000"}}}, headers=token)
    assert json.loads(path.read_text(encoding="utf-8"))["models"]["Model E"]["colors"] == {"b": "#000"}


def test_the_view_follows_a_renamed_model(client, token, project):
    """This is the bug the move fixes: the arrangement used to strand under the dead name."""
    del project
    db = _model(client, token, "ViewRename")
    client.put(f"/api/v1/views/{db}", json={"view": {"layout": {"pos": {"a": [9, 9]}}}}, headers=token)
    r = client.post(
        "/api/v1/databases/foreground/rename",
        json={"database": db, "name": f"{db}-renamed"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert client.get(f"/api/v1/views/{db}-renamed", headers=token).json()["view"]["layout"] == {
        "pos": {"a": [9, 9]}
    }
    assert client.get(f"/api/v1/views/{db}", headers=token).json()["view"] == {}


def test_a_rename_follows_into_the_views_of_models_that_compare_it(client, token, project):
    """Model A compares B's process; renaming B left A pointing at the dead name
    (the subject vanished, and a new model called B would have taken its place)."""
    del project
    a = _model(client, token, "ViewCmpA")
    b = _model(client, token, "ViewCmp/B")  # a name the subject key has to escape
    client.put(
        f"/api/v1/views/{a}",
        json={
            "view": {
                "results": {
                    "fgSubjects": [{"database": b, "code": "root", "name": "Bottle"}],
                    "bgSubjects": [{"database": "ecoinvent", "code": "hex", "name": "PET"}],
                    "colors": {"ViewCmp%2FB/root": "#111111", "own": "#222222"},
                    "refCode": "ViewCmp%2FB/root",
                    "keys": 2,
                },
                "detailed": {"subject": {"database": b, "code": "root"}},
            }
        },
        headers=token,
    )
    r = client.post(
        "/api/v1/databases/foreground/rename", json={"database": b, "name": "ViewCmpB2"}, headers=token
    )
    assert r.status_code == 200, r.text
    view = client.get(f"/api/v1/views/{a}", headers=token).json()["view"]
    assert view["results"]["fgSubjects"] == [{"database": "ViewCmpB2", "code": "root", "name": "Bottle"}]
    assert view["results"]["bgSubjects"][0]["database"] == "ecoinvent"
    assert view["results"]["colors"] == {"ViewCmpB2/root": "#111111", "own": "#222222"}
    assert view["results"]["refCode"] == "ViewCmpB2/root"
    assert view["detailed"]["subject"] == {"database": "ViewCmpB2", "code": "root"}


def test_a_rename_leaves_the_keys_of_an_unmigrated_view_alone(client, token, project):
    """Second review: in a view no migrated Results page has marked, ``B/x`` may be the model's own code
    "B/x". Rewriting it to ``C/x`` would detach it from ``subjSel``; the migration resolves it later."""
    del project
    a = _model(client, token, "ViewLegacyA")
    b = _model(client, token, "B")
    results = {
        "subjSel": {"B/x": True},
        "fgSubjects": [{"database": b, "code": "y", "name": "Other"}],
        "colors": {"B/x": "#111111"},
        "refCode": "B/x",
    }
    client.put(f"/api/v1/views/{a}", json={"view": {"results": results}}, headers=token)
    r = client.post("/api/v1/databases/foreground/rename", json={"database": b, "name": "C"}, headers=token)
    assert r.status_code == 200, r.text
    back = client.get(f"/api/v1/views/{a}", headers=token).json()["view"]["results"]
    assert back["colors"] == {"B/x": "#111111"}
    assert back["refCode"] == "B/x"
    assert back["subjSel"] == {"B/x": True}
    # The entry itself follows — its `database` field is not ambiguous.
    assert back["fgSubjects"][0]["database"] == "C"


def test_deleting_a_model_takes_its_view_with_it(client, token, project):
    del project
    db = _model(client, token, "ViewDelete")
    client.put(f"/api/v1/views/{db}", json={"view": {"colors": {"a": "#fff"}}}, headers=token)
    r = client.post("/api/v1/databases/foreground/delete", json={"database": db}, headers=token)
    assert r.status_code == 200, r.text
    assert ViewStore().all_models() == []


def test_views_are_written_sorted_so_two_saves_diff_cleanly(client, token, project):
    del project
    _model(client, token, "Z")
    client.put("/api/v1/views/Z", json={"view": {"colors": {"b": "1", "a": "2"}}}, headers=token)
    text = _view_path(client).read_text(encoding="utf-8")
    assert text.index('"a"') < text.index('"b"')


def test_a_view_for_a_model_that_does_not_exist_is_refused(client, token, project):
    """The renderer's debounced write may land after the model was deleted. Stored, it would be an
    entry under a name nothing can reach again — nine of those were found in one development project.
    Refused, it is a 404 the renderer swallows, and the file stays clean."""
    del project
    r = client.put("/api/v1/views/never-created", json={"view": {"colors": {"a": "#fff"}}}, headers=token)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "database_not_found"
    assert ViewStore().all_models() == []
    # …and a delete followed by a late write still leaves nothing behind
    db = _model(client, token, "ViewLateWrite")
    client.put(f"/api/v1/views/{db}", json={"view": {"colors": {"a": "#fff"}}}, headers=token)
    assert client.post("/api/v1/databases/foreground/delete", json={"database": db}, headers=token).status_code == 200
    assert client.put(f"/api/v1/views/{db}", json={"view": {"colors": {"a": "#000"}}}, headers=token).status_code == 404
    assert ViewStore().all_models() == []
