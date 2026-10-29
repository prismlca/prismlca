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

    def build_index(bd, db_name, provider, on_progress=None):
        order.append(db_name)
        if db_name in held:
            held.discard(db_name)
            assert gate.wait(10), "the test never opened the gate"
        return real(bd, db_name, provider, on_progress=on_progress)

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
    assert busy.value.code == "index_busy"
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


def test_a_queued_build_is_dropped_when_the_workspace_changed(client: TestClient, token, project, gated, caplog):
    import logging

    order, gate = gated
    _bg("bg")
    _bg("bafu")
    search = client.app.state.search
    search.builds.build("bg")
    search.builds.build_when_free("bafu")
    bd = get_bd()
    bd.projects.set_current(project + "-other")
    try:
        with caplog.at_level(logging.WARNING):
            gate.set()
            _idle(search.builds)
    finally:
        bd.projects.set_current(project)
    assert order == ["bg"]  # bafu belonged to the workspace that is no longer current
    assert "bafu" in caplog.text
    assert not search.index_info("bafu")["indexed"]


def test_a_failing_inline_build_hands_the_slot_on_once(client: TestClient, token, project, gated, monkeypatch):
    """A small build runs on the caller's thread. When its follow-up step raised, the slot was handed
    on twice — once by the job, once by the caller — and the two jobs behind it ran side by side."""
    order, gate = gated
    monkeypatch.setattr(builds_mod, "SYNC_INDEX_LIMIT", 2000)  # bg is small: inline, on its caller's thread
    active, peak = [0], [0]
    held_build = builds_mod.build_index

    def counting(bd, db_name, provider, on_progress=None):
        active[0] += 1
        peak[0] = max(peak[0], active[0])
        try:
            if db_name != "bg":
                time.sleep(0.1)  # long enough for a second job to overlap, if one is let in
            return held_build(bd, db_name, provider, on_progress=on_progress)
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
        assert st.state == "error" and st.database == "bafu"
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
    builds._set(state="running", database="biosphere3")
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
