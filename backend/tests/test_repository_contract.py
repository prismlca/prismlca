"""One contract, two implementations — StubRepository and BrightwayRepository against the same suite.

BrightwayRepository had zero direct tests, yet it is the module that owns the rename/delete cascade
over the per-model stores — and "forgot to add the new store to the cascade" is a bug class that has
already shipped once (deleting model "X" left its reports in the file, and creating a new model
named "X" resurrected them; see ``report_store.remove_database``). The parametrised half pins the
``LcaRepository`` interface on both implementations; the Brightway-only half pins the cascade,
which sits on the concrete class because the interface does not declare it (documented below).

Known contract gaps this suite records rather than hides (the repository itself is on hold and not
to be reshaped):

- ``rename_foreground_database``, ``delete_foreground_database``, ``duplicate_foreground_database``
  and ``ensure_working_project`` exist only on ``BrightwayRepository`` — ``LcaRepository`` never
  declares them, so the stub cannot stand in for API-shape tests that touch those routes.
- ``StubRepository`` keeps databases only for the *current* project: creating or switching projects
  clears its database dict, while Brightway keeps each project's databases. The parametrised tests
  therefore stay inside a single project.
"""

from __future__ import annotations

import uuid

import pytest

from prism_lca.engine.brightway_repository import BrightwayRepository
from prism_lca.engine.guardrails import set_read_only
from prism_lca.errors import PrismError
from prism_lca.repository.base import BackendInfo, DatabaseInfo, LcaRepository, ProjectInfo
from prism_lca.repository.stub import StubRepository


def _name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


@pytest.fixture(params=["stub", "brightway"])
def repo(request) -> LcaRepository:
    """Both implementations, each isolated: the stub is fresh per instance, Brightway gets a
    uniquely named project activated through its own interface (the conftest already points
    BRIGHTWAY2_DIR at a per-process throwaway directory)."""
    if request.param == "stub":
        return StubRepository()
    real = BrightwayRepository()
    real.create_project(_name("contract"))
    return real


def _err(excinfo) -> PrismError:
    return excinfo.value


class TestInterfaceContract:
    def test_backend_info_shape(self, repo: LcaRepository):
        info = repo.backend_info()
        assert isinstance(info, BackendInfo)
        assert info.engine == "brightway25"
        assert isinstance(info.ready, bool)

    def test_create_project_activates_and_lists(self, repo: LcaRepository):
        name = _name("proj")
        created = repo.create_project(name)
        assert isinstance(created, ProjectInfo)
        assert created.name == name and created.is_active
        listed = {p.name: p for p in repo.list_projects()}
        assert listed[name].is_active
        current = repo.current_project()
        assert current is not None and current.name == name

    def test_create_project_refuses_empty_and_duplicate(self, repo: LcaRepository):
        with pytest.raises(PrismError) as excinfo:
            repo.create_project("   ")
        assert _err(excinfo).code == "invalid_name"
        name = _name("proj")
        repo.create_project(name)
        with pytest.raises(PrismError) as excinfo:
            repo.create_project(name)
        assert _err(excinfo).code == "project_exists"
        assert _err(excinfo).status_code == 409

    def test_set_current_project(self, repo: LcaRepository):
        a, b = _name("proj"), _name("proj")
        repo.create_project(a)
        repo.create_project(b)  # create_project activates, so b is current now
        activated = repo.set_current_project(a)
        assert activated.name == a and activated.is_active
        current = repo.current_project()
        assert current is not None and current.name == a
        with pytest.raises(PrismError) as excinfo:
            repo.set_current_project(_name("missing"))
        assert _err(excinfo).code == "project_not_found"
        assert _err(excinfo).status_code == 404

    def test_delete_project(self, repo: LcaRepository):
        with pytest.raises(PrismError) as excinfo:
            repo.delete_project(_name("missing"))
        assert _err(excinfo).code == "project_not_found"
        with pytest.raises(PrismError) as excinfo:
            repo.delete_project("default")
        assert _err(excinfo).code == "project_protected"
        # Deleting the ACTIVE project must not strand the caller: both implementations fall back
        # to Brightway's ever-present 'default'.
        name = _name("proj")
        repo.create_project(name)
        repo.delete_project(name)
        assert name not in {p.name for p in repo.list_projects()}
        current = repo.current_project()
        assert current is not None and current.name == "default"

    def test_create_foreground_database(self, repo: LcaRepository):
        db = _name("model")
        info = repo.create_foreground_database(db)
        assert isinstance(info, DatabaseInfo)
        assert info.name == db and info.kind == "foreground"
        assert info.read_only is False and info.node_count == 0
        listed = {d.name: d for d in repo.list_databases()}
        assert db in listed
        assert listed[db].read_only is False and listed[db].kind == "foreground"
        with pytest.raises(PrismError) as excinfo:
            repo.create_foreground_database(db)
        assert _err(excinfo).code == "database_exists"
        assert _err(excinfo).status_code == 409


