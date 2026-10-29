"""Background LCIA jobs (engine/calc_jobs.py + /calc/jobs): start at once, poll, read, cancel
between methods, stale after a model change. The calculation itself is stubbed — the job machinery
is what is under test, not Brightway."""

import threading
import time

from fastapi.testclient import TestClient

from prism_lca.engine import calc_jobs, lca


def _stub(gate: threading.Event | None = None):
    def compute(database, code, method, amount, direct_split):  # noqa: ANN001
        if gate is not None:
            gate.wait(5)
        return {
            "activity": {"database": database, "code": code, "name": "stub"},
            "amount": amount,
            "method": list(method),
            "unit": "kg",
            "score": float(len(method)),
        }

    return compute


def test_a_job_runs_method_by_method_and_keeps_its_result() -> None:
    calc_jobs._reset_for_tests()
    job = calc_jobs.start("db", "c", [["a"], ["b", "c"]], compute=_stub(), run_in_thread=False)
    snap = calc_jobs.snapshot(job, with_result=True)
    assert snap["state"] == "done"
    assert snap["progress"] == {"done": 2, "total": 2}
    assert [r["score"] for r in snap["result"]["results"]] == [1.0, 2.0]
    assert snap["stale"] is False
    assert calc_jobs.get(job.id) is job


def test_cancel_lands_between_methods() -> None:
    calc_jobs._reset_for_tests()
    gate = threading.Event()
    job = calc_jobs.start("db", "c", [["a"], ["b"], ["c"]], compute=_stub(gate))
    assert calc_jobs.cancel(job.id) is job
    gate.set()
    for _ in range(100):
        if job.state != "running":
            break
        time.sleep(0.02)
    assert job.state == "cancelled"
    assert job.done == 1  # the method in flight finished, the next never started
    snap = calc_jobs.snapshot(job, with_result=True)
    assert "Cancelled after 1 of 3" in snap["result"]["note"]


def test_a_project_switch_or_model_edit_stops_the_job_between_methods(monkeypatch) -> None:
    calc_jobs._reset_for_tests()
    proj = {"name": "A"}
    monkeypatch.setattr(calc_jobs, "_current_project", lambda: proj["name"])
    calls = {"n": 0}

    def compute(database, code, method, amount, direct_split):  # noqa: ANN001
        calls["n"] += 1
        proj["name"] = "B"  # the app switches projects while the first method computes
        return {"activity": {"database": database, "code": code}, "method": list(method), "unit": "kg", "score": 1.0}

    job = calc_jobs.start("db", "c", [["a"], ["b"]], compute=compute, run_in_thread=False)
    assert job.state == "invalidated"
    assert calls["n"] == 1  # the second method never ran
    assert "active workspace changed" in job.error
    assert job.project == "A"


def test_a_job_is_read_back_only_in_its_own_project(monkeypatch) -> None:
    calc_jobs._reset_for_tests()
    proj = {"name": "A"}
    monkeypatch.setattr(calc_jobs, "_current_project", lambda: proj["name"])
    job = calc_jobs.start("db", "c", [["a"]], compute=_stub(), run_in_thread=False)
    assert calc_jobs.get_in_current_project(job.id) is job
    proj["name"] = "B"
    try:
        calc_jobs.get_in_current_project(job.id)
    except Exception as exc:  # noqa: BLE001
        assert getattr(exc, "code", None) == "job_other_project"
    else:
        raise AssertionError("a job of another project was handed out")


def test_an_error_is_carried_to_the_reader() -> None:
    calc_jobs._reset_for_tests()

    def boom(*_a, **_k):  # noqa: ANN002, ANN003
        raise ValueError("no such activity")

    job = calc_jobs.start("db", "c", [["a"]], compute=boom, run_in_thread=False)
    assert job.state == "error"
    assert calc_jobs.snapshot(job)["error"] == "no such activity"


def test_stale_after_the_model_changed(monkeypatch) -> None:
    calc_jobs._reset_for_tests()
    gen = {"n": 7}
    monkeypatch.setattr(lca, "model_generation", lambda: gen["n"])
    job = calc_jobs.start("db", "c", [["a"]], compute=_stub(), run_in_thread=False)
    assert calc_jobs.snapshot(job)["stale"] is False
    gen["n"] = 8
    assert calc_jobs.snapshot(job)["stale"] is True


def test_routes_start_poll_and_cancel(client: TestClient, token: dict[str, str], project: str, monkeypatch) -> None:
    del project
    calc_jobs._reset_for_tests()
    gate = threading.Event()
    monkeypatch.setattr(calc_jobs.lca, "compute_lcia", _stub(gate))
    r = client.post(
        "/api/v1/calc/jobs", json={"database": "db", "code": "c", "methods": [["a"], ["b"]]}, headers=token
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "running"
    assert body["progress"] == {"done": 0, "total": 2}
    job_id = body["job_id"]
    r = client.get(f"/api/v1/calc/jobs/{job_id}", headers=token)
    assert r.status_code == 200 and r.json()["state"] == "running"
    r = client.post(f"/api/v1/calc/jobs/{job_id}/cancel", headers=token)
    assert r.status_code == 200
    gate.set()
    for _ in range(100):
        if client.get(f"/api/v1/calc/jobs/{job_id}", headers=token).json()["state"] != "running":
            break
        time.sleep(0.02)
    final = client.get(f"/api/v1/calc/jobs/{job_id}?result=true", headers=token).json()
    assert final["state"] == "cancelled"
    assert "result" in final
    assert client.get("/api/v1/calc/jobs/nope", headers=token).status_code == 404


def test_running_count_sees_only_jobs_still_computing() -> None:
    """What the app asks before a bridge-launched instance quits for want of use: a job
    still computing is work someone comes back for; a finished one is not."""
    calc_jobs._reset_for_tests()
    assert calc_jobs.running_count() == 0
    gate = threading.Event()
    job = calc_jobs.start("db", "c", [["a"]], compute=_stub(gate))
    assert calc_jobs.running_count() == 1
    gate.set()
    for _ in range(100):
        if calc_jobs.get(job.id).state != "running":
            break
        time.sleep(0.02)
    assert calc_jobs.running_count() == 0


def test_running_route_answers_before_the_job_id_route(client: TestClient, token: dict[str, str], project: str) -> None:
    calc_jobs._reset_for_tests()
    r = client.get("/api/v1/calc/jobs/running", headers=token)
    assert r.status_code == 200
    assert r.json() == {"running": 0}
