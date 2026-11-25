"""The build slot and its queue: an import that finishes while another database is being indexed.

The recommended first steps are ecoinvent and then BAFU straight away, so BAFU's import ends while
ecoinvent's index is still being built — for hours. Its build was refused with ``index_busy``, the
refusal went to a debug log, and BAFU stayed without an index until somebody pressed Index. These
tests hold the first build at a gate, so "while another one runs" takes milliseconds instead of hours.
"""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from prism_lca.api.v1.setup import index_after
from prism_lca.engine.bootstrap import get_bd
from prism_lca.errors import PrismError
from prism_lca.search import builds as builds_mod


def _write(name: str, rows: dict) -> None:
    get_bd().Database(name).write(rows)


def _bg(name: str) -> None:
    _write(
        name,
        {
            (name, "elec"): {"name": "market for electricity, medium voltage", "unit": "kilowatt hour",
                             "location": "DE", "type": "process", "exchanges": []},
            (name, "steel"): {"name": "market for steel, low-alloyed", "unit": "kilogram",
                              "location": "GLO", "type": "process", "exchanges": []},
        },
    )


def _bio() -> None:
    _write(
        "biosphere3",
        {
            ("biosphere3", "co2"): {"name": "Carbon dioxide, fossil", "unit": "kilogram",
                                    "categories": ("air",), "type": "emission"},
        },
    )


@pytest.fixture
def gated(monkeypatch):
    """Every build on its own thread, the first one of ``held`` waiting at the gate; returns the order
    the databases were embedded in, and the gate."""
    order: list[str] = []
    gate = threading.Event()
    real = builds_mod.build_index
    held = {"bg"}

    def build_index(bd, db_name, provider, **kw):
        order.append(db_name)
        if db_name in held:
            held.discard(db_name)
            assert gate.wait(10), "the test never opened the gate"
        return real(bd, db_name, provider, **kw)

    monkeypatch.setattr(builds_mod, "build_index", build_index)
    monkeypatch.setattr(builds_mod, "SYNC_INDEX_LIMIT", 0)
    return order, gate


def _idle(builds, timeout: float = 10.0) -> None:
    end = time.monotonic() + timeout
    while builds.busy():
        assert time.monotonic() < end, "the queue never drained"
        time.sleep(0.02)


def test_an_import_during_a_build_is_indexed_after_it(client: TestClient, token, project, gated):
    order, gate = gated
    _bg("bg")
    _bg("bafu")
    _bio()
    search = client.app.state.search
    search.builds.build("bg")
    assert search.builds.building("bg")

    # A person pressing Index is still told to wait…
    with pytest.raises(PrismError) as busy:
        search.builds.build("bafu")
    assert busy.value.code == "index_busy" and busy.value.situational
    # …an import lines its build up instead. No biosphere index yet, so nothing is queued for the flows.
    index_after(search)("bafu", {"biosphere_added": ["co2"]})
    st = client.get("/api/v1/search/status", headers=token).json()
    assert st["state"] == "running" and st["database"] == "bg" and st["queued"] == ["bafu"]
    assert client.get("/api/v1/system/busy", headers=token).json()["busy"]

    gate.set()
    _idle(search.builds)
    # The flows come along with the first build and are not built a second time for the queued one.
    assert order == ["bg", "biosphere3", "bafu"]
    for db in ("bg", "bafu", "biosphere3"):
        info = client.get(f"/api/v1/search/index-info?database={db}", headers=token).json()
        assert info["indexed"] and not info["stale"], info
    assert client.get("/api/v1/search/status", headers=token).json()["queued"] == []


def test_a_queued_build_is_asked_once(client: TestClient, token, project, gated):
    order, gate = gated
    _bg("bg")
    _bg("bafu")
    search = client.app.state.search
    search.builds.build("bg")
    search.builds.build_when_free("bafu")
    search.builds.build_when_free("bafu")
    assert search.builds.queued() == ["bafu"]
    gate.set()
    _idle(search.builds)
    assert order == ["bg", "bafu"]


def test_flows_added_by_an_import_are_appended_after_the_queued_build(client: TestClient, token, project, gated):
    order, gate = gated
    _bg("bg")
    _bio()
    search = client.app.state.search
    search.builds.build("biosphere3")  # not held at the gate
    _idle(search.builds)
    search.builds.build("bg")
    _write("biosphere3", {
        ("biosphere3", "co2"): {"name": "Carbon dioxide, fossil", "unit": "kilogram",
                                "categories": ("air",), "type": "emission"},
        ("biosphere3", "n2o"): {"name": "Dinitrogen monoxide", "unit": "kilogram",
                                "categories": ("air",), "type": "emission"},
    })
    _bg("bafu")
    index_after(search)("bafu", {"biosphere_added": ["n2o"]})
    gate.set()
    _idle(search.builds)
    assert order == ["biosphere3", "bg", "bafu"]
    assert search.index_info("biosphere3")["indexed_count"] == 2


