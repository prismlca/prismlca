"""``X-Prism-Project``: an external session names the project it was opened on, and a request that
arrives after the app switched projects is refused before any handler runs (409 project_changed)."""

from fastapi.testclient import TestClient


def _get(client: TestClient, token: dict[str, str], project: str | None):
    headers = dict(token)
    if project is not None:
        headers["X-Prism-Project"] = project
    return client.get("/api/v1/databases", headers=headers)


def test_request_for_the_active_project_passes(client: TestClient, token: dict[str, str], project: str) -> None:
    assert _get(client, token, project).status_code == 200
    assert _get(client, token, None).status_code == 200


def test_request_for_another_project_is_refused(client: TestClient, token: dict[str, str], project: str) -> None:
    # Creating a project activates it: the first one is now the "other" project.
    r = client.post("/api/v1/projects", json={"name": project + "-b"}, headers=token)
    assert r.status_code == 200, r.text
    stale = _get(client, token, project)
    assert stale.status_code == 409
    body = stale.json()
    assert body["error"]["code"] == "project_changed"
    assert project in body["error"]["message"]
    assert (project + "-b") in body["error"]["message"]
    assert _get(client, token, project + "-b").status_code == 200
    assert _get(client, token, "no-such-project").status_code == 409


def test_unicode_project_names_travel_percent_encoded(client: TestClient, token: dict[str, str]) -> None:
    from urllib.parse import quote

    name = "test-Müller-研究-" + __import__("uuid").uuid4().hex[:6]
    r = client.post("/api/v1/projects", json={"name": name}, headers=token)
    assert r.status_code == 200, r.text
    assert _get(client, token, quote(name, safe="")).status_code == 200
    assert _get(client, token, quote("test-Müller-研究-other", safe="")).status_code == 409


def test_the_bus_refuses_a_command_for_another_project_even_when_the_middleware_let_it_pass(
    client: TestClient, token: dict[str, str], project: str, monkeypatch
) -> None:
    """The middleware's answer can be raced by a switch that lands while the body is read; the
    command bus checks again under the LCA lock — the lock the switch holds — and that check is
    the one that counts. Simulated by letting the middleware believe the old project is active.

    The scenario: both projects hold a model of the same name, and a create_process meant for
    A's must not land in B's.
    """
    import prism_lca.app as app_module

    mk = client.post("/api/v1/databases/foreground", json={"name": "Twin"}, headers=token)
    assert mk.status_code == 200, mk.text
    other = project + "-b"
    r = client.post("/api/v1/projects", json={"name": other}, headers=token)
    assert r.status_code == 200, r.text  # activates `other`
    mk = client.post("/api/v1/databases/foreground", json={"name": "Twin"}, headers=token)
    assert mk.status_code == 200, mk.text
    monkeypatch.setattr(app_module, "_current_project_name", lambda scope: project)
    headers = {**token, "X-Prism-Project": project}
    created = client.post(
        "/api/v1/model/activities", json={"database": "Twin", "name": "Ghost", "unit": "kg"}, headers=headers
    )
    assert created.status_code == 409, created.text
    assert created.json()["error"]["code"] == "project_changed"
    # Nothing landed in the Twin of the project that is actually active.
    listed = client.get("/api/v1/model/activities/Twin", headers=token)
    assert listed.status_code == 200, listed.text
    assert "Ghost" not in listed.text


def test_deleting_a_model_is_guarded_outside_the_bus_too(
    client: TestClient, token: dict[str, str], project: str, monkeypatch
) -> None:
    """delete_model does not go through the command bus; the repository call is wrapped in the same
    project guard, so B's same-named model survives a request meant for A."""
    import prism_lca.app as app_module

    assert client.post("/api/v1/databases/foreground", json={"name": "Twin"}, headers=token).status_code == 200
    other = project + "-b"
    assert client.post("/api/v1/projects", json={"name": other}, headers=token).status_code == 200
    assert client.post("/api/v1/databases/foreground", json={"name": "Twin"}, headers=token).status_code == 200
    monkeypatch.setattr(app_module, "_current_project_name", lambda scope: project)
    headers = {**token, "X-Prism-Project": project}
    r = client.post("/api/v1/databases/foreground/delete", json={"database": "Twin"}, headers=headers)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "project_changed"
    names = [d["name"] for d in client.get("/api/v1/databases", headers=token).json()]
    assert "Twin" in names
