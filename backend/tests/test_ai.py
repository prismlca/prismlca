from __future__ import annotations


def test_skills_crud(client, token, project):
    # create
    r = client.post(
        "/api/v1/ai/skills",
        json={"name": "EPD helper", "description": "How to build EPDs", "content": "# steps\n1. ..."},
        headers=token,
    )
    assert r.status_code == 200, r.text
    sid = r.json()["id"]
    # list (all + enabled only)
    assert any(s["id"] == sid for s in client.get("/api/v1/ai/skills", headers=token).json()["skills"])
    assert client.get("/api/v1/ai/skills?enabled=true", headers=token).json()["skills"]
    # disable → drops from enabled-only listing
    client.post(f"/api/v1/ai/skills/{sid}", json={"enabled": False}, headers=token)
    assert not any(
        s["id"] == sid for s in client.get("/api/v1/ai/skills?enabled=true", headers=token).json()["skills"]
    )
    # delete
    client.post(f"/api/v1/ai/skills/{sid}/delete", headers=token)
    assert not any(s["id"] == sid for s in client.get("/api/v1/ai/skills", headers=token).json()["skills"])


def test_builtin_skill(client, token, project):
    skills = client.get("/api/v1/ai/skills", headers=token).json()["skills"]
    builtin = next(s for s in skills if s.get("builtin"))
    assert builtin["id"] == "builtin-model-building"
    assert builtin["enabled"] is True
    # cannot edit content or delete
    r = client.post(f"/api/v1/ai/skills/{builtin['id']}", json={"content": "x"}, headers=token)
    assert r.status_code == 400
    r = client.post(f"/api/v1/ai/skills/{builtin['id']}/delete", headers=token)
    assert r.status_code == 400
    # toggle persists and drops it from the enabled-only listing
    r = client.post(f"/api/v1/ai/skills/{builtin['id']}", json={"enabled": False}, headers=token)
    assert r.status_code == 200 and r.json()["enabled"] is False
    enabled = client.get("/api/v1/ai/skills?enabled=true", headers=token).json()["skills"]
    assert not any(s["id"] == builtin["id"] for s in enabled)
    client.post(f"/api/v1/ai/skills/{builtin['id']}", json={"enabled": True}, headers=token)
    enabled = client.get("/api/v1/ai/skills?enabled=true", headers=token).json()["skills"]
    assert any(s["id"] == builtin["id"] for s in enabled)


def test_builtin_playbook_skills(client, token, project):
    """The consultant playbooks ship as built-ins. Only their DESCRIPTION reaches the system prompt,
    so it has to state when to load the skill — hence the length/content assertions."""
    skills = client.get("/api/v1/ai/skills", headers=token).json()["skills"]
    by_id = {s["id"]: s for s in skills if s.get("builtin")}

    expected = {
        "builtin-goal-scope",
        "builtin-bom",
        "builtin-eol-scenarios",
        "builtin-interpretation",
        "builtin-review",
        # pre-existing ones must survive
        "builtin-model-building",
        "builtin-proxy-selection",
        "builtin-parameters",
    }
    assert expected <= set(by_id)

    for sid in expected:
        s = by_id[sid]
        assert s["enabled"] is True, sid
        assert len(s["content"]) > 1000, sid  # a real playbook, not a stub
        # The description is the only thing the model sees up front — it must say when to use it.
        assert len(s["description"]) > 120, sid
        assert "use " in s["description"].lower(), sid

    # Built-in guards still hold for the new ones.
    r = client.post("/api/v1/ai/skills/builtin-bom", json={"content": "x"}, headers=token)
    assert r.status_code == 400 and r.json()["error"]["code"] == "skill_builtin"
    assert client.post("/api/v1/ai/skills/builtin-bom/delete", headers=token).status_code == 400


def test_chat_history_per_model(client, token, project):
    db = "fg-chat"
    client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    chat = client.post(f"/api/v1/ai/chats/{db}", json={}, headers=token).json()
    cid = chat["id"]
    client.post(
        f"/api/v1/ai/chats/{db}/{cid}/messages",
        json={"messages": [{"role": "user", "content": "Hallo Bot"}, {"role": "assistant", "content": "Hi!"}]},
        headers=token,
    )
    full = client.get(f"/api/v1/ai/chats/{db}/{cid}", headers=token).json()
    assert len(full["messages"]) == 2
    # The first user message stands in as the title until the assistant sets one (set_chat_title).
    assert full["title"] == "Hallo Bot"
    listing = client.get(f"/api/v1/ai/chats/{db}", headers=token).json()["chats"]
    assert listing[0]["id"] == cid and listing[0]["message_count"] == 2
    assert listing[0]["title"] == "Hallo Bot"
    # A later message does not rename it; a set title wins and stays.
    client.post(
        f"/api/v1/ai/chats/{db}/{cid}/messages",
        json={"messages": [{"role": "user", "content": "Something else entirely"}]},
        headers=token,
    )
    assert client.get(f"/api/v1/ai/chats/{db}/{cid}", headers=token).json()["title"] == "Hallo Bot"
    client.post(f"/api/v1/ai/chats/{db}/{cid}/rename", json={"title": "PET bottle EoL"}, headers=token)
    client.post(
        f"/api/v1/ai/chats/{db}/{cid}/messages",
        json={"messages": [{"role": "user", "content": "And now?"}]},
        headers=token,
    )
    assert client.get(f"/api/v1/ai/chats/{db}/{cid}", headers=token).json()["title"] == "PET bottle EoL"


