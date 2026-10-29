"""``X-Prism-Model``: the in-app chat names the model it runs in, and no write of the request may land
outside it (engine/model_scope.py). Without the header — the app, an MCP session — nothing changes."""

from __future__ import annotations

import inspect
import uuid
from urllib.parse import quote

from fastapi.testclient import TestClient

from prism_lca.engine import commands, guardrails
from prism_lca.engine.commands import Command
from prism_lca.engine.library import LIBRARY_DB, ensure_library


def _fg(client: TestClient, token, name: str | None = None) -> str:
    db = name or "fg-" + uuid.uuid4().hex[:6]
    r = client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    assert r.status_code == 200, r.text
    return db


def _create(client: TestClient, headers, db: str, name: str = "P"):
    return client.post("/api/v1/model/activities", json={"database": db, "name": name, "unit": "kg"}, headers=headers)


def _code(client: TestClient, token, db: str, name: str = "P") -> str:
    r = _create(client, token, db, name)
    assert r.status_code == 200, r.text
    return r.json()["activity"]["code"]


def _fenced(token, model: str) -> dict[str, str]:
    return {**token, "X-Prism-Model": quote(model, safe="")}


def _refused(r) -> None:
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "outside_model_scope"


def _names(client: TestClient, token, db: str) -> list[str]:
    r = client.get(f"/api/v1/model/activities/{db}", headers=token)
    assert r.status_code == 200, r.text
    return [a["name"] for a in r.json()]


def test_without_the_header_nothing_is_fenced(client, token, project):
    _fg(client, token, "A")
    _fg(client, token, "B")
    assert _create(client, token, "B", "Free").status_code == 200


def test_a_write_lands_in_the_fenced_model_and_nowhere_else(client, token, project):
    _fg(client, token, "A")
    _fg(client, token, "B")
    chat = _fenced(token, "A")
    assert _create(client, chat, "A", "Mine").status_code == 200
    _refused(_create(client, chat, "B", "Ghost"))
    assert "Ghost" not in _names(client, token, "B")
    # A fence around no model (a chat with none open) lets nothing through.
    _refused(_create(client, {**token, "X-Prism-Model": ""}, "A", "Nowhere"))


def test_unicode_model_names_travel_percent_encoded(client, token, project):
    name = "Müller-研究-" + uuid.uuid4().hex[:4]
    _fg(client, token, name)
    assert _create(client, _fenced(token, name), name).status_code == 200


def test_models_are_not_created_copied_or_deleted_but_the_own_one_may_be_renamed(client, token, project):
    _fg(client, token, "A")
    _fg(client, token, "B")
    chat = _fenced(token, "A")
    _refused(client.post("/api/v1/databases/foreground", json={"name": "New"}, headers=chat))
    _refused(client.post("/api/v1/databases/foreground/duplicate", json={"source": "A", "name": "A2"}, headers=chat))
    _refused(client.post("/api/v1/databases/foreground/delete", json={"database": "A"}, headers=chat))
    _refused(client.post("/api/v1/databases/foreground/delete", json={"database": "B"}, headers=chat))
    _refused(client.post("/api/v1/databases/foreground/rename", json={"database": "B", "name": "B2"}, headers=chat))
    r = client.post("/api/v1/databases/foreground/rename", json={"database": "A", "name": "A-renamed"}, headers=chat)
    assert r.status_code == 200, r.text
    names = {d["name"] for d in client.get("/api/v1/databases", headers=token).json()}
    assert {"A-renamed", "B"} <= names and not {"New", "A2", "B2"} & names


def test_inputs_come_from_the_model_the_library_and_the_background_never_another_model(client, token, project):
    _fg(client, token, "A")
    _fg(client, token, "B")
    bg = _fg(client, token, "bg-" + uuid.uuid4().hex[:6])
    bg_code = _code(client, token, bg, "steel")
    guardrails.set_read_only(bg, True)
    ensure_library()
    lib_code = _code(client, token, LIBRARY_DB, "own coating")
    other = _code(client, token, "B", "cap")
    mine = _code(client, token, "A", "bottle")
    chat = _fenced(token, "A")

    def link(db: str, code: str):
        body = {"activity_database": "A", "activity_code": mine, "input_database": db, "input_code": code, "amount": 1}
        return client.post("/api/v1/model/exchanges", json=body, headers=chat)

    assert link(bg, bg_code).status_code == 200
    assert link(LIBRARY_DB, lib_code).status_code == 200
    r = link("B", other)
    _refused(r)
    assert "comparison model included" in r.json()["error"]["message"]


def test_the_library_is_read_only_for_a_fenced_request(client, token, project):
    _fg(client, token, "A")
    ensure_library()
    _refused(_create(client, _fenced(token, "A"), LIBRARY_DB, "Snuck in"))


def test_comparison_links_are_the_users_to_make(client, token, project):
    _fg(client, token, "A")
    _fg(client, token, "B")
    _refused(client.post("/api/v1/study/link", json={"database": "A", "other": "B"}, headers=_fenced(token, "A")))


