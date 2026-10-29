"""The inventory step of the ecoinvent import: the count, cancelling, the stall limit, and the folder the
user may pick.

A Windows installer once read its datasets in workers that never reached their task: the import showed a
sliding bar for an hour, offered no way to stop and never finished. The reader now counts, stops on
request and gives up when nothing finishes for a while; these tests hold it to that without a licensed
release — the worker task is replaced by a stand-in at module level, which a forked worker can import.
"""

from __future__ import annotations

import threading
import time

import pytest
from test_setup import FLOWS, write_flow_list

from prism_lca.errors import PrismError


def _quick(job):
    return {"filename": job[1]}


def _slow(job):
    time.sleep(0.2)
    return {"filename": job[1]}


def _stuck(job):
    time.sleep(30)


def _broken(job):
    if job[1] == "b.spold":
        raise ValueError("not ecoSpold")
    return {"filename": job[1]}


def _datasets(tmp_path, names=("c.spold", "a.spold", "b.SPOLD", "notes.txt")):
    folder = tmp_path / "datasets"
    folder.mkdir()
    for name in names:
        (folder / name).write_text("x")
    return folder


def _extract(monkeypatch, folder, task, *, use_mp=True, cancelled=None, stall=60.0, seen=None):
    from prism_lca.engine import ecoinvent_inventory as inv

    monkeypatch.setattr(inv, "_read_one", task)
    seen = [] if seen is None else seen
    reader = inv.reader(lambda done, total: seen.append((done, total)), cancelled or threading.Event(), stall)
    return reader.extract(folder, "db", use_mp=use_mp)


@pytest.mark.parametrize("use_mp", [False, True])
def test_reads_every_dataset_in_one_order_and_counts(monkeypatch, tmp_path, use_mp):
    seen: list[tuple[int, int]] = []
    data = _extract(monkeypatch, _datasets(tmp_path), _quick, use_mp=use_mp, seen=seen)
    assert [d["filename"] for d in data] == ["a.spold", "b.SPOLD", "c.spold"]
    assert seen[0] == (0, 3) and seen[-1] == (3, 3)


def test_a_cancel_stops_the_workers_within_a_second(monkeypatch, tmp_path):
    from prism_lca.engine.ecoinvent_inventory import ImportCancelled

    cancelled = threading.Event()
    folder = _datasets(tmp_path, [f"{i:03}.spold" for i in range(200)])
    threading.Timer(0.5, cancelled.set).start()
    began = time.monotonic()
    with pytest.raises(ImportCancelled):
        _extract(monkeypatch, folder, _slow, cancelled=cancelled)
    assert time.monotonic() - began < 5


def test_workers_that_never_answer_end_in_an_error_not_a_wait(monkeypatch, tmp_path):
    with pytest.raises(PrismError) as excinfo:
        _extract(monkeypatch, _datasets(tmp_path), _stuck, stall=1.5)
    assert excinfo.value.code == "import_stalled"
    assert "0 of 3 read" in str(excinfo.value)


def test_an_unreadable_file_is_named(monkeypatch, tmp_path):
    with pytest.raises(PrismError) as excinfo:
        _extract(monkeypatch, _datasets(tmp_path, ["a.spold", "b.spold", "c.spold"]), _broken)
    assert excinfo.value.code == "dataset_unreadable"
    assert "b.spold" in str(excinfo.value)


def test_a_worker_finds_the_folder_bw2io_would_race_for(client, project):
    """Two spawned workers importing bw2io together race to create the workspace's ``unlinked`` folder;
    the initializer creates it first, and a worker that finds it already there carries on."""
    import shutil

    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.ecoinvent_inventory import prepare_worker

    folder = get_bd().projects.dir / "unlinked"
    shutil.rmtree(folder, ignore_errors=True)
    prepare_worker()
    prepare_worker()
    assert folder.is_dir()


def test_a_folder_without_datasets_says_to_extract_first(tmp_path):
    from prism_lca.engine.ecoinvent_inventory import dataset_files

    with pytest.raises(PrismError) as excinfo:
        dataset_files(tmp_path)
    assert excinfo.value.code == "no_datasets"
    assert "extracted" in excinfo.value.hint