def test_provisional_chat_title_cuts_at_a_word():
    from prism_lca.engine.chat_store import provisional_title

    assert provisional_title("  Hallo   Bot \n") == "Hallo Bot"
    long = "Build me a cradle-to-grave model of a polypropylene yoghurt cup for the German market please"
    t = provisional_title(long)
    assert t.endswith("…") and len(t) <= 61 and " " in t
    assert not t[:-1].endswith(" ") and t == "Build me a cradle-to-grave model of a polypropylene yoghurt…"
    assert provisional_title(12) == ""


def test_chat_keeps_tool_traces_but_caps_them(client, token, project):
    """A reloaded chat has to explain HOW an answer came about — but a 40-round run must not add
    megabytes to a file in the user's project directory."""
    db = "fg-trace"
    client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    cid = client.post(f"/api/v1/ai/chats/{db}", json={}, headers=token).json()["id"]
    client.post(
        f"/api/v1/ai/chats/{db}/{cid}/messages",
        json={
            "messages": [
                {"role": "user", "content": "list my models"},
                {
                    "role": "assistant",
                    "content": "One model.",
                    "provider": "Alibaba",
                    "tools": [
                        {"name": "list_models", "args": '{"a":1}', "status": "ok", "preview": "x" * 5000, "resultChars": 5000, "ms": 12},
                        {"name": "edit_tags", "status": "rejected", "detail": "needs name", "ms": 3},
                        {"name": "bogus_without_a_name_key", "status": "ok"},
                        {"name": "huge", "status": "ok", "preview": "y" * 9000, "resultChars": 9000},
                    ],
                },
            ]
        },
        headers=token,
    )
    msgs = client.get(f"/api/v1/ai/chats/{db}/{cid}", headers=token).json()["messages"]
    assert "tools" not in msgs[0]  # user turns carry no trace
    traces = msgs[1]["tools"]
    assert [t["name"] for t in traces] == ["list_models", "edit_tags", "bogus_without_a_name_key", "huge"]
    # A stored trace exists for the look BACK, so it may not show less than the live one did: the
    # limit matches TRACE_PREVIEW_CHARS in agent.ts, and a 5k result now survives whole.
    assert len(traces[0]["preview"]) == 5000 and traces[0]["resultChars"] == 5000
    # Still bounded, and the real length survives so the UI can say what it is hiding.
    assert len(traces[3]["preview"]) == 6000 and traces[3]["resultChars"] == 9000
    assert traces[1]["status"] == "rejected" and traces[1]["detail"] == "needs name"
    # Which endpoint served the turn — accepted by the API, and until 2026-08-11 dropped in silence
    # right here, so the name vanished on the first reload.
    assert msgs[1]["provider"] == "Alibaba"
    assert "provider" not in msgs[0]


def test_chat_keeps_what_a_turn_consumed(client, token, project):
    """The chat header adds these up over the conversation. The monthly ledger in Settings is per
    model and cannot tell two chats apart, so nothing else can answer it after a reload — and the
    provider field above is the cautionary tale: accepted by the API, dropped in the store, gone on
    the first reload."""
    db = "fg-usage"
    client.post("/api/v1/databases/foreground", json={"name": db}, headers=token)
    cid = client.post(f"/api/v1/ai/chats/{db}", json={}, headers=token).json()["id"]
    client.post(
        f"/api/v1/ai/chats/{db}/{cid}/messages",
        json={
            "messages": [
                {"role": "user", "content": "how big is the model?"},
                {
                    "role": "assistant",
                    "content": "Six processes.",
                    "prompt_tokens": 48_000,
                    "cached_tokens": 37_440,
                    "completion_tokens": 1_200,
                },
                # A free model that reports nothing, and a run that produced no output: neither may
                # invent a zero, because a stored 0 reads as a measurement.
                {"role": "assistant", "content": "…", "prompt_tokens": 0, "completion_tokens": None},
            ]
        },
        headers=token,
    )
    msgs = client.get(f"/api/v1/ai/chats/{db}/{cid}", headers=token).json()["messages"]
    assert msgs[1]["prompt_tokens"] == 48_000
    assert msgs[1]["cached_tokens"] == 37_440
    assert msgs[1]["completion_tokens"] == 1_200
    # The prompt count INCLUDES the cached share, which is what makes the ratio meaningful.
    assert msgs[1]["cached_tokens"] < msgs[1]["prompt_tokens"]
    for key in ("prompt_tokens", "cached_tokens", "completion_tokens"):
        assert key not in msgs[0], key
        assert key not in msgs[2], key


def test_rename_and_delete_model(client, token, project):
    client.post("/api/v1/databases/foreground", json={"name": "fg-old"}, headers=token)
    # tag an activity so we can verify tags follow the rename
    a = client.post("/api/v1/model/activities", json={"database": "fg-old", "name": "A", "unit": "kg"}, headers=token).json()["activity"]["code"]
    client.post("/api/v1/model/tags/set", json={"keys": [{"database": "fg-old", "code": a}], "group": "Phase", "value": "Production"}, headers=token)

    r = client.post("/api/v1/databases/foreground/rename", json={"database": "fg-old", "name": "fg-new"}, headers=token)
    assert r.status_code == 200, r.text
    names = [d["name"] for d in client.get("/api/v1/databases", headers=token).json()]
    assert "fg-new" in names and "fg-old" not in names
    # tags followed the rename (codes preserved)
    assert client.get(f"/api/v1/model/tags/fg-new/{a}", headers=token).json() == [{"dimension": "Phase", "value": "Production"}]

    # delete
    assert client.post("/api/v1/databases/foreground/delete", json={"database": "fg-new"}, headers=token).status_code == 200
    names = [d["name"] for d in client.get("/api/v1/databases", headers=token).json()]
    assert "fg-new" not in names
