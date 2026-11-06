"""Undo and redo of a bundle import: the model's own stores are set aside and put back.

A redo re-creates what the bundle brought. What the model gathered after the import — chats with
their transcripts and attachments, reports, logs, the canvas, its folder — lives only in the
per-model stores; the undo sets it aside and the redo puts it back. The set-aside goes with the
undo step and never reaches another workspace.
"""

from __future__ import annotations

import base64
import gc

import pytest
from test_bundle import _b64, _export, fill_source

from prism_lca.engine import attachments, chat_store, chat_transcripts, model_folders
from prism_lca.engine.chat_store import ChatStore
from prism_lca.engine.report_store import ReportStore
from prism_lca.engine.research_log import ResearchLogStore
from prism_lca.engine.review_log import ReviewLogStore
from prism_lca.engine.study import StudyMetaStore
from prism_lca.engine.view_store import ViewStore

CHATS = "/api/v1/ai/chats"


@pytest.fixture
def imported(client, token, project, monkeypatch) -> str:
    """A model imported from a bundle; attachments count as unreferenced at once (no grace period)."""
    del project
    monkeypatch.setattr(attachments, "GRACE_SECONDS", 0)
    data = _export(client, token, fill_source(client, token))
    r = client.post("/api/v1/bundle/import", json={"content": _b64(data), "name": "Imported"}, headers=token)
    assert r.status_code == 200, r.text
    return r.json()["database"]


def _databases(client, token) -> set[str]:
    return {d["name"] for d in client.get("/api/v1/databases", headers=token).json()}


