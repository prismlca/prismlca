"""PrismLCA next to somebody's own Brightway installation (engine/brightway_dir.py, server.main).

People who use Brightway or the Activity Browser often have ``BRIGHTWAY2_DIR`` set for good — on Windows as
a user variable every program inherits. The app used to follow it, so its workspaces, its data-format stamp
and its instance lock landed in the user's own Brightway directory.
"""
from __future__ import annotations

from pathlib import Path

from backend_process import snapshot, spawn, stop, wait_for_start

from prism_lca.config import Settings
from prism_lca.engine.brightway_dir import OWNER_FILE, choose, claim, default_dir, take
from prism_lca.engine.data_version import STAMP_FILE


def _settings(tmp_path: Path, brightway_dir: Path | None = None) -> Settings:
    return Settings(data_dir=tmp_path / "data", brightway_dir=brightway_dir)


def _foreign(tmp_path: Path, *, stamped: bool = False) -> Path:
    """A Brightway directory of somebody's own, as the Activity Browser leaves it."""
    other = tmp_path / "Brightway3"
    other.mkdir(parents=True)
    (other / "projects.db").write_bytes(b"their projects")
    if stamped:  # an earlier PrismLCA started here
        (other / STAMP_FILE).write_text('{"schema": 1, "written_by": "0.9.9"}', encoding="utf-8")
    return other


def test_without_the_variable_the_app_uses_its_own_directory(tmp_path):
    settings = _settings(tmp_path)
    choice = choose(settings, {}, from_source=False)
    assert choice.path == tmp_path / "data" / "brightway" == default_dir(settings)
    assert choice.note is None and choice.refusal is None and choice.carry_over_from is None


def test_a_variable_naming_the_own_directory_changes_nothing(tmp_path):
    settings = _settings(tmp_path)
    choice = choose(settings, {"BRIGHTWAY2_DIR": str(tmp_path / "data" / "brightway")}, from_source=True)
    assert choice == choose(settings, {}, from_source=True)


def test_the_installed_app_leaves_another_brightway_directory_alone(tmp_path):
    other = _foreign(tmp_path)
    choice = choose(_settings(tmp_path), {"BRIGHTWAY2_DIR": str(other)}, from_source=False)
    assert choice.path == tmp_path / "data" / "brightway"
    assert choice.refusal is None and choice.carry_over_from is None
    assert str(other) in choice.note and "PRISM_BRIGHTWAY_DIR" in choice.note


def test_a_variable_pointing_nowhere_does_not_stop_the_installed_app(tmp_path):
    # bw2data raises on a BRIGHTWAY2_DIR that is not a directory — a removed drive used to end the start.
    choice = choose(_settings(tmp_path), {"BRIGHTWAY2_DIR": str(tmp_path / "gone")}, from_source=False)
    assert choice.path == tmp_path / "data" / "brightway" and choice.refusal is None


def test_a_directory_an_earlier_version_worked_in_is_not_opened_but_carried_over(tmp_path):
    other = _foreign(tmp_path, stamped=True)
    choice = choose(_settings(tmp_path), {"BRIGHTWAY2_DIR": str(other)}, from_source=False)
    assert choice.path == tmp_path / "data" / "brightway"
    assert choice.carry_over_from == other and choice.refusal is None


def test_from_source_any_foreign_directory_refuses_instead_of_falling_back(tmp_path):
    # A developer's BRIGHTWAY2_DIR means a throwaway directory; the default — or copying into it — would
    # be the real one. Stamped or not.
    for stamped in (False, True):
        other = _foreign(tmp_path / str(stamped), stamped=stamped)
        choice = choose(_settings(tmp_path), {"BRIGHTWAY2_DIR": str(other)}, from_source=True)
        assert choice.refusal is not None and choice.carry_over_from is None
        assert "PRISM_BRIGHTWAY_DIR" in choice.refusal


def test_prism_brightway_dir_cannot_point_into_somebody_elses_projects(tmp_path):
    # Not their own Brightway, and not the one an earlier PrismLCA shared with them: the stamp says
    # PrismLCA started there, not that the projects are its own.
    for stamped in (False, True):
        other = _foreign(tmp_path / str(stamped), stamped=stamped)
        for from_source in (False, True):
            choice = choose(_settings(tmp_path, other), {}, from_source=from_source)
            assert choice.refusal is not None and "never works inside" in choice.refusal
    assert {p.name for p in other.iterdir()} == {"projects.db", STAMP_FILE}


def test_prism_brightway_dir_may_be_empty_or_made_by_prismlca(tmp_path):
    empty = tmp_path / "empty"
    assert choose(_settings(tmp_path, empty), {}, from_source=False).refusal is None
    claim(empty)
    (empty / "projects.db").write_bytes(b"ours")  # what bw2data does next
    assert choose(_settings(tmp_path, empty), {}, from_source=False).refusal is None


