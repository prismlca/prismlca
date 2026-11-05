"""Workspaces an earlier PrismLCA kept in somebody's Brightway directory, copied out without harming theirs.

The directory is made the way it happens in reality, by two programs in one ``BRIGHTWAY2_DIR``: a Brightway
user's own projects, built through bw2data and bw2calc as in Brightway's tutorials (biosphere, foreground
database with technosphere and biosphere exchanges, a parameter and a formula, an LCIA method and a
calculation that wrote its processed arrays), and next to them a workspace made through PrismLCA's own API,
as every version up to 0.9.9 did when that variable was set.

The rule under test: nothing in that directory may change, not by a byte and not by a new file. The tests
make the whole tree read-only while PrismLCA works, so any attempt to write there fails them.
"""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from backend_process import get, snapshot, spawn, stop, wait_for_start

from prism_lca.engine import workspace_carryover
from prism_lca.engine.data_version import STAMP_FILE
from prism_lca.engine.workspace_carryover import ORIGIN_FILE, PROJECTS_DB, carry_over

#: A Brightway user's own work, as in the Brightway tutorials — then the workspace an earlier PrismLCA
#: made in the same directory through its API. argv: the file to write the user's LCA score into.
_BUILD = r'''
import json, sys
import bw2calc as bc
import bw2data as bd

bd.projects.set_current("steel-bottle-study")
bio = bd.Database("my-biosphere")
bio.write({
    ("my-biosphere", "co2"): {"name": "Carbon dioxide, fossil", "unit": "kilogram", "type": "emission",
                              "categories": ("air",)},
    ("my-biosphere", "ch4"): {"name": "Methane, fossil", "unit": "kilogram", "type": "emission",
                              "categories": ("air",)},
})
bd.parameters.new_project_parameters([{"name": "steel_mass", "amount": 0.3}])
fg = bd.Database("bottles")
fg.write({
    ("bottles", "steel"): {"name": "steel production", "unit": "kilogram", "location": "DE", "exchanges": [
        {"input": ("bottles", "steel"), "amount": 1, "type": "production"},
        {"input": ("my-biosphere", "co2"), "amount": 1.9, "type": "biosphere"},
    ]},
    ("bottles", "bottle"): {"name": "steel water bottle", "unit": "unit", "location": "DE", "exchanges": [
        {"input": ("bottles", "bottle"), "amount": 1, "type": "production"},
        {"input": ("bottles", "steel"), "amount": 0.3, "type": "technosphere", "formula": "steel_mass"},
        {"input": ("my-biosphere", "ch4"), "amount": 0.001, "type": "biosphere"},
    ]},
})
method = bd.Method(("my method", "climate change", "GWP100"))
method.register(unit="kg CO2-eq")
method.write([(("my-biosphere", "co2"), 1.0), (("my-biosphere", "ch4"), 29.8)])
lca = bc.LCA({fg.get("bottle"): 1}, method.name)
lca.lci()
lca.lcia()

bd.projects.set_current("Übung 2")  # a name bw2data has to make safe for a folder
bd.Database("scratch").write({("scratch", "x"): {"name": "x", "unit": "kg", "exchanges": []}})

# The earlier PrismLCA, through its API, in the same directory.
from fastapi.testclient import TestClient
from prism_lca.app import create_app
from prism_lca.config import Settings
from prism_lca.engine.data_version import check_and_stamp
import os

client = TestClient(create_app(Settings(auth_token="t", embedding_backend="hashing")))
tok = {"X-Prism-Token": "t"}
assert client.post("/api/v1/projects", json={"name": "prism-workspace"}, headers=tok).status_code == 200
assert client.post("/api/v1/databases/foreground", json={"name": "bottle-model"}, headers=tok).status_code == 200
study = {"database": "bottle-model", "goal": "PCF of a bottle", "scope": "cradle to gate", "author": ""}
assert client.post("/api/v1/study", json=study, headers=tok).status_code == 200
made = client.post("/api/v1/model/activities", json={"database": "bottle-model", "name": "bottle assembly",
                                                      "unit": "unit"}, headers=tok)
assert made.status_code == 200, made.text
check_and_stamp([__import__("pathlib").Path(os.environ["BRIGHTWAY2_DIR"])], "0.9.9")
json.dump({"score": lca.score}, open(sys.argv[1], "w"))
'''

