"""The token gate: a request without the handshake token is answered 401 from its headers alone."""
from __future__ import annotations

import asyncio
import json

from fastapi.testclient import TestClient

# --------------------------------------------------------------------------- #
# Through the client
# --------------------------------------------------------------------------- #


def test_without_the_token_the_answer_is_401_whatever_the_body(client: TestClient) -> None:
    for content, content_type in ((b"{not json", "application/json"), (b"x" * 4096, "text/plain")):
        r = client.post("/api/v1/system/provider-key", content=content, headers={"content-type": content_type})
        assert r.status_code == 401, r.text
        assert r.json()["error"]["code"] == "unauthorized"
        assert r.json()["error"]["hint"]


def test_a_wrong_token_is_answered_the_same_way(client: TestClient) -> None:
    r = client.post(
        "/api/v1/system/provider-key",
        content=b"{not json",
        headers={"content-type": "application/json", "X-Prism-Token": "wrong"},
    )
    assert r.status_code == 401, r.text


def test_a_non_ascii_token_header_is_a_401(client: TestClient) -> None:
    r = client.get("/api/v1/system/info", headers={"X-Prism-Token": b"t\xe9st-token"})
    assert r.status_code == 401, r.text


def test_an_unknown_path_needs_the_token_too(client: TestClient, token: dict[str, str]) -> None:
    assert client.get("/no/such/path").status_code == 401
    assert client.get("/no/such/path", headers=token).status_code == 404


def test_the_public_paths_stay_public_for_reading(client: TestClient) -> None:
    health = client.get("/api/v1/system/health")
    assert health.status_code == 200 and health.json() == {"status": "ok"}
    assert client.get("/openapi.json").status_code == 200
    assert client.post("/api/v1/system/health", content=b"x").status_code == 401


def test_no_response_allows_a_browser_origin(client: TestClient, token: dict[str, str]) -> None:
    origin = {"Origin": "https://example.org"}
    preflight = client.options(
        "/api/v1/system/info",
        headers={**origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-prism-token"},
    )
    health = client.get("/api/v1/system/health", headers=origin)
    refused = client.get("/api/v1/system/info", headers=origin)
    answered = client.get("/api/v1/system/info", headers={**origin, **token})
    assert (preflight.status_code, health.status_code, refused.status_code, answered.status_code) == (401, 200, 401, 200)
    for r in (preflight, health, refused, answered):
        assert "access-control-allow-origin" not in r.headers


def test_the_token_still_opens_every_route(client: TestClient, token: dict[str, str]) -> None:
    assert client.get("/api/v1/system/info", headers=token).status_code == 200
    r = client.post(
        "/api/v1/system/provider-key", content=b"{not json", headers={**token, "content-type": "application/json"}
    )
    assert r.status_code == 422  # with the token, the body is read and judged as before


# --------------------------------------------------------------------------- #
# The project guard
# --------------------------------------------------------------------------- #


def test_the_project_guard_answers_token_holders_only(
    client: TestClient, token: dict[str, str], project: str
) -> None:
    for headers in ({"X-Prism-Project": "other"}, {"X-Prism-Project": "other", "X-Prism-Token": "wrong"}):
        r = client.get("/api/v1/system/info", headers=headers)
        assert r.status_code == 401, r.text
        assert project not in r.text
    health = client.get("/api/v1/system/health", headers={"X-Prism-Project": "other"})
    assert health.status_code == 200 and health.json() == {"status": "ok"}
    docs = client.get("/openapi.json", headers={"X-Prism-Project": "other"})
    assert docs.status_code == 200 and project not in docs.text
    stale = client.get("/api/v1/system/info", headers={**token, "X-Prism-Project": "other"})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "project_changed"
    assert project in stale.json()["error"]["message"]


# --------------------------------------------------------------------------- #
# At the ASGI level
# --------------------------------------------------------------------------- #


def _call(app, path: str, headers: list[tuple[bytes, bytes]], method: str = "POST") -> tuple[int, dict, int]:
    """One request whose body is never delivered: status, JSON body, and the in-flight count at the answer."""
    sent: list[dict] = []
    in_flight_at_start: list[int] = []

    async def receive() -> dict:
        raise AssertionError("the body was read before the token was checked")

    async def send(message: dict) -> None:
        if message["type"] == "http.response.start":
            in_flight_at_start.append(app.state.requests_in_flight)
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", 8000),
    }

    async def drive() -> None:
        await asyncio.wait_for(app(scope, receive, send), timeout=10)

    asyncio.run(drive())
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], json.loads(body), in_flight_at_start[0]


def test_without_the_token_the_body_is_not_read_and_nothing_counts_as_in_flight(client: TestClient) -> None:
    headers = [(b"content-type", b"application/json"), (b"content-length", b"4096")]
    status, body, in_flight = _call(client.app, "/api/v1/system/provider-key", headers)
    assert status == 401 and body["error"]["code"] == "unauthorized"
    assert in_flight == 0


def test_without_the_token_a_form_route_reads_no_body_either(client: TestClient) -> None:
    headers = [
        (b"content-type", b"multipart/form-data; boundary=x"),
        (b"content-length", b"4096"),
        (b"x-prism-project", b"other"),
    ]
    status, body, _ = _call(client.app, "/api/v1/interop/model", headers)
    assert status == 401 and body["error"]["code"] == "unauthorized"