def test_leaving_a_workspace_stops_its_builds_until_it_is_opened_again(client: TestClient, token, project, gated):
    """A build of the workspace that was left computed on — for ecoinvent two hours of every core — and
    was thrown away at the end, while the build of the workspace the user had gone to waited behind it.
    Now it stops before its next batch, the other workspace's build starts, and the work that was left
    is taken up again when its workspace is opened."""
    order, gate = gated
    _bg("bg")
    _bg("bafu")
    search = client.app.state.search
    search.builds.build("bg")
    search.builds.build_when_free("bafu")
    other = project + "-b"
    assert client.post("/api/v1/projects", json={"name": other}, headers=token).status_code == 200
    _bg("bg")  # the same name in the other workspace: a fresh ecoinvent release imported there
    index_after(search)("bg")  # its import lines its build up

    # Seen from B, A's build is not B's: the status says whose it is, and B's own "bg" is waiting.
    st = client.get("/api/v1/search/status", headers=token).json()
    assert st["state"] == "running" and st["workspace"] == project and st["other_workspace"], st
    assert st["queued"] == ["bg"]
    assert not client.get("/api/v1/search/index-info?database=bg", headers=token).json()["building"]

    gate.set()
    _idle(search.builds)
    # A's bg stopped before its first batch and A's queued bafu never started; B's bg was built.
    assert order == ["bg", "bg"]
    assert search.index_info("bg")["indexed"]
    assert not client.get("/api/v1/search/status", headers=token).json()["other_workspace"]

    r = client.post(f"/api/v1/projects/{project}/activate", headers=token)
    assert r.status_code == 200, r.text
    _idle(search.builds)
    assert order == ["bg", "bg", "bg", "bafu"]  # A's work, taken up in the order it was asked for
    for db in ("bg", "bafu"):
        assert search.index_info(db)["indexed"], db


def test_a_failing_inline_build_hands_the_slot_on_once(client: TestClient, token, project, gated, monkeypatch):
    """A small build runs on the caller's thread. When its follow-up step raised, the slot was handed
    on twice — once by the job, once by the caller — and the two jobs behind it ran side by side."""
    order, gate = gated
    monkeypatch.setattr(builds_mod, "SYNC_INDEX_LIMIT", 2000)  # bg is small: inline, on its caller's thread
    active, peak = [0], [0]
    held_build = builds_mod.build_index

    def counting(bd, db_name, provider, **kw):
        active[0] += 1
        peak[0] = max(peak[0], active[0])
        try:
            if db_name != "bg":
                time.sleep(0.1)  # long enough for a second job to overlap, if one is let in
            return held_build(bd, db_name, provider, **kw)
        finally:
            active[0] -= 1

    monkeypatch.setattr(builds_mod, "build_index", counting)
    for db in ("bg", "q1", "q2"):
        _bg(db)
    search = client.app.state.search

    def broken_backlog(db_name):
        raise RuntimeError("biosphere lookup failed")

    monkeypatch.setattr(search.builds, "_biosphere_backlog", broken_backlog)
    caller = threading.Thread(target=search.builds.build, args=("bg",))
    caller.start()
    end = time.monotonic() + 10
    while not search.builds.building("bg"):
        assert time.monotonic() < end
        time.sleep(0.01)
    search.builds.build_when_free("q1")
    search.builds.build_when_free("q2")
    gate.set()
    caller.join(10)
    _idle(search.builds)
    assert order == ["bg", "q1", "q2"]
    assert peak[0] == 1


def test_a_queued_job_keeps_the_workspace_it_was_asked_in(client: TestClient, token, project, gated, monkeypatch):
    """Checked when the job is handed the slot is not enough: a switch between that check and its thread
    built the other workspace's same-named database and reported success."""
    order, gate = gated
    _bg("bg")
    _bg("bafu")
    other = project + "-b"
    bd = get_bd()
    bd.projects.set_current(other)
    _bg("bafu")
    bd.projects.set_current(project)
    search = client.app.state.search
    spawn = search.builds._spawn

    def switch_then_spawn(job):
        if job.database == "bafu":
            bd.projects.set_current(other)
        spawn(job)

    monkeypatch.setattr(search.builds, "_spawn", switch_then_spawn)
    search.builds.build("bg")
    search.builds.build_when_free("bafu")
    try:
        gate.set()
        _idle(search.builds)
        assert not search.index_info("bafu")["indexed"]  # B's bafu: not built on A's behalf
        st = search.builds.status()
        assert st.state == "stopped" and st.database == "bafu" and st.workspace == project
    finally:
        bd.projects.set_current(project)
    assert not search.index_info("bafu")["indexed"]