#: Reads a Brightway directory back through bw2data: projects, and the named project's databases.
_READ = r'''
import json, sys
import bw2calc as bc
import bw2data as bd
out = {"projects": sorted(p.name for p in bd.projects)}
bd.projects.set_current(sys.argv[1])
out["databases"] = {name: len(bd.Database(name)) for name in bd.databases}
if sys.argv[1] == "steel-bottle-study":
    lca = bc.LCA({bd.Database("bottles").get("bottle"): 1}, ("my method", "climate change", "GWP100"))
    lca.lci(); lca.lcia()
    out["score"] = lca.score
print(json.dumps(out))
'''


def _python(code: str, brightway_dir: Path, *args: str, data_dir: Path | None = None) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PRISM_", "BRIGHTWAY", "PYTEST"))}
    env.update(BRIGHTWAY2_DIR=str(brightway_dir), PYTHONPATH=os.pathsep.join(sys.path))
    if data_dir is not None:
        env["PRISM_DATA_DIR"] = str(data_dir)
    out = subprocess.run(
        [sys.executable, "-c", code, *args], env=env, capture_output=True, text=True, timeout=300
    )
    assert out.returncode == 0, out.stderr[-3000:]
    return out.stdout


def _read(brightway_dir: Path, project: str) -> dict:
    """What bw2data sees in ``brightway_dir`` (its own log lines share stdout; the answer is the last)."""
    return json.loads(_python(_READ, brightway_dir, project).strip().splitlines()[-1])


@pytest.fixture(scope="module")
def shared_dir(tmp_path_factory) -> tuple[Path, float]:
    """The shared directory as an earlier PrismLCA left it, and the Brightway user's LCA score."""
    root = tmp_path_factory.mktemp("shared")
    bw = root / "Brightway3"
    bw.mkdir()
    score_file = root / "score.json"
    _python(_BUILD, bw, str(score_file), data_dir=root / "old-prism-data")
    return bw, json.loads(score_file.read_text())["score"]


@pytest.fixture
def theirs(shared_dir, tmp_path) -> Path:
    """A fresh copy of the shared directory for one test."""
    copy = tmp_path / "Brightway3"
    shutil.copytree(shared_dir[0], copy)
    return copy