def _tag(client: TestClient, token, db: str, code: str, value: str) -> None:
    body = {"keys": [{"database": db, "code": code}], "group": "Phase", "value": value}
    assert client.post("/api/v1/model/tags/set", json=body, headers=token).status_code == 200


def _tags(client: TestClient, token, db: str, code: str) -> list[dict]:
    return client.get(f"/api/v1/model/tags/{db}/{code}", headers=token).json()


def test_a_tag_merge_is_refused_while_another_model_carries_the_value(client, token, project):
    _fg(client, token, "A")
    _fg(client, token, "B")
    assert client.post("/api/v1/model/tag-groups", json={"name": "Phase"}, headers=token).status_code == 200
    for v in ("Use", "Usage"):
        client.post("/api/v1/model/tag-groups/values", json={"group": "Phase", "value": v}, headers=token)
    a, b = _code(client, token, "A"), _code(client, token, "B")
    _tag(client, token, "A", a, "Usage")
    _tag(client, token, "B", b, "Usage")
    chat = _fenced(token, "A")
    merge = {"group": "Phase", "value": "Usage", "into": "Use"}

    r = client.post("/api/v1/model/tag-groups/values/merge", json=merge, headers=chat)
    _refused(r)
    assert "‘B’" in r.json()["error"]["message"]
    assert _tags(client, token, "B", b) == [{"dimension": "Phase", "value": "Usage"}]

    _tag(client, token, "B", b, "Use")
    r = client.post("/api/v1/model/tag-groups/values/merge", json=merge, headers=chat)
    assert r.status_code == 200, r.text
    assert _tags(client, token, "A", a) == [{"dimension": "Phase", "value": "Use"}]


def test_undo_stays_in_the_fenced_model(client, token, project):
    _fg(client, token, "A")
    _fg(client, token, "B")
    chat = _fenced(token, "A")
    _refused(client.post("/api/v1/model/undo", json={"database": "B"}, headers=chat))
    _refused(client.post("/api/v1/model/undo", json={}, headers=chat))  # the workspace-wide stack

    # A workspace-wide step that reached into A and B — the user's merge — is not the chat's to take back.
    assert client.post("/api/v1/model/tag-groups", json={"name": "Phase"}, headers=token).status_code == 200
    for v in ("Use", "Usage"):
        client.post("/api/v1/model/tag-groups/values", json={"group": "Phase", "value": v}, headers=token)
    a, b = _code(client, token, "A"), _code(client, token, "B")
    _tag(client, token, "A", a, "Usage")
    _tag(client, token, "B", b, "Usage")
    merged = client.post(
        "/api/v1/model/tag-groups/values/merge", json={"group": "Phase", "value": "Usage", "into": "Use"}, headers=token
    )
    assert merged.status_code == 200, merged.text
    _refused(client.post("/api/v1/model/undo", json={"database": "A"}, headers=chat))
    assert _tags(client, token, "B", b) == [{"dimension": "Phase", "value": "Use"}]


def test_provenance_is_written_into_the_fenced_model_only(client, token, project):
    _fg(client, token, "A")
    _fg(client, token, "B")
    chat = _fenced(token, "A")
    body = {"review": "fine", "gaps": []}
    assert client.post("/api/v1/provenance/review", json={**body, "database": "A"}, headers=chat).status_code == 200
    _refused(client.post("/api/v1/provenance/review", json={**body, "database": "B"}, headers=chat))


def test_a_name_is_fenced_as_the_database_it_reaches(client, token, project):
    """The routes resolve names tolerantly (case and punctuation do not count); so does the fence."""
    _fg(client, token, "Bottle PET")
    _fg(client, token, "Bottle Glass")
    glass = _code(client, token, "Bottle Glass", "cap")
    mine = _code(client, token, "Bottle PET", "bottle")
    chat = _fenced(token, "Bottle PET")
    _refused(_create(client, chat, "bottle glass", "Ghost"))
    assert _create(client, chat, "bottle-pet", "Mine").status_code == 200
    body = {"activity_database": "Bottle PET", "activity_code": mine, "input_database": "bottle_glass", "input_code": glass, "amount": 1}
    _refused(client.post("/api/v1/model/exchanges", json=body, headers=chat))


def test_a_forced_delete_may_not_cut_another_models_input(client, token, project):
    _fg(client, token, "A")
    _fg(client, token, "B")
    mine = _code(client, token, "A", "shared part")
    theirs = _code(client, token, "B", "assembly")
    body = {"activity_database": "B", "activity_code": theirs, "input_database": "A", "input_code": mine, "amount": 1}
    assert client.post("/api/v1/model/exchanges", json=body, headers=token).status_code == 200
    chat = _fenced(token, "A")
    r = client.post("/api/v1/model/activities/delete", json={"database": "A", "code": mine, "force": True}, headers=chat)
    _refused(r)
    assert "‘B’" in r.json()["error"]["message"]
    own = _code(client, token, "A", "unused")
    ok = client.post("/api/v1/model/activities/delete", json={"database": "A", "code": own, "force": True}, headers=chat)
    assert ok.status_code == 200, ok.text