def test_a_build_ending_between_the_two_reads_is_still_seen(client: TestClient, token, project):
    """The import hook asks whether the biosphere is indexed or being built. When a build ended between
    those two reads, the answer was "neither", and the flows the import had just added were never
    appended — the finished index had read the flows before they existed."""
    from prism_lca.search.indexer import build_index

    _bio()
    search = client.app.state.search
    builds = search.builds
    builds._set(state="running", database="biosphere3", workspace=project)
    building = builds.building

    def ends_first(db_name):
        # The build finishes right as it is asked about: index installed, then "done".
        flows = build_index(get_bd(), "biosphere3", search._provider_())
        search._install(flows, search._index_base("biosphere3"), search._cache_key("biosphere3"))
        builds._set(state="done")
        return building(db_name)

    builds.building = ends_first
    info = search.index_info("biosphere3")
    assert info["indexed"] or info["building"], info


def test_a_switch_during_the_save_does_not_move_the_index(client: TestClient, token, project, monkeypatch):
    """The workspace is checked right before the save; a switch while the file was being written read
    the cache key from the new workspace, and B's search would have served A's datasets."""
    from prism_lca.search.index import VectorIndex

    _bg("bafu")
    other = project + "-b"
    bd = get_bd()
    bd.projects.set_current(other)
    _bg("bafu")
    bd.projects.set_current(project)
    search = client.app.state.search
    save = VectorIndex.save

    def switch_while_saving(self, base):
        bd.projects.set_current(other)
        return save(self, base)

    monkeypatch.setattr(VectorIndex, "save", switch_while_saving)
    try:
        search.builds.build("bafu")  # small: built inline
        assert f"{other}/bafu" not in search._cache
        assert not search.index_info("bafu")["indexed"]  # nothing in B
    finally:
        bd.projects.set_current(project)
    assert f"{project}/bafu" in search._cache
    assert search.index_info("bafu")["indexed"]  # A's index, in A


def test_flows_left_behind_are_built_on_return_without_the_database_again(
    client: TestClient, token, project, gated, monkeypatch
):
    """A switch while the elementary flows are indexed, after the database's own index is saved: on
    return only the flows are built — the database again would be two hours for nothing."""
    order, gate = gated
    gate.set()
    _bg("bg")
    _bio()
    search = client.app.state.search
    bd = get_bd()
    other = project + "-b"
    gated_build = builds_mod.build_index

    def leave_as_the_flows_begin(bd_, db_name, provider, **kw):
        if db_name == "biosphere3" and order.count("biosphere3") == 0:
            bd.projects.set_current(other)
        return gated_build(bd_, db_name, provider, **kw)

    monkeypatch.setattr(builds_mod, "build_index", leave_as_the_flows_begin)
    try:
        search.builds.build("bg")
        _idle(search.builds)
        st = search.builds.status()
        assert st.state == "stopped" and st.database == "biosphere3" and st.workspace == project
    finally:
        bd.projects.set_current(other)  # wherever the thread left it, the user stands in B
    r = client.post(f"/api/v1/projects/{project}/activate", headers=token)
    assert r.status_code == 200, r.text
    _idle(search.builds)
    assert order == ["bg", "biosphere3", "biosphere3"]
    assert search.index_info("bg")["indexed"] and search.index_info("biosphere3")["indexed"]


def test_the_embedding_ends_at_the_checkpoint_between_two_batches():
    from prism_lca.search.embeddings import HashingEmbedding
    from prism_lca.search.indexer import embed_unique

    batches: list[int] = []

    class Counting(HashingEmbedding):
        def embed(self, texts, is_query=False):
            batches.append(len(texts))
            return super().embed(texts, is_query)

    class Left(Exception):
        pass

    asked = [0]

    def checkpoint():
        asked[0] += 1
        if asked[0] == 3:
            raise Left

    with pytest.raises(Left):
        embed_unique(Counting(), [f"text {i}" for i in range(10)], 256, batch_size=2, checkpoint=checkpoint)
    assert batches == [2, 2]  # two batches embedded, the third never begun


