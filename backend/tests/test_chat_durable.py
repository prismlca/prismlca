"""Durable agentic chat, backend half: plan and run on a chat, the turn record, the transcript file.

The types are frontend/src/shared/plan.ts.
"""

from __future__ import annotations

import os
import time

import pytest

from prism_lca.engine import chat_transcripts

API = "/api/v1/ai/chats"


def _chat(client, token, db: str) -> str:
    return client.post(f"{API}/{db}", json={}, headers=token).json()["id"]


PLAN = {
    "title": "Build the bottle model",
    "steps": [
        {"step": "Find the granulate dataset", "status": "completed", "note": "PET, RER"},
        {"step": "Link the transport", "status": "in_progress"},
        {"step": "Check the result", "status": "pending"},
        {"step": "Allocation", "status": "skipped", "note": "single output"},
    ],
    "revision": 3,
    "updated": "2026-10-01T10:00:00+00:00",
}


def test_plan_and_run_round_trip_through_the_store(client, token, project):
    db = "fg-durable"
    cid = _chat(client, token, db)

    r = client.put(f"{API}/{db}/{cid}/plan", json={"plan": PLAN}, headers=token)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "plan": PLAN}

    run = {"runId": "abc123", "state": "running", "startedAt": "2026-10-01T10:00:00+00:00", "turnId": "t1",
           "costUsd": 0.12, "costLimitUsd": 15, "rounds": 4, "junk": "dropped"}
    r = client.put(f"{API}/{db}/{cid}/run", json=run, headers=token)
    assert r.status_code == 200, r.text
    stored_run = r.json()["run"]
    assert "junk" not in stored_run
    assert stored_run["state"] == "running" and stored_run["turnId"] == "t1" and stored_run["rounds"] == 4

    chat = client.get(f"{API}/{db}/{cid}", headers=token).json()
    assert chat["plan"] == PLAN
    assert chat["run"] == stored_run

    # null removes the field
    r = client.put(f"{API}/{db}/{cid}/plan", json={"plan": None}, headers=token)
    assert r.json() == {"ok": True, "plan": None}
    assert "plan" not in client.get(f"{API}/{db}/{cid}", headers=token).json()

    for path, body in (("plan", {"plan": PLAN}), ("run", run)):
        r = client.put(f"{API}/{db}/nochat/{path}", json=body, headers=token)
        assert r.status_code == 404 and r.json()["error"]["code"] == "chat_not_found", r.text


def test_the_store_caps_a_plan_rather_than_refusing_it(client, token, project):
    db = "fg-durable-cap"
    cid = _chat(client, token, db)
    big = {
        "title": "T" * 200,
        "steps": [{"step": "S" * 500, "status": "weird", "note": "N" * 900, "x": 1}] * 30 + ["not a step"],
        "revision": True,  # a bool is not a revision
        "extra": "dropped",
    }
    plan = client.put(f"{API}/{db}/{cid}/plan", json={"plan": big}, headers=token).json()["plan"]
    assert len(plan["title"]) == 60
    assert len(plan["steps"]) == 20
    step = plan["steps"][0]
    # An unknown status becomes pending — an unfinished step may not vanish from the list.
    assert step == {"step": "S" * 120, "status": "pending", "note": "N" * 300}
    assert plan["revision"] == 0 and plan["updated"]
    assert "extra" not in plan


def test_summaries_carry_plan_progress_and_run_state(client, token, project):
    db = "fg-durable-list"
    with_plan = _chat(client, token, db)
    bare = _chat(client, token, db)
    client.put(f"{API}/{db}/{with_plan}/plan", json={"plan": PLAN}, headers=token)
    client.put(f"{API}/{db}/{with_plan}/run", json={"runId": "r1", "state": "stopped", "outcome": "cost",
                                                   "costUsd": 15.2}, headers=token)
    listing = {c["id"]: c for c in client.get(f"{API}/{db}", headers=token).json()["chats"]}
    # skipped is not completed
    assert listing[with_plan]["plan"] == {"title": "Build the bottle model", "completed": 1, "total": 4}
    assert listing[with_plan]["run"] == {"state": "stopped", "outcome": "cost"}
    assert listing[bare]["plan"] is None and listing[bare]["run"] is None