@contextlib.contextmanager
def _read_only(tree: Path):
    """Nothing under ``tree`` can be written, created or removed until the block ends."""
    if os.name == "nt" or os.geteuid() == 0:
        pytest.skip("permission bits do not stop this user from writing")
    paths = [tree, *tree.rglob("*")]
    modes = {p: p.stat().st_mode for p in paths}
    for p in paths:
        p.chmod(modes[p] & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
    try:
        yield
    finally:
        for p in reversed(paths):
            p.chmod(modes[p])


def _carry(old: Path, new: Path) -> tuple[str | None, list[str], list[str]]:
    progress: list[str] = []
    log: list[str] = []
    return carry_over(old, new, progress.append, log.append), progress, log


def test_the_fixture_is_a_real_shared_directory(shared_dir):
    bw, score = shared_dir
    seen = _read(shutil.copytree(bw, bw.parent / "probe"), "steel-bottle-study")
    assert {"steel-bottle-study", "Übung 2", "prism-workspace"} <= set(seen["projects"])
    assert seen["databases"]["bottles"] == 2 and seen["databases"]["my-biosphere"] == 2
    assert seen["score"] == pytest.approx(score) and score > 0
    assert (bw / STAMP_FILE).is_file()


def test_only_prismlca_workspaces_are_copied_and_their_directory_stays_as_it_was(theirs, tmp_path):
    before = snapshot(theirs)
    own = tmp_path / "own"
    with _read_only(theirs):
        refusal, progress, log = _carry(theirs, own)
    assert refusal is None, refusal
    assert snapshot(theirs) == before
    assert progress and "prism-workspace" in log[-1]

    seen = _read(own, "prism-workspace")
    # Their projects stay theirs; bw2data adds its own "default" on opening.
    assert set(seen["projects"]) == {"prism-workspace", "default"}
    assert seen["databases"]["bottle-model"] == 1
    workspace = next(p for p in own.iterdir() if p.name.startswith("prism-workspace."))
    origin = json.loads((workspace / "prism_meta" / ORIGIN_FILE).read_text(encoding="utf-8"))
    assert origin["copied_from"] == str(theirs / workspace.name)
    assert not list(own.glob(f"*{workspace_carryover._PARTIAL}*"))


def test_their_results_are_the_same_afterwards(theirs, shared_dir, tmp_path):
    with _read_only(theirs):
        assert _carry(theirs, tmp_path / "own")[0] is None
    # Read back from a copy: bw2data writes when it opens a directory, and this one is theirs.
    seen = _read(shutil.copytree(theirs, tmp_path / "probe"), "steel-bottle-study")
    assert seen["score"] == pytest.approx(shared_dir[1])
    assert seen["databases"] == {"bottles": 2, "my-biosphere": 2}


def test_it_happens_once(theirs, tmp_path):
    own = tmp_path / "own"
    assert _carry(theirs, own)[0] is None
    stamp = (own / PROJECTS_DB).stat().st_mtime_ns
    refusal, progress, log = _carry(theirs, own)
    assert refusal is None and progress == [] and log == []
    assert (own / PROJECTS_DB).stat().st_mtime_ns == stamp


def test_an_interrupted_copy_is_finished_by_the_next_start(theirs, tmp_path):
    own = tmp_path / "own"
    own.mkdir()
    (own / f"{workspace_carryover._PARTIAL}prism-workspace.half").mkdir()  # a crash mid-copy
    (own / f"{PROJECTS_DB}{workspace_carryover._PARTIAL}tmp").write_bytes(b"half a database")
    assert _carry(theirs, own)[0] is None
    seen = _read(own, "prism-workspace")
    assert seen["databases"]["bottle-model"] == 1


def test_too_little_space_refuses_before_copying_anything(theirs, tmp_path, monkeypatch):
    before = snapshot(theirs)
    monkeypatch.setattr(shutil, "disk_usage", lambda _p: shutil._ntuple_diskusage(10**12, 10**12, 1000))
    own = tmp_path / "own"
    refusal, _, _ = _carry(theirs, own)
    assert refusal is not None and "PRISM_BRIGHTWAY_DIR" in refusal
    assert not (own / PROJECTS_DB).exists()
    assert not [p for p in own.iterdir() if p.is_dir()]
    assert snapshot(theirs) == before


def test_a_directory_prismlca_only_started_in_gives_nothing(tmp_path):
    other = tmp_path / "Brightway3"
    other.mkdir()
    _python("import bw2data as bd; bd.projects.set_current('their-study')", other)
    (other / STAMP_FILE).write_text('{"schema": 1, "written_by": "0.9.9"}', encoding="utf-8")
    own = tmp_path / "own"
    refusal, _, log = _carry(other, own)
    assert refusal is None and "nothing to copy" in log[-1]
    assert not (own / PROJECTS_DB).exists()


def test_the_installed_app_starts_with_its_workspace_and_without_theirs(theirs, tmp_path):
    """The whole start as the shell does it, their directory read-only throughout."""
    before = snapshot(theirs)
    data = tmp_path / "prism-data"
    with _read_only(theirs):
        proc = spawn({"PRISM_DATA_DIR": str(data), "BRIGHTWAY2_DIR": str(theirs)}, frozen=True)
        try:
            event, progress = wait_for_start(proc)
            assert event["event"] == "prism-backend-ready", event
            names = {p["name"] for p in get(event, "/api/v1/projects")}
        finally:
            err = stop(proc)
    assert snapshot(theirs) == before
    assert "prism-workspace" in names
    assert not names & {"steel-bottle-study", "Übung 2"}
    assert progress, "a carry-over says what it is doing while it runs"
    assert "Copied 1 workspace" in err


def test_a_brightway_program_writing_there_stops_the_copy_without_touching_anything(theirs, tmp_path):
    # The Activity Browser in the middle of a commit: SQLite's journal sits beside the database.
    workspace = next(p for p in theirs.iterdir() if p.name.startswith("prism-workspace."))
    (workspace / "lci" / "databases.db-journal").write_bytes(b"\x00" * 4096)
    before = snapshot(theirs)
    own = tmp_path / "own"
    with _read_only(theirs):
        refusal, _, _ = _carry(theirs, own)
    assert refusal is not None and "Close that program" in refusal
    assert snapshot(theirs) == before
    assert not (own / PROJECTS_DB).exists()
    assert not list(own.glob("prism-workspace.*"))


def test_after_an_interruption_only_the_rest_needs_space(theirs, tmp_path, monkeypatch):
    own = tmp_path / "own"
    assert _carry(theirs, own)[0] is None
    (own / PROJECTS_DB).unlink()  # interrupted after the workspace, before projects.db
    (own / f"{workspace_carryover._PARTIAL}stale").mkdir()  # and a leftover of ours
    monkeypatch.setattr(
        shutil, "disk_usage", lambda _p: shutil._ntuple_diskusage(10**12, 10**12, workspace_carryover._HEADROOM)
    )
    refusal, _, log = _carry(theirs, own)
    assert refusal is None and "Copied 0 workspace" in log[-1]
    assert (own / PROJECTS_DB).exists()
    assert not list(own.glob(f"*{workspace_carryover._PARTIAL}*"))