def _gather(client, token, db: str) -> dict:
    """What a model gathers after its import without a single undoable step: a chat with an attachment
    and a transcript, a report, both logs, a canvas arrangement, a folder."""
    r = client.post(
        "/api/v1/files/attachments",
        json={"name": "spec.txt", "data_b64": base64.b64encode(b"the specification").decode("ascii")},
        headers=token,
    )
    assert r.status_code == 200, r.text
    attachment = r.json()["id"]
    chat = client.post(f"{CHATS}/{db}", json={"title": "Build"}, headers=token).json()["id"]
    r = client.post(
        f"{CHATS}/{db}/{chat}/messages",
        json={"messages": [
            {"role": "user", "content": "see file", "attachments": [{"id": attachment, "name": "spec.txt"}]},
            {"role": "assistant", "content": "read it", "turn_id": "t1"},
        ]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    r = client.put(
        f"{CHATS}/{db}/{chat}/transcript", json={"turn_id": "t1", "history_after": [], "messages": []}, headers=token
    )
    assert r.status_code == 200, r.text
    ReportStore().create(db, name="Draft")
    ResearchLogStore().record(db, [{"question": "q?", "findings": [{"text": "f", "sources": []}]}])
    ReviewLogStore().record_review(db, "looks fine")
    code = client.get(f"/api/v1/model/activities/{db}", headers=token).json()[0]["code"]
    r = client.put(f"/api/v1/views/{db}", json={"view": {"layout": {"pos": {f"{db}/{code}": {"x": 7, "y": 9}}}}},
                   headers=token)
    assert r.status_code == 200, r.text
    folder = model_folders.create("Bottles")["id"]
    model_folders.assign(db, folder)
    return {
        "chat": chat,
        "attachment": attachment,
        "code": code,
        "folder": folder,
        "transcript": chat_transcripts.read_raw(chat),
        "chat_body": ChatStore().get_chat(db, chat),
        "reports": ReportStore().list_reports(db),
    }


def _undo(client, token) -> None:
    r = client.post("/api/v1/model/undo", headers=token)
    assert r.status_code == 200, r.text


def _redo(client, token):
    return client.post("/api/v1/model/redo", headers=token)


def _live_set_asides() -> list:
    gc.collect()
    with chat_store._SET_ASIDE_LOCK:
        return list(chat_store._SET_ASIDE)


def test_undo_then_redo_brings_back_what_the_model_gathered(client, token, imported):
    db = imported
    before = _gather(client, token, db)
    view = ViewStore().get(db)
    r = client.post("/api/v1/databases/foreground", json={"name": "Partner"}, headers=token)
    assert r.status_code == 200, r.text
    StudyMetaStore().link(db, "Partner")

    _undo(client, token)
    assert db not in _databases(client, token)
    assert ChatStore().list_chats(db) == []
    assert StudyMetaStore().compared_with("Partner") == []
    assert chat_transcripts.read_raw(before["chat"]) is None
    # A prune while the import is undone must not take a file the set-aside chat cites.
    assert before["attachment"] not in attachments.prune_unreferenced()
    assert attachments.path_of(before["attachment"]).exists()

    r = _redo(client, token)
    assert r.status_code == 200, r.text
    assert db in _databases(client, token)
    assert ChatStore().get_chat(db, before["chat"]) == before["chat_body"]
    assert chat_transcripts.read_raw(before["chat"]) == before["transcript"]
    assert attachments.path_of(before["attachment"]).exists()
    assert ReportStore().list_reports(db) == before["reports"]
    assert [e["question"] for e in ResearchLogStore().list(db)] == ["q?"]
    assert [e["review"] for e in ReviewLogStore().list(db)] == ["looks fine"]
    assert ViewStore().get(db) == view
    assert model_folders.state()["of"].get(db) == before["folder"]
    # The comparison is symmetric: the partner names the model again, not only the other way round.
    assert StudyMetaStore().compared_with(db) == ["Partner"]
    assert StudyMetaStore().compared_with("Partner") == [db]
    # Put back once, then let go: nothing stays held after the redo.
    assert _live_set_asides() == []


def test_the_set_aside_goes_with_the_undo_step(client, token, imported):
    """A new change clears the redo stack: the set-aside is dropped with the step, and the files only
    it cited become ordinary unreferenced files again."""
    db = imported
    before = _gather(client, token, db)
    _undo(client, token)
    assert len(_live_set_asides()) == 1

    r = client.post("/api/v1/databases/foreground", json={"name": "Other"}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/model/activities",
        json={"database": "Other", "name": "x", "unit": "kilogram", "location": "GLO"},
        headers=token,
    )
    assert r.status_code == 200, r.text
    assert _redo(client, token).status_code == 409
    assert _live_set_asides() == []
    assert before["attachment"] in attachments.prune_unreferenced()


def test_the_set_aside_never_reaches_another_workspace(client, token, imported):
    db = imported
    _gather(client, token, db)
    _undo(client, token)

    r = client.post("/api/v1/projects", json={"name": "other-workspace"}, headers=token)
    assert r.status_code == 200, r.text
    assert _redo(client, token).status_code == 409
    assert _live_set_asides() == []
    r = client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    assert r.status_code == 200, r.text
    assert ChatStore().list_chats(db) == []
    assert ReportStore().list_reports(db) == []


def test_put_back_refuses_another_workspace(client, token, imported):
    from prism_lca.engine import model_aside

    db = imported
    _gather(client, token, db)
    aside = model_aside.set_aside(db)
    r = client.post("/api/v1/projects", json={"name": "elsewhere"}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    assert r.status_code == 200, r.text

    assert model_aside.put_back(aside, db) is False
    assert ChatStore().list_chats(db) == []
    assert ViewStore().get(db) == {}


def test_a_redo_into_a_taken_name_brings_the_stores_along(client, token, imported):
    """A model created under the old name meanwhile keeps its own (empty) stores; the redo lands beside
    it, and the set-aside follows the model there — canvas keys included."""
    db = imported
    before = _gather(client, token, db)
    _undo(client, token)
    r = client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    assert r.status_code == 200, r.text

    r = _redo(client, token)
    assert r.status_code == 200, r.text
    moved = f"{db} (2)"
    assert moved in _databases(client, token)
    assert ChatStore().get_chat(moved, before["chat"]) == before["chat_body"]
    assert ChatStore().list_chats(db) == []
    assert ViewStore().get(moved)["layout"]["pos"] == {f"{moved}/{before['code']}": {"x": 7, "y": 9}}
    assert model_folders.state()["of"].get(moved) == before["folder"]
    assert db not in model_folders.state()["of"]


def test_a_failed_redo_keeps_the_set_aside_for_the_next_try(client, token, imported, monkeypatch):
    from prism_lca.errors import PrismError

    db = imported
    before = _gather(client, token, db)
    _undo(client, token)

    real = ReportStore.restore_database

    def fail_once(self, database, reports):
        monkeypatch.setattr(ReportStore, "restore_database", real)
        raise PrismError("disk full", code="test_disk_full")

    monkeypatch.setattr(ReportStore, "restore_database", fail_once)
    assert _redo(client, token).status_code >= 400
    assert db not in _databases(client, token)
    assert attachments.path_of(before["attachment"]).exists()

    r = _redo(client, token)
    assert r.status_code == 200, r.text
    assert ChatStore().get_chat(db, before["chat"]) == before["chat_body"]
    assert chat_transcripts.read_raw(before["chat"]) == before["transcript"]
    assert ReportStore().list_reports(db) == before["reports"]


def test_a_redo_keeps_the_parameter_groups_under_their_ids(client, token, project):
    """Steps after the import name a group by id; the redo of the import must not re-mint it, and the
    parameters stay filed in it."""
    del project
    src = fill_source(client, token)
    r = client.post("/api/v1/params/groups", json={"database": src, "name": "Masses"}, headers=token)
    assert r.status_code == 200, r.text
    gid = r.json()["group"]["id"] if "group" in r.json() else r.json()["id"]
    r = client.post("/api/v1/params/group", json={"database": src, "name": "mass_kg", "group_id": gid}, headers=token)
    assert r.status_code == 200, r.text
    r = client.post(
        "/api/v1/bundle/import", json={"content": _b64(_export(client, token, src)), "name": "Grouped"}, headers=token
    )
    assert r.status_code == 200, r.text

    def groups() -> list[dict]:
        body = client.get("/api/v1/params/groups", params={"database": "Grouped"}, headers=token).json()
        return body if isinstance(body, list) else body["groups"]

    before = groups()
    _undo(client, token)
    assert _redo(client, token).status_code == 200
    assert [(g["id"], g["name"]) for g in groups()] == [(g["id"], g["name"]) for g in before]
    params = client.get("/api/v1/params", params={"database": "Grouped"}, headers=token).json()
    mass = next(p for p in params if p["name"] == "mass_kg")
    assert (mass["group"], mass["group_id"]) == ("Masses", before[0]["id"])


def test_a_prune_meeting_an_undo_halfway_still_sees_the_chat(project, monkeypatch):
    """A prune that has read the set-aside chats but not yet the stored ones while an undo sets a model's
    chats aside and deletes them: the cited file must count as cited in one of the two reads."""
    import threading

    del project
    db = "racing"
    store = ChatStore()
    chat = store.create_chat(db, "t")["id"]
    store.append_messages(db, chat, [{"role": "user", "content": "x", "attachments": [{"id": "a1", "name": "a"}]}])

    real = ChatStore._load
    paused, go = threading.Event(), threading.Event()
    seen: list[set[str]] = []

    def load(self):
        if threading.current_thread() is pruner:
            paused.set()
            go.wait(5)
        return real(self)

    monkeypatch.setattr(ChatStore, "_load", load)
    pruner = threading.Thread(target=lambda: seen.append(ChatStore().attachment_ids()))
    pruner.start()
    assert paused.wait(5)

    held: list = []
    undo = threading.Thread(target=lambda: (held.append(ChatStore().snapshot_database(db)),
                                            ChatStore().remove_database(db)))
    undo.start()
    undo.join(1)  # it may finish here, or wait for the prune to let go
    go.set()
    pruner.join(5)
    undo.join(5)
    assert seen == [{"a1"}]
    assert held and not ChatStore().list_chats(db)