def test_a_build_waits_out_a_step_into_another_workspace(client: TestClient, token, project):
    """Restoring a backup over an existing workspace steps into it and back, under PROJECT_LOCK. A look
    at the current workspace in the middle of that would stop a build whose workspace never went away —
    and a look that skipped the step would let the build read the other workspace's database."""
    from prism_lca.engine.commands import PROJECT_LOCK

    job = builds_mod._Job(project, "bg")
    check = client.app.state.search.builds._check
    bd = get_bd()
    stepped, done = threading.Event(), threading.Event()
    outcome: list[str] = []

    def step_aside():
        with PROJECT_LOCK:
            bd.projects.set_current(project + "-aside")
            stepped.set()
            done.wait(10)
            bd.projects.set_current(project)

    def look():
        try:
            check(job)
            outcome.append("goes on")
        except builds_mod._WorkspaceLeft:
            outcome.append("stopped")

    aside = threading.Thread(target=step_aside)
    aside.start()
    assert stepped.wait(10)
    looking = threading.Thread(target=look)
    looking.start()
    looking.join(0.2)
    assert outcome == []  # waits for the step instead of judging inside it
    done.set()
    aside.join(10)
    looking.join(10)
    assert outcome == ["goes on"]
    bd.projects.set_current(project + "-b")
    try:
        with pytest.raises(builds_mod._WorkspaceLeft):
            check(job)
    finally:
        bd.projects.set_current(project)


def test_the_database_is_read_with_its_workspace_held(client: TestClient, token, project, monkeypatch):
    """The rows are read under PROJECT_LOCK: a step into a workspace with a database of the same name
    cannot fall into the read and pass the check before the save once it has come back."""
    from prism_lca.engine.commands import PROJECT_LOCK
    from prism_lca.search import indexer

    _bg("bg")
    search = client.app.state.search
    held: list[bool] = []

    def taken_by_someone() -> bool:
        free: list[bool] = []

        def probe() -> None:  # from another thread: the reading thread could always take it again
            free.append(PROJECT_LOCK.acquire(timeout=0.01))
            if free[0]:
                PROJECT_LOCK.release()

        t = threading.Thread(target=probe)
        t.start()
        t.join(5)
        return not free[0]

    real_meta = indexer.activity_meta

    def meta(act, db_name):
        held.append(taken_by_someone())
        return real_meta(act, db_name)

    monkeypatch.setattr(indexer, "activity_meta", meta)
    search.builds.build("bg")  # small: inline
    assert held and all(held)
    assert search.index_info("bg")["indexed"]


def test_a_return_before_the_job_is_parked_starts_it_again(client: TestClient, token, project, monkeypatch):
    """The look that stops a job and the parking are two steps. When the user came back in between,
    `resume` had found nothing to take up, and the job waited parked for the next switch."""
    monkeypatch.setattr(builds_mod, "SYNC_INDEX_LIMIT", 0)
    _bg("bg")
    search = client.app.state.search
    builds = search.builds
    real_check = builds._check
    looks = [0]

    def saw_the_other_workspace(job):
        looks[0] += 1
        if looks[0] == 1:  # the switch away was seen; by the time of the parking the user is back
            raise builds_mod._WorkspaceLeft(job.workspace)
        real_check(job)

    monkeypatch.setattr(builds, "_check", saw_the_other_workspace)
    builds.build("bg")
    _idle(builds)
    assert builds._parked == []
    assert search.index_info("bg")["indexed"]


def test_a_deleted_workspace_leaves_no_work_behind(client: TestClient, token, project, gated):
    order, gate = gated
    _bg("bg")
    search = client.app.state.search
    search.builds.build("bg")
    # Deleting the workspace whose build runs: the build stops, and there is nothing to come back to.
    assert client.post("/api/v1/projects", json={"name": project + "-b"}, headers=token).status_code == 200
    assert client.post(f"/api/v1/projects/{project}/activate", headers=token).status_code == 200
    assert client.delete(f"/api/v1/projects/{project}", headers=token).status_code == 200
    gate.set()
    _idle(search.builds)
    st = search.builds.status()
    assert st.state == "stopped" and "deleted" in st.detail
    assert search.builds._parked == []


def test_work_parked_for_a_workspace_is_dropped_when_it_is_deleted(client: TestClient, token, project, gated):
    order, gate = gated
    _bg("bg")
    search = client.app.state.search
    search.builds.build("bg")
    other = project + "-b"
    assert client.post("/api/v1/projects", json={"name": other}, headers=token).status_code == 200
    gate.set()
    _idle(search.builds)
    assert [j.workspace for j in search.builds._parked] == [project]
    assert client.delete(f"/api/v1/projects/{project}", headers=token).status_code == 200
    assert search.builds._parked == []