@pytest.fixture
def bw_repo() -> BrightwayRepository:
    real = BrightwayRepository()
    real.create_project(_name("cascade"))
    return real


class TestForegroundCascade:
    """Brightway-only: the rename/delete cascade over the per-model stores. Not on the interface —
    see the module docstring — so there is nothing to run the stub against."""

    def _seeded_model(self, name: str) -> tuple[str, str]:
        """A foreground db with one entry in three representative per-model stores."""
        from prism_lca.engine.report_store import ReportStore
        from prism_lca.engine.study import StudyMetaStore
        from prism_lca.engine.tags import TagStore

        code = "act-" + uuid.uuid4().hex[:6]
        TagStore().add(name, code, "phase", "Production")
        StudyMetaStore().update(name, {"goal": "contract-test goal"})
        report = ReportStore().create(name, name="Contract report")
        return code, report["id"]

    def test_rename_moves_the_per_model_stores(self, bw_repo: BrightwayRepository):
        from prism_lca.engine.report_store import ReportStore
        from prism_lca.engine.study import StudyMetaStore
        from prism_lca.engine.tags import TagStore

        old, new = _name("model"), _name("model")
        bw_repo.create_foreground_database(old)
        code, report_id = self._seeded_model(old)

        info = bw_repo.rename_foreground_database(old, new)
        assert info.name == new and info.read_only is False

        assert old not in {d.name for d in bw_repo.list_databases()}
        assert new in {d.name for d in bw_repo.list_databases()}
        # The stores follow the new name — and nothing strands under the dead old one.
        assert TagStore().list_for(new, code), "tags did not follow the rename"
        assert not TagStore().list_for(old, code)
        assert StudyMetaStore().get(new).get("goal") == "contract-test goal"
        assert not StudyMetaStore().get(old)
        assert [r["id"] for r in ReportStore().list_reports(new)] == [report_id]
        assert ReportStore().list_reports(old) == []

    def test_rename_error_contract(self, bw_repo: BrightwayRepository):
        a, b = _name("model"), _name("model")
        bw_repo.create_foreground_database(a)
        bw_repo.create_foreground_database(b)
        with pytest.raises(PrismError) as excinfo:
            bw_repo.rename_foreground_database(_name("missing"), _name("model"))
        assert _err(excinfo).code == "database_not_found"
        with pytest.raises(PrismError) as excinfo:
            bw_repo.rename_foreground_database(a, b)
        assert _err(excinfo).code == "database_exists"
        with pytest.raises(PrismError) as excinfo:
            bw_repo.rename_foreground_database(a, "  ")
        assert _err(excinfo).code == "invalid_name"
        # Renaming to itself is a documented no-op, not an error.
        same = bw_repo.rename_foreground_database(a, a)
        assert same.name == a
        set_read_only(a, True)
        with pytest.raises(PrismError) as excinfo:
            bw_repo.rename_foreground_database(a, _name("model"))
        assert _err(excinfo).code == "not_foreground"

    def test_delete_cleans_the_stores_and_nothing_resurrects(self, bw_repo: BrightwayRepository):
        from prism_lca.engine.report_store import ReportStore
        from prism_lca.engine.study import StudyMetaStore
        from prism_lca.engine.tags import TagStore

        db = _name("model")
        bw_repo.create_foreground_database(db)
        code, _report_id = self._seeded_model(db)

        assert bw_repo.delete_foreground_database(db) == {"deleted": db}
        assert db not in {d.name for d in bw_repo.list_databases()}
        assert not TagStore().list_for(db, code)
        assert not StudyMetaStore().get(db)
        assert ReportStore().list_reports(db) == []

        # The shipped bug class: a NEW model under the SAME name must start empty — no resurrected
        # reports, tags or study metadata from the deleted one.
        bw_repo.create_foreground_database(db)
        assert ReportStore().list_reports(db) == []
        assert not TagStore().list_for(db, code)
        assert not StudyMetaStore().get(db)

    def test_delete_error_contract(self, bw_repo: BrightwayRepository):
        with pytest.raises(PrismError) as excinfo:
            bw_repo.delete_foreground_database(_name("missing"))
        assert _err(excinfo).code == "database_not_found"
        db = _name("model")
        bw_repo.create_foreground_database(db)
        set_read_only(db, True)
        with pytest.raises(PrismError) as excinfo:
            bw_repo.delete_foreground_database(db)
        assert _err(excinfo).code == "read_only_database"
        assert _err(excinfo).status_code == 409