def test_redo_does_not_bring_back_a_link_the_chat_may_not_make(client, token, project):
    """The user linked A to B and undid it; the chat's redo would make that link again."""
    _fg(client, token, "A")
    _fg(client, token, "B")
    theirs = _code(client, token, "B", "cap")
    mine = _code(client, token, "A", "bottle")
    body = {"activity_database": "A", "activity_code": mine, "input_database": "B", "input_code": theirs, "amount": 1}
    assert client.post("/api/v1/model/exchanges", json=body, headers=token).status_code == 200
    assert client.post("/api/v1/model/undo", json={"database": "A"}, headers=token).status_code == 200
    _refused(client.post("/api/v1/model/redo", json={"database": "A"}, headers=_fenced(token, "A")))


def test_tag_keys_are_split_from_the_right_like_the_store_does(client, token, project):
    """A model name may hold a slash; a code does not. A merge reaching model ‘A/B’ is not model ‘A’'s."""
    r = client.post("/api/v1/databases/foreground", json={"name": "A/B"}, headers=token)
    if r.status_code != 200:
        import pytest

        pytest.skip(f"model names with a slash are refused here: {r.text}")
    _fg(client, token, "A")
    assert client.post("/api/v1/model/tag-groups", json={"name": "Phase"}, headers=token).status_code == 200
    for v in ("Use", "Usage"):
        client.post("/api/v1/model/tag-groups/values", json={"group": "Phase", "value": v}, headers=token)
    slashed = _code(client, token, "A/B")
    _tag(client, token, "A/B", slashed, "Usage")
    merge = {"group": "Phase", "value": "Usage", "into": "Use"}
    _refused(client.post("/api/v1/model/tag-groups/values/merge", json=merge, headers=_fenced(token, "A")))
    r = client.post("/api/v1/model/tag-groups/values/merge", json=merge, headers=_fenced(token, "A/B"))
    assert r.status_code == 200, r.text


def test_undo_does_not_take_back_a_step_that_reached_beyond_the_model(client, token, project):
    """Attributed to A, but its undo rewrites the library and B's input: moved to the library by the user."""
    _fg(client, token, "A")
    _fg(client, token, "B")
    ensure_library()
    part = _code(client, token, "A", "part")
    theirs = _code(client, token, "B", "assembly")
    link = {"activity_database": "B", "activity_code": theirs, "input_database": "A", "input_code": part, "amount": 1}
    assert client.post("/api/v1/model/exchanges", json=link, headers=token).status_code == 200
    moved = client.post("/api/v1/model/activities/to-library", json={"database": "A", "code": part}, headers=token)
    assert moved.status_code == 200, moved.text
    _refused(client.post("/api/v1/model/undo", json={"database": "A"}, headers=_fenced(token, "A")))
    assert client.post("/api/v1/model/undo", json={"database": "A"}, headers=token).status_code == 200


def test_undo_may_take_back_a_link_to_another_model(client, token, project):
    """Taking a link back removes it — the chat may untangle what it may not create."""
    _fg(client, token, "A")
    _fg(client, token, "B")
    theirs = _code(client, token, "B", "cap")
    mine = _code(client, token, "A", "bottle")
    body = {"activity_database": "A", "activity_code": mine, "input_database": "B", "input_code": theirs, "amount": 1}
    assert client.post("/api/v1/model/exchanges", json=body, headers=token).status_code == 200
    r = client.post("/api/v1/model/undo", json={"database": "A"}, headers=_fenced(token, "A"))
    assert r.status_code == 200, r.text


def test_parameters_and_scenarios_are_listed_under_a_loose_spelling_too(client, token, project):
    _fg(client, token, "Bottle Glass")
    p = client.post("/api/v1/params", json={"database": "Bottle Glass", "name": "km", "amount": 300}, headers=token)
    assert p.status_code == 200, p.text
    s = client.post("/api/v1/scenarios", json={"database": "Bottle Glass", "name": "Far", "overrides": {"km": 900}}, headers=token)
    assert s.status_code == 200, s.text
    params = client.get("/api/v1/params?database=bottle-glass", headers=token).json()
    assert [x["name"] for x in params] == ["km"]
    scen = client.get("/api/v1/scenarios?database=bottle-glass", headers=token).json()
    assert [x["name"] for x in scen] == ["Far"]


def test_every_command_says_which_models_it_writes_before_it_runs():
    """The fence asks ``scope_models()`` before ``execute()``. The default answers from ``audit_attr``;
    a command without one must answer for itself — otherwise the fence refuses it in every chat, which
    is safe and will look like a bug, so this says where the decision belongs instead."""
    undecided = [
        cls.__name__
        for cls in vars(commands).values()
        if inspect.isclass(cls)
        and issubclass(cls, Command)
        and cls is not Command
        and not inspect.isabstract(cls)
        and not cls.audit_attr
        and "scope_models" not in vars(cls)
    ]
    assert not undecided, f"Override scope_models() on: {', '.join(sorted(undecided))}"