def test_claim_marks_only_an_empty_directory(tmp_path):
    fresh = tmp_path / "fresh"
    claim(fresh)
    assert (fresh / OWNER_FILE).is_file()
    other = _foreign(tmp_path)
    claim(other)
    assert not (other / OWNER_FILE).exists()
    project = tmp_path / "Brightway3" / "their-study.c21f969b"  # a project folder: no projects.db in it
    (project / "lci").mkdir(parents=True)
    claim(project)
    assert not (project / OWNER_FILE).exists()


def test_a_project_folder_inside_somebody_elses_brightway_is_refused_untouched(tmp_path):
    project = tmp_path / "Brightway3" / "their-study.c21f969b"
    (project / "lci").mkdir(parents=True)
    (project / "lci" / "databases.db").write_bytes(b"their data")
    choice = choose(_settings(tmp_path, project), {}, from_source=False)
    assert choice.refusal is not None
    assert {p.relative_to(project).as_posix() for p in project.rglob("*")} == {"lci", "lci/databases.db"}


def test_the_brightway_folder_of_a_prismlca_data_directory_may_be_named_explicitly(tmp_path):
    # A copy of a data directory (screenshots, a test run) or the default location named on purpose.
    data = tmp_path / "data"
    (data / "brightway").mkdir(parents=True)
    (data / "brightway" / "projects.db").write_bytes(b"from 0.9.9")
    (data / STAMP_FILE).write_text('{"schema": 1}', encoding="utf-8")
    assert choose(_settings(tmp_path, data / "brightway"), {}, from_source=False).refusal is None
    assert choose(_settings(tmp_path), {}, from_source=True).refusal is None


def test_a_data_directory_that_is_not_prismlcas_does_not_vouch_for_its_brightway_folder(tmp_path):
    (tmp_path / "data" / "brightway").mkdir(parents=True)
    (tmp_path / "data" / "brightway" / "projects.db").write_bytes(b"their projects")
    assert choose(_settings(tmp_path), {}, from_source=False).refusal is not None




def test_prism_brightway_dir_wins_over_everything(tmp_path):
    other = _foreign(tmp_path, stamped=True)
    chosen = tmp_path / "chosen"
    for from_source in (False, True):
        choice = choose(_settings(tmp_path, chosen), {"BRIGHTWAY2_DIR": str(other)}, from_source=from_source)
        assert choice.path == chosen and choice.refusal is None and choice.carry_over_from is None


def test_an_empty_prism_brightway_dir_counts_as_unset(tmp_path, monkeypatch):
    monkeypatch.setenv("PRISM_BRIGHTWAY_DIR", "  ")
    assert Settings(data_dir=tmp_path).brightway_dir is None


# --- the real start-up --------------------------------------------------------------------------------------


def test_the_installed_backend_starts_beside_a_brightway_installation_without_touching_it(tmp_path):
    other = _foreign(tmp_path)
    before = snapshot(other)
    proc = spawn({"PRISM_DATA_DIR": str(tmp_path / "data"), "BRIGHTWAY2_DIR": str(other)}, frozen=True)
    try:
        event, _ = wait_for_start(proc)
        assert event["event"] == "prism-backend-ready", event
    finally:
        err = stop(proc)
    assert snapshot(other) == before
    assert (tmp_path / "data" / "brightway" / STAMP_FILE).is_file()
    assert "is left alone" in err


def test_a_start_from_source_with_a_foreign_brightway_dir_is_refused_untouched(tmp_path):
    other = _foreign(tmp_path)
    proc = spawn({"PRISM_DATA_DIR": str(tmp_path / "data"), "BRIGHTWAY2_DIR": str(other)}, frozen=False)
    try:
        event, _ = wait_for_start(proc)
    finally:
        stop(proc, terminate=False)
    assert event["event"] == "prism-backend-refused"
    assert "PRISM_BRIGHTWAY_DIR" in event["reason"]
    assert proc.returncode == 5
    assert snapshot(other) == {"projects.db": b"their projects"}
    assert not (tmp_path / "data").exists()


def test_a_folder_filled_by_another_program_during_the_start_is_not_taken(tmp_path):
    # choose() saw it empty; before the claim, somebody's Brightway put its projects there.
    folder = tmp_path / "chosen"
    settings = _settings(tmp_path, folder)
    assert choose(settings, {}, from_source=False).refusal is None
    folder.mkdir()
    (folder / "projects.db").write_bytes(b"their projects")
    assert take(folder, settings) is not None
    assert {p.name for p in folder.iterdir()} == {"projects.db"}


def test_take_marks_an_empty_folder_and_accepts_the_data_directorys_own(tmp_path):
    fresh = tmp_path / "fresh"
    assert take(fresh, _settings(tmp_path, fresh)) is None and (fresh / OWNER_FILE).is_file()
    data = tmp_path / "data"
    (data / "brightway").mkdir(parents=True)
    (data / "brightway" / "projects.db").write_bytes(b"from 0.9.9")
    (data / STAMP_FILE).write_text('{"schema": 1}', encoding="utf-8")
    assert take(data / "brightway", _settings(tmp_path)) is None
    assert not (data / "brightway" / OWNER_FILE).exists()
