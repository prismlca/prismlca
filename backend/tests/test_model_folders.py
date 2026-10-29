from __future__ import annotations

import uuid

import pytest

from prism_lca.errors import PrismError


def _fg(client, token, name: str | None = None) -> str:
    db = name or ("fg-" + uuid.uuid4().hex[:6])
    assert client.post("/api/v1/databases/foreground", json={"name": db}, headers=token).status_code == 200
    return db


def _folders(client, token) -> dict:
    return client.get("/api/v1/databases/folders", headers=token).json()


def test_a_folder_holds_models_and_reports_both_halves_in_one_read(client, token, project):
    a, b = _fg(client, token), _fg(client, token)
    made = client.post("/api/v1/databases/folders", json={"name": "Packaging"}, headers=token)
    assert made.status_code == 200, made.text
    fid = made.json()["id"]

    assert client.post(
        "/api/v1/databases/folders/assign", json={"database": a, "folder_id": fid}, headers=token
    ).status_code == 200

    state = _folders(client, token)
    assert [f["name"] for f in state["folders"]] == ["Packaging"]
    assert state["of"] == {a: fid}
    assert b not in state["of"]  # unfiled is a state, not a folder


def test_a_folder_name_is_taken_only_once(client, token, project):
    assert client.post("/api/v1/databases/folders", json={"name": "Food"}, headers=token).status_code == 200
    again = client.post("/api/v1/databases/folders", json={"name": "food"}, headers=token)
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "folder_exists"


def test_deleting_a_folder_never_deletes_a_model(client, token, project):
    db = _fg(client, token)
    fid = client.post("/api/v1/databases/folders", json={"name": "Temp"}, headers=token).json()["id"]
    client.post("/api/v1/databases/folders/assign", json={"database": db, "folder_id": fid}, headers=token)

    gone = client.post("/api/v1/databases/folders/delete", json={"id": fid}, headers=token)
    assert gone.status_code == 200
    assert gone.json()["released"] == [db]

    assert _folders(client, token) == {"folders": [], "of": {}}
    names = [d["name"] for d in client.get("/api/v1/databases", headers=token).json()]
    assert db in names


def test_membership_follows_a_rename_and_a_duplicate_and_dies_with_a_delete(client, token, project):
    db = _fg(client, token)
    fid = client.post("/api/v1/databases/folders", json={"name": "Keep"}, headers=token).json()["id"]
    client.post("/api/v1/databases/folders/assign", json={"database": db, "folder_id": fid}, headers=token)

    renamed = db + "-renamed"
    assert client.post(
        "/api/v1/databases/foreground/rename", json={"database": db, "name": renamed}, headers=token
    ).status_code == 200
    assert _folders(client, token)["of"] == {renamed: fid}

    copy = renamed + "-copy"
    assert client.post(
        "/api/v1/databases/foreground/duplicate", json={"source": renamed, "name": copy}, headers=token
    ).status_code == 200
    assert _folders(client, token)["of"] == {renamed: fid, copy: fid}

    assert client.post(
        "/api/v1/databases/foreground/delete", json={"database": copy}, headers=token
    ).status_code == 200
    # A later model of the same name must not inherit a folder nobody chose for it.
    assert _folders(client, token)["of"] == {renamed: fid}


def test_a_model_sits_in_at_most_one_folder_and_can_leave(client, token, project):
    db = _fg(client, token)
    one = client.post("/api/v1/databases/folders", json={"name": "One"}, headers=token).json()["id"]
    two = client.post("/api/v1/databases/folders", json={"name": "Two"}, headers=token).json()["id"]

    client.post("/api/v1/databases/folders/assign", json={"database": db, "folder_id": one}, headers=token)
    client.post("/api/v1/databases/folders/assign", json={"database": db, "folder_id": two}, headers=token)
    assert _folders(client, token)["of"] == {db: two}

    client.post("/api/v1/databases/folders/assign", json={"database": db, "folder_id": None}, headers=token)
    assert _folders(client, token)["of"] == {}


def test_assigning_to_a_folder_that_is_not_there_is_refused(client, token, project):
    db = _fg(client, token)
    r = client.post(
        "/api/v1/databases/folders/assign", json={"database": db, "folder_id": "nope"}, headers=token
    )
    assert r.status_code == 404 and r.json()["error"]["code"] == "folder_not_found"