def test_mark_interrupted_flips_only_running_chats(client, token, project):
    running_a = _chat(client, token, "fg-a")
    stopped_a = _chat(client, token, "fg-a")
    running_b = _chat(client, token, "fg-b")
    idle_b = _chat(client, token, "fg-b")
    for db, cid, state in (("fg-a", running_a, "running"), ("fg-a", stopped_a, "stopped"),
                           ("fg-b", running_b, "running")):
        client.put(f"{API}/{db}/{cid}/run", json={"runId": cid, "state": state, "outcome": "answered"}
                   if state == "stopped" else {"runId": cid, "state": state}, headers=token)

    r = client.post(f"{API}/mark-interrupted", headers=token)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 2
    assert sorted((c["database"], c["id"]) for c in body["chats"]) == sorted(
        [("fg-a", running_a), ("fg-b", running_b)]
    )
    run = client.get(f"{API}/fg-a/{running_a}", headers=token).json()["run"]
    assert run["state"] == "interrupted" and run["outcome"] == "interrupted" and run["endedAt"]
    assert client.get(f"{API}/fg-a/{stopped_a}", headers=token).json()["run"] == {
        "runId": stopped_a, "state": "stopped", "outcome": "answered"}
    assert "run" not in client.get(f"{API}/fg-b/{idle_b}", headers=token).json()
    # the route did not create a model called "mark-interrupted"
    assert client.get(f"{API}/mark-interrupted", headers=token).json()["chats"] == []
    # second call: nothing left
    assert client.post(f"{API}/mark-interrupted", headers=token).json() == {"count": 0, "chats": []}


def test_an_empty_assistant_turn_is_stored_with_turn_id_and_outcome(client, token, project):
    db = "fg-durable-msg"
    cid = _chat(client, token, db)
    r = client.post(
        f"{API}/{db}/{cid}/messages",
        json={"messages": [
            {"role": "user", "content": "Build it"},
            {"role": "assistant", "content": "", "turn_id": "turn-1", "outcome": "cancelled",
             "tools": [{"name": "search", "status": "ok"}]},
            {"role": "assistant", "turn_id": "turn-2", "outcome": "nonsense"},
        ]},
        headers=token,
    )
    assert r.status_code == 200, r.text
    msgs = client.get(f"{API}/{db}/{cid}", headers=token).json()["messages"]
    assert len(msgs) == 3
    assert msgs[1]["content"] == "" and msgs[1]["turn_id"] == "turn-1" and msgs[1]["outcome"] == "cancelled"
    assert msgs[1]["tools"] == [{"name": "search", "status": "ok"}]
    # content may be omitted entirely; an unknown outcome is dropped, the turn is kept
    assert msgs[2]["content"] == "" and msgs[2]["turn_id"] == "turn-2" and "outcome" not in msgs[2]
    assert "turn_id" not in msgs[0]


# --- the transcript file ----------------------------------------------------------------------


def _transcript(turn: str = "t1", size: int = 10) -> dict:
    return {"turn_id": turn, "history_after": [{"role": "user", "content": "hi"}],
            "messages": [{"role": "assistant", "content": "x" * size, "tool_calls": [{"id": "c1"}]}]}


