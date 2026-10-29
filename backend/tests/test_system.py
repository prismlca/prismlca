from __future__ import annotations


def test_health_is_public(client):
    r = client.get("/api/v1/system/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_info_requires_token(client):
    r = client.get("/api/v1/system/info")
    assert r.status_code == 401
    body = r.json()
    assert body["error"]["code"] == "unauthorized"
    assert body["error"]["hint"]  # every error carries a fix hint


def test_info_with_token(client, token):
    r = client.get("/api/v1/system/info", headers=token)
    assert r.status_code == 200
    data = r.json()
    assert data["api_version"] == "v1"
    assert data["backend"]["engine"] == "brightway25"
    assert data["backend"]["ready"] is True
    assert data["backend"]["engine_version"].startswith("bw2data")


# --- provider key -----------------------------------------------------------------------------
# The Electron shell owns the key (OS credential store) and hands it over so API embeddings work
# without an app restart. What these tests hold in place: it is write-only, it never comes back out,
# and a key change actually invalidates the provider that was built with the old one.


def test_provider_key_requires_token(client):
    r = client.post("/api/v1/system/provider-key", json={"provider": "openrouter", "key": "sk-or-x"})
    assert r.status_code == 401


def test_provider_key_is_write_only(client, token):
    r = client.post(
        "/api/v1/system/provider-key",
        json={"provider": "openrouter", "key": "sk-or-v1-secret-value"},
        headers=token,
    )
    assert r.status_code == 200
    assert r.json() == {"provider": "openrouter", "present": True}
    # The response says *that* there is a key, never which one.
    assert "secret-value" not in r.text
    # And no GET hands it back: /info is the only readable system state.
    info = client.get("/api/v1/system/info", headers=token)
    assert "secret-value" not in info.text


def test_provider_key_reaches_the_settings_and_can_be_cleared(client, token):
    settings = client.app.state.settings
    client.post(
        "/api/v1/system/provider-key",
        json={"provider": "openrouter", "key": "  sk-or-v1-with-space  "},
        headers=token,
    )
    assert settings.openrouter_api_key == "sk-or-v1-with-space"
    r = client.post("/api/v1/system/provider-key", json={"provider": "openrouter", "key": ""}, headers=token)
    assert r.json()["present"] is False
    assert settings.openrouter_api_key == ""


def test_provider_key_takes_openai_too(client, token):
    r = client.post("/api/v1/system/provider-key", json={"provider": "OpenAI", "key": "sk-x"}, headers=token)
    assert r.status_code == 200
    assert client.app.state.settings.openai_api_key == "sk-x"


def test_provider_key_refuses_an_unknown_provider(client, token):
    r = client.post("/api/v1/system/provider-key", json={"provider": "mistral", "key": "x"}, headers=token)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "provider_unknown"


def test_a_new_key_drops_the_provider_built_with_the_old_one(client, token):
    """Otherwise the key is stored and the next search still uses the old one — invisible from the UI."""
    search = client.app.state.search
    search._provider = object()  # stand-in for a provider built with the previous key
    client.post("/api/v1/system/provider-key", json={"provider": "openrouter", "key": "sk-new"}, headers=token)
    assert search._provider is None


# --- orderly stop for an update (V-2) -----------------------------------------------------------
# The shell stops this process before it installs an update. What these tests hold: the stop needs
# the token, it refuses while work would be destroyed unless forced, and an accepted stop sets the
# same flag uvicorn's SIGTERM handler sets.


class _FakeServer:
    should_exit = False


def test_shutdown_requires_token(client):
    assert client.post("/api/v1/system/shutdown", json={}).status_code == 401
    assert client.get("/api/v1/system/busy").status_code == 401


def test_shutdown_sets_should_exit_when_idle(client, token):
    server = _FakeServer()
    client.app.state.server = server
    try:
        assert client.get("/api/v1/system/busy", headers=token).json() == {"busy": False, "reasons": [], "long_work": []}
        r = client.post("/api/v1/system/shutdown", headers=token, json={})
        assert r.status_code == 200
        assert r.json()["accepted"] is True
        assert server.should_exit is True
    finally:
        client.app.state.server = None


def test_shutdown_refuses_while_a_calculation_runs_unless_forced(client, token, monkeypatch):
    from prism_lca.engine import calc_jobs

    monkeypatch.setattr(calc_jobs, "running_count", lambda: 2)
    server = _FakeServer()
    client.app.state.server = server
    try:
        r = client.post("/api/v1/system/shutdown", headers=token, json={})
        assert r.json() == {"accepted": False, "reasons": ["2 calculations running"]}
        assert server.should_exit is False
        r = client.post("/api/v1/system/shutdown", headers=token, json={"force": True})
        assert r.json()["accepted"] is True
        assert server.should_exit is True
    finally:
        client.app.state.server = None


def test_a_committing_import_counts_as_busy(client, token, monkeypatch):
    # During /dataimport/commit the read is over (reading_progress() is None) but the writes are not.
    from prism_lca.engine.dataimport import session as import_session

    monkeypatch.setattr(import_session, "committing", lambda: True)
    r = client.get("/api/v1/system/busy", headers=token)
    assert r.json() == {
        "busy": True,
        "reasons": ["a data import being written"],
        "long_work": ["a data import being written"],
    }


def test_an_index_build_and_a_model_download_are_long_work(client, token, monkeypatch):
    # A stop throws both away, and both run for minutes once started: the update waits, and the
    # shell keeps the computer awake for them (main/keepAwake.ts). A build still waiting in the queue
    # counts as well — it is lost just the same.
    monkeypatch.setattr(client.app.state.search.builds, "busy", lambda: True)
    monkeypatch.setattr(client.app.state.search_model, "downloading", lambda: True)
    work = ["the search index being built", "the search model being downloaded"]
    r = client.get("/api/v1/system/busy", headers=token)
    assert r.json() == {"busy": True, "reasons": work, "long_work": work}


def test_requests_in_flight_are_busy_but_not_long_work(client, token):
    # The status polls of an idle window are requests too; they must not hold the computer awake.
    # (The first request builds the middleware stack, which zeroes the counter — so one goes first.)
    assert client.get("/api/v1/system/busy", headers=token).json()["busy"] is False
    client.app.state.requests_in_flight = 1
    try:
        r = client.get("/api/v1/system/busy", headers=token)
        assert r.json() == {"busy": True, "reasons": ["1 request in progress"], "long_work": []}
    finally:
        client.app.state.requests_in_flight = 0


def test_a_request_answered_for_a_while_is_long_work(client, token):
    # The Results page calculates inside the request, not as a job.
    import time

    from prism_lca.api.v1.system import LONG_REQUEST_S

    assert client.get("/api/v1/system/busy", headers=token).json()["busy"] is False
    starts = client.app.state.request_starts
    starts["poll"] = time.monotonic()
    starts["calc"] = time.monotonic() - LONG_REQUEST_S - 1
    client.app.state.requests_in_flight = 2
    try:
        r = client.get("/api/v1/system/busy", headers=token).json()
        assert r["reasons"] == ["2 requests in progress"]
        assert r["long_work"] == ["1 long request in progress"]
    finally:
        client.app.state.requests_in_flight = 0
        starts.pop("poll")
        starts.pop("calc")
    # An ordinary request leaves no start time behind.
    client.get("/api/v1/system/info", headers=token)
    assert client.app.state.request_starts == {}


def test_requests_in_progress_count_as_busy_but_not_the_check_itself(client, token):
    # A synchronous calculation or a write is a request being answered; the stop must wait for it.
    assert client.get("/api/v1/system/busy", headers=token).json() == {"busy": False, "reasons": [], "long_work": []}
    client.app.state.requests_in_flight = 1
    try:
        r = client.post("/api/v1/system/shutdown", headers=token, json={})
        assert r.json() == {"accepted": False, "reasons": ["1 request in progress"]}
    finally:
        client.app.state.requests_in_flight = 0
    # An ordinary request leaves the counter where it found it.
    client.get("/api/v1/system/info", headers=token)
    assert client.app.state.requests_in_flight == 0


def test_after_an_accepted_stop_no_new_work_is_admitted(client, token):
    server = _FakeServer()
    client.app.state.server = server
    try:
        assert client.post("/api/v1/system/shutdown", headers=token, json={}).json()["accepted"] is True
        r = client.get("/api/v1/system/info", headers=token)
        assert r.status_code == 503
        assert r.json()["error"]["code"] == "shutting_down"
        # Housekeeping still answers.
        assert client.get("/api/v1/system/health").status_code == 200
    finally:
        client.app.state.server = None
        client.app.state.shutting_down = False