def _release(tmp_path):
    root = tmp_path / "ecoinvent 3.12_cutoff_ecoSpold02"
    (root / "datasets").mkdir(parents=True)
    (root / "MasterData").mkdir()
    write_flow_list(root / "MasterData" / "ElementaryExchanges.xml", FLOWS)
    return root


def test_the_extracted_release_folder_is_taken_for_its_datasets(tmp_path):
    from prism_lca.engine.ecoinvent import datasets_folder

    root = _release(tmp_path)
    assert datasets_folder(root) == root / "datasets"
    assert datasets_folder(root / "datasets") == root / "datasets"
    assert datasets_folder(tmp_path) == tmp_path


def test_a_folder_holding_only_the_archive_is_refused_with_the_remedy(client, token, tmp_path):
    (tmp_path / "ecoinvent 3.12_cutoff_ecoSpold02.7z").write_bytes(b"7z")
    r = client.post("/api/v1/setup/background", json={"source": "ecoinvent", "path": str(tmp_path)}, headers=token)
    assert r.status_code == 400
    error = r.json()["error"]
    assert error["code"] == "flow_list_not_found"
    assert "Extract ecoinvent 3.12_cutoff_ecoSpold02.7z first" in error["hint"]


def test_cancel_needs_a_running_import(client, token):
    r = client.post("/api/v1/setup/cancel", headers=token)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "import_not_cancellable"


def test_a_cancelled_import_writes_nothing_and_says_so(client, token, project, tmp_path, monkeypatch):
    from prism_lca.engine import ecoinvent, ecoinvent_inventory
    from prism_lca.engine.bootstrap import get_bd

    def cancelled(*args, **kwargs):
        raise ecoinvent_inventory.ImportCancelled

    monkeypatch.setattr(ecoinvent_inventory, "import_inventory", cancelled)
    ecoinvent.start_import(str(_release(tmp_path)), project, "ei-cancelled", run_in_thread=False)
    st = ecoinvent.status()
    assert st.state is ecoinvent.JobState.cancelled
    assert not st.cancellable
    assert "ei-cancelled" not in get_bd().databases


def test_an_error_in_the_job_carries_its_hint(client, token, project, tmp_path, monkeypatch):
    from prism_lca.engine import ecoinvent, ecoinvent_inventory

    def stalled(*args, **kwargs):
        raise PrismError("Reading the datasets stalled.", code="import_stalled", hint="Start the import again.")

    monkeypatch.setattr(ecoinvent_inventory, "import_inventory", stalled)
    ecoinvent.start_import(str(_release(tmp_path)), project, "ei-stalled", run_in_thread=False)
    st = ecoinvent.status()
    assert st.state is ecoinvent.JobState.error
    assert st.detail == "Reading the datasets stalled. Start the import again."


def _cancel_during_biosphere(monkeypatch):
    """The user clicks Cancel while the first step builds the biosphere."""
    from prism_lca.engine import ecoinvent

    real = ecoinvent._ensure_biosphere

    def ensure(elementary):
        result = real(elementary)
        ecoinvent.cancel_import()
        return result

    monkeypatch.setattr(ecoinvent, "_ensure_biosphere", ensure)