def test_transcript_put_get_delete(client, token, project):
    db = "fg-transcript"
    cid = _chat(client, token, db)
    assert client.get(f"{API}/{db}/{cid}/transcript", headers=token).json()["error"]["code"] == "transcript_not_found"

    r = client.put(f"{API}/{db}/{cid}/transcript", json=_transcript(), headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True and r.json()["bytes"] > 0
    path = chat_transcripts.transcript_dir() / f"{cid}.json"
    assert path.exists() and path.stat().st_size == r.json()["bytes"]
    assert path.parent.parent.name == "prism_meta"
    assert not list(path.parent.glob("*.tmp"))

    got = client.get(f"{API}/{db}/{cid}/transcript", headers=token).json()
    sent = _transcript()
    assert got["turn_id"] == "t1"
    assert got["history_after"] == sent["history_after"] and got["messages"] == sent["messages"]

    assert client.delete(f"{API}/{db}/{cid}/transcript", headers=token).json() == {"ok": True}
    assert not path.exists()
    assert client.delete(f"{API}/{db}/{cid}/transcript", headers=token).json() == {"ok": True}  # idempotent
    r = client.get(f"{API}/{db}/{cid}/transcript", headers=token)
    assert r.status_code == 404 and r.json()["error"]["code"] == "transcript_not_found"

    # an unknown chat gets no file
    r = client.put(f"{API}/{db}/nochat/transcript", json=_transcript(), headers=token)
    assert r.status_code == 404 and r.json()["error"]["code"] == "chat_not_found"


def test_a_transcript_over_6_mb_is_refused_and_the_old_one_stays(client, token, project):
    db = "fg-transcript-big"
    cid = _chat(client, token, db)
    client.put(f"{API}/{db}/{cid}/transcript", json=_transcript("old"), headers=token)
    r = client.put(f"{API}/{db}/{cid}/transcript", json=_transcript("new", 6 * 1024 * 1024 + 1), headers=token)
    assert r.status_code == 413, r.text
    assert r.json()["error"]["code"] == "transcript_too_large"
    assert client.get(f"{API}/{db}/{cid}/transcript", headers=token).json()["turn_id"] == "old"


def test_the_folder_cap_evicts_the_oldest_but_never_the_new_one(client, token, project, monkeypatch):
    db = "fg-transcript-cap"
    ids = [_chat(client, token, db) for _ in range(4)]
    for i, cid in enumerate(ids[:3]):
        client.put(f"{API}/{db}/{cid}/transcript", json=_transcript(cid, 1000), headers=token)
        # mtime decides, not the order of the directory listing
        t = time.time() - 100 + i
        os.utime(chat_transcripts.transcript_dir() / f"{cid}.json", (t, t))
    one = (chat_transcripts.transcript_dir() / f"{ids[0]}.json").stat().st_size
    # Room for three files: writing a fourth must evict exactly the oldest.
    monkeypatch.setattr(chat_transcripts, "MAX_FOLDER_BYTES", one * 3 + one // 2)
    client.put(f"{API}/{db}/{ids[3]}/transcript", json=_transcript(ids[3], 1000), headers=token)
    left = sorted(p.stem for p in chat_transcripts.transcript_dir().glob("*.json"))
    assert left == sorted(ids[1:])

    # A single file bigger than the whole cap still stays — it is the one just written.
    monkeypatch.setattr(chat_transcripts, "MAX_FOLDER_BYTES", 10)
    client.put(f"{API}/{db}/{ids[0]}/transcript", json=_transcript(ids[0], 1000), headers=token)
    assert [p.stem for p in chat_transcripts.transcript_dir().glob("*.json")] == [ids[0]]


def test_deleting_a_chat_or_its_model_takes_the_transcript_along(client, token, project):
    db = "fg-transcript-cascade"
    client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    gone, kept = _chat(client, token, db), _chat(client, token, db)
    other = _chat(client, token, "fg-other")
    for d, cid in ((db, gone), (db, kept), ("fg-other", other)):
        client.put(f"{API}/{d}/{cid}/transcript", json=_transcript(cid), headers=token)
    folder = chat_transcripts.transcript_dir()

    # The wrong model's id: nothing happens to the file.
    client.post(f"{API}/fg-other/{gone}/delete", headers=token)
    assert (folder / f"{gone}.json").exists()

    assert client.post(f"{API}/{db}/{gone}/delete", headers=token).status_code == 200
    assert not (folder / f"{gone}.json").exists()
    assert (folder / f"{kept}.json").exists()

    # A rename keeps it (keyed by chat id) …
    r = client.post("/api/v1/databases/foreground/rename", json={"database": db, "name": db + "-2"}, headers=token)
    assert r.status_code == 200, r.text
    assert client.get(f"{API}/{db}-2/{kept}/transcript", headers=token).json()["turn_id"] == kept
    # … a removal takes it.
    r = client.post("/api/v1/databases/foreground/delete", json={"database": db + "-2"}, headers=token)
    assert r.status_code == 200, r.text
    assert not (folder / f"{kept}.json").exists()
    assert (folder / f"{other}.json").exists()


@pytest.mark.parametrize("bad", ["../x", "a/b", "", "x" * 65])
def test_a_chat_id_never_becomes_a_path_outside_the_folder(bad, project):
    del project
    assert chat_transcripts.load(bad) is None
    chat_transcripts.delete(bad)  # no-op, no error
    with pytest.raises(ValueError):
        chat_transcripts.save(bad, "t", [], [])