def test_folders_are_always_alphabetical(client, token, project):
    """No hand-made order: a list you can predict without having seen it before beats one somebody
    has to maintain, and forgets to when adding a folder from the create dialog."""
    for n in ("Zink", "obst", "Öl", "Abfall"):
        assert client.post("/api/v1/databases/folders", json={"name": n}, headers=token).status_code == 200
    # Accents are folded for sorting: "Öl" belongs next to "obst", not off the end after "Zink".
    assert [f["name"] for f in _folders(client, token)["folders"]] == ["Abfall", "obst", "Öl", "Zink"]

    # And a folder added later lands in its place, not at the end.
    assert client.post("/api/v1/databases/folders", json={"name": "Beton"}, headers=token).status_code == 200
    assert [f["name"] for f in _folders(client, token)["folders"]] == [
        "Abfall", "Beton", "obst", "Öl", "Zink"
    ]


def test_renaming_a_folder_moves_it_to_its_new_place(client, token, project):
    fid = client.post("/api/v1/databases/folders", json={"name": "Alpha"}, headers=token).json()["id"]
    client.post("/api/v1/databases/folders", json={"name": "Beta"}, headers=token)
    assert [f["name"] for f in _folders(client, token)["folders"]] == ["Alpha", "Beta"]
    assert client.post(
        "/api/v1/databases/folders/rename", json={"id": fid, "name": "Zulu"}, headers=token
    ).status_code == 200
    assert [f["name"] for f in _folders(client, token)["folders"]] == ["Beta", "Zulu"]


# --- V237: a tag registers its dimension ---------------------------------------------------------


def _act(client, token, db: str) -> str:
    return client.post(
        "/api/v1/model/activities", json={"database": db, "name": "p", "unit": "kg"}, headers=token
    ).json()["activity"]["code"]


def test_setting_a_tag_registers_its_dimension_and_value(client, token, project):
    """A dimension that exists only on the activity is invisible: every picker reads the GROUP list,
    so the report could not group by a phase every process carried (V237)."""
    db = _fg(client, token)
    code = _act(client, token, db)

    assert client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": db, "code": code}], "group": "Lebenswegphase", "value": "Herstellung"},
        headers=token,
    ).status_code == 200

    groups = client.get("/api/v1/model/tag-groups", headers=token).json()["groups"]
    mine = next((g for g in groups if g["name"] == "Lebenswegphase"), None)
    assert mine is not None, [g["name"] for g in groups]
    assert "Herstellung" in mine["values"]
    # …and it is reported as used by this model, which is what makes a picker offer it.
    assert db in mine["databases"]


def test_clearing_a_tag_does_not_invent_a_dimension(client, token, project):
    db = _fg(client, token)
    code = _act(client, token, db)
    assert client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": db, "code": code}], "group": "Nothing", "value": ""},
        headers=token,
    ).status_code == 200
    groups = [g["name"] for g in client.get("/api/v1/model/tag-groups", headers=token).json()["groups"]]
    assert "Nothing" not in groups


def test_undo_of_a_tag_keeps_the_dimension(client, token, project):
    """The dimension is config: taking it back would strip it from every other process tagged since."""
    db = _fg(client, token)
    code = _act(client, token, db)
    client.post(
        "/api/v1/model/tags/set",
        json={"keys": [{"database": db, "code": code}], "group": "Phase X", "value": "A"},
        headers=token,
    )
    assert client.post("/api/v1/model/undo", headers=token).status_code == 200
    groups = [g["name"] for g in client.get("/api/v1/model/tag-groups", headers=token).json()["groups"]]
    assert "Phase X" in groups


# --- V246: one dimension, however it is spelled -------------------------------------------------


def test_a_second_spelling_of_one_dimension_joins_the_first(project):
    """One project held four parallel phase vocabularies — "Phase", "Life-cycle phase", "Life cycle
    phase" (with no values at all) and "Lebenswegphase" — so no breakdown could be chosen across two
    models. The cause was a collision of two rules, not a missing convention: the skill has named
    "Life-cycle phase" all along, and the language rule made a model translate it."""
    from prism_lca.engine.tag_groups import TagGroupStore, same_dimension

    store = TagGroupStore()
    store.create_group("Life-cycle phase")

    # A tag WRITE never fails over a naming question — it joins the group that already means this.
    for spelling in ("Life cycle phase", "Lebenswegphase", "Phase", "Phase du cycle de vie"):
        assert store.find_or_create(spelling)["name"] == "Life-cycle phase", spelling
    assert [g["name"] for g in store.list_groups()] == ["Life-cycle phase"]

    # An explicit create is refused like a duplicate, and the message names the group to use.
    with pytest.raises(PrismError) as e:
        store.create_group("Lebenswegphase")
    assert "Life-cycle phase" in str(e.value)

    # A genuinely different dimension is untouched — guessing at synonyms in general would merge
    # dimensions somebody meant to keep apart.
    assert store.create_group("Supplier")["name"] == "Supplier"
    assert store.find_or_create("Material")["name"] == "Material"
    assert not same_dimension("Supplier", "Life-cycle phase")