def test_a_cancel_never_loses_the_rewrite_of_a_bafu_first_workspace(client, token, project, tmp_path, monkeypatch):
    """The first step replaces the bundled flow list's marker; the pending rewrite must outlive a cancel."""
    from prism_lca.engine import ecoinvent, ecoinvent_inventory
    from prism_lca.engine.backgrounds import sync
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    bd.Database("biosphere3").write(
        {("biosphere3", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.databases["biosphere3"][ecoinvent.BIO_SOURCE_KEY] = "bw2io ecoinvent 3.9 flow list"
    bd.databases.flush()
    release = _release(tmp_path)

    _cancel_during_biosphere(monkeypatch)
    ecoinvent.start_import(str(release), project, "ei-bafu-first", run_in_thread=False)
    assert ecoinvent.status().state is ecoinvent.JobState.cancelled
    assert not sync.has_bundled_biosphere()  # the marker is gone …
    assert bd.databases["biosphere3"].get(ecoinvent.SYNC_PENDING_KEY)  # … the pending rewrite is not

    monkeypatch.undo()
    rewrites = []

    def written(ecospold2_dir, database, **kwargs):
        kwargs["begin_writing"](step="writing")
        bd.Database(database).write(
            {(database, "a"): {"name": "a", "unit": "kg", "location": "GLO", "reference product": "a", "exchanges": []}}
        )
        return 1

    monkeypatch.setattr(ecoinvent_inventory, "import_inventory", written)
    monkeypatch.setattr(
        sync,
        "ecoinvent_master",
        lambda *a, **k: rewrites.append(k.get("reprocess"))
        or {"remapped": [], "lifted_flows": 0, "bundled_methods_removed": 0, "flows_removed": 0},
    )
    ecoinvent.start_import(str(release), project, "ei-bafu-first", run_in_thread=False)
    assert ecoinvent.status().state is ecoinvent.JobState.done, ecoinvent.status().detail
    assert rewrites == [True]  # a retry processes the databases even where nothing moves any more
    assert not bd.databases["biosphere3"].get(ecoinvent.SYNC_PENDING_KEY)


def test_a_retry_over_an_existing_inventory_honours_a_cancel_or_refuses_it(
    client, token, project, tmp_path, monkeypatch
):
    """Before its writes the retry stops on a cancel; once it writes methods, a cancel is refused, not
    accepted and then ignored."""
    from prism_lca.engine import ecoinvent
    from prism_lca.engine.bootstrap import get_bd

    get_bd().Database("ei-retry").write(
        {("ei-retry", "a"): {"name": "a", "unit": "kg", "location": "GLO", "reference product": "a", "exchanges": []}}
    )
    release = _release(tmp_path)
    workbook = tmp_path / "methods.xlsx"
    workbook.write_bytes(b"stand-in; the import is replaced below")

    _cancel_during_biosphere(monkeypatch)
    ecoinvent.start_import(str(release), project, "ei-retry", str(workbook), run_in_thread=False)
    assert ecoinvent.status().state is ecoinvent.JobState.cancelled

    monkeypatch.undo()
    refused = []

    def lcia(xlsx):
        with pytest.raises(PrismError) as excinfo:
            ecoinvent.cancel_import()
        refused.append(excinfo.value.code)
        return "Methods written."

    monkeypatch.setattr(ecoinvent, "_import_lcia", lcia)
    ecoinvent.start_import(str(release), project, "ei-retry", str(workbook), run_in_thread=False)
    assert ecoinvent.status().state is ecoinvent.JobState.done, ecoinvent.status().detail
    assert refused == ["import_not_cancellable"]


def test_a_retried_remap_processes_even_when_nothing_moves(client, token, project, monkeypatch):
    """An earlier run may have committed the exchanges and died in process(): nothing moves now, yet the
    calculation data is stale."""
    from prism_lca.engine.backgrounds import sync
    from prism_lca.engine.backgrounds.flow_mapping import TargetBiosphere
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    bd.Database("biosphere3").write(
        {("biosphere3", "co2"): {"name": "Carbon dioxide", "type": "emission", "categories": ("air",), "unit": "kg"}}
    )
    bd.Database("fg").write(
        {("fg", "a"): {"name": "a", "unit": "kg", "location": "GLO", "reference product": "a", "exchanges": [
            {"input": ("biosphere3", "co2"), "amount": 1.0, "type": "biosphere"}]}}
    )
    target = TargetBiosphere.from_records(
        [{"code": "co2", "name": "Carbon dioxide", "categories": ("air",), "unit": "kg"}], "release"
    )
    processed = []
    backend = type(bd.Database("fg"))
    real = backend.process

    def spy(self, *a, **k):
        processed.append(self.name)
        return real(self, *a, **k)

    monkeypatch.setattr(backend, "process", spy)
    assert sync.remap_database("fg", target, origin="test")["moved"] == 0
    assert processed == []
    sync.remap_database("fg", target, origin="test", reprocess=True)
    assert processed == ["fg"]
