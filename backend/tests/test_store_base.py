"""The shared JSON-store base and the per-model registry — the guards that keep them honest.

Two bug classes this file exists for. First, the shipped one: a per-model store that the
rename/delete cascade forgot (deleting model "X" left its reports behind, and a new model named "X"
resurrected them). The registry test seeds EVERY registered store and walks the real cascade; the
static test fails when a store module grows a ``rename_database`` that is not registered. Second,
the silent one: twelve hand-rolled ``_load`` copies had drifted into five error policies — the
policy tests pin what each policy means, and the format test pins that the base writes exactly the
bytes the hand-rolled writers wrote (the on-disk format is a compatibility surface).
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from prism_lca.engine._store import JsonFileStore, per_model_stores, read_json, write_json_atomic
from prism_lca.errors import PrismError


class TestLoadPolicies:
    def test_missing_file_yields_default(self, tmp_path: Path):
        assert read_json(tmp_path / "gone.json", default={"a": 1}) == {"a": 1}

    def test_propagate_raises_on_corrupt(self, tmp_path: Path):
        p = tmp_path / "broken.json"
        p.write_text("{not json", encoding="utf-8")
        with pytest.raises(json.JSONDecodeError):
            read_json(p, default={})

    def test_empty_io_swallows_corrupt_but_returns_default(self, tmp_path: Path):
        p = tmp_path / "broken.json"
        p.write_text("{not json", encoding="utf-8")
        assert read_json(p, default={"fresh": True}, on_error="empty_io") == {"fresh": True}

    def test_report_store_still_refuses_a_corrupt_file(self, project):
        # THE policy that must never regress: treating a corrupt reports.json as `{}` would let the
        # very next "create report" atomically replace every report in the project.
        from prism_lca.engine._store import prism_meta_dir
        from prism_lca.engine.report_store import ReportStore

        path = prism_meta_dir() / "reports.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{definitely not json", encoding="utf-8")
        try:
            with pytest.raises(PrismError) as excinfo:
                ReportStore().list_reports("whatever")
            assert excinfo.value.code == "report_store_unreadable"
        finally:
            path.unlink()


class TestOnDiskFormat:
    def test_write_matches_the_hand_rolled_serialisation(self, tmp_path: Path):
        # Byte-identical to what every store wrote before the base existed:
        # json.dumps(data, ensure_ascii=False, indent=1) — indent 1, unicode kept literal.
        data = {"müsli/ä": [{"dimension": "Life-cycle phase", "value": "Prodüktion"}]}
        p = tmp_path / "x.json"
        write_json_atomic(p, data)
        assert p.read_text(encoding="utf-8") == json.dumps(data, ensure_ascii=False, indent=1)
        assert not p.with_name("x.json.tmp").exists(), "the tmp file must be replaced, not left behind"

    def test_store_lock_is_per_class_and_reentrant(self):
        class _A(JsonFileStore):
            FILENAME = "never-written-a.json"

        class _B(JsonFileStore):
            FILENAME = "never-written-b.json"

        assert _A()._lock is _A()._lock, "stateless instances must share one lock"
        assert _A()._lock is not _B()._lock, "two stores must not serialise each other"
        with _A()._lock:
            with _A()._lock:  # a locked mutator may call _load, which may write a migration back
                pass


def _seed_every_store(name: str) -> dict:
    """Give model ``name`` data in every registered store; returns, per store, "does the model have it?".

    The model gets one process, ``c1``: a tag belongs to a model by its process codes."""
    from prism_lca.engine import model_folders, parameter_groups
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.chat_store import ChatStore
    from prism_lca.engine.report_store import ReportStore
    from prism_lca.engine.research_log import ResearchLogStore
    from prism_lca.engine.review_log import ReviewLogStore
    from prism_lca.engine.scenarios import ScenarioStore
    from prism_lca.engine.study import StudyMetaStore
    from prism_lca.engine.tags import TagStore
    from prism_lca.engine.view_store import ViewStore

    get_bd().Database(name).new_activity(code="c1", name="p", unit="kilogram", type="process").save()
    TagStore().add(name, "c1", "phase", "Production")
    ChatStore().create_chat(name, "hello")
    parameter_groups.create(name, "Masses")
    ScenarioStore().create(name, "High demand")
    StudyMetaStore().update(name, {"goal": "registry guard"})
    ReportStore().create(name, name="Guard report")
    ResearchLogStore().record(name, [{"question": "q?", "findings": [{"text": "f", "sources": []}]}])
    ReviewLogStore().record_review(name, "looks fine")
    ViewStore().put(name, {"layout": {"c1": [0, 0]}})
    folder = model_folders.create(f"Folder of {name}")
    model_folders.assign(name, folder["id"])

    seeded = {
        "tags": lambda db: bool(TagStore().list_for(db, "c1")),
        "chats": lambda db: bool(ChatStore().list_chats(db)),
        "parameter_groups": lambda db: bool(parameter_groups.list_groups(db)),
        "scenarios": lambda db: bool(ScenarioStore().list_all(db)),
        "study": lambda db: bool(StudyMetaStore().get(db)),
        "reports": lambda db: bool(ReportStore().list_reports(db)),
        "research_log": lambda db: bool(ResearchLogStore().list(db)),
        "review_log": lambda db: bool(ReviewLogStore().list(db)),
        "views": lambda db: bool(ViewStore().get(db)),
        "model_folders": lambda db: db in model_folders.state()["of"],
    }
    assert set(seeded) == {s.name for s in per_model_stores()}, (
        "a store joined (or left) the registry — seed it here so the cascade walk covers it"
    )
    for store, has in seeded.items():
        assert has(name), f"seeding failed for {store}"
    return seeded


class TestPerModelRegistry:
    def test_cascade_covers_every_registered_store(self, project):
        """Seed every registry store, rename through the REAL repository cascade, then delete —
        nothing may strand under the old name, survive the delete, or resurrect under a re-created
        model of the same name."""
        from prism_lca.engine.brightway_repository import BrightwayRepository

        repo = BrightwayRepository()
        old, new = "registry-model", "registry-model-renamed"
        repo.create_foreground_database(old)
        seeded = _seed_every_store(old)

        repo.rename_foreground_database(old, new)
        for name, has in seeded.items():
            assert has(new), f"{name} did not follow the rename"
            assert not has(old), f"{name} stranded under the dead old name"

        repo.delete_foreground_database(new)
        for name, has in seeded.items():
            assert not has(new), f"{name} survived the delete"
        repo.create_foreground_database(new)
        for name, has in seeded.items():
            assert not has(new), f"{name} resurrected on a re-created model of the same name"

    @pytest.mark.parametrize("back_as", ["aside-model", "aside-model (2)"])
    def test_every_registered_store_is_set_aside_and_put_back(self, project, back_as):
        """What a deletion that can be taken back keeps: every registered store's share, read before the
        delete and put back after it — under the old name, or another one when the old one was taken."""
        from prism_lca.engine import model_aside
        from prism_lca.engine.bootstrap import get_bd
        from prism_lca.engine.brightway_repository import BrightwayRepository

        repo = BrightwayRepository()
        name = "aside-model"
        repo.create_foreground_database(name)
        seeded = _seed_every_store(name)

        aside = model_aside.set_aside(name)
        repo.delete_foreground_database(name)
        for store, has in seeded.items():
            assert not has(name), f"{store} survived the delete"

        repo.create_foreground_database(back_as)
        get_bd().Database(back_as).new_activity(code="c1", name="p", unit="kilogram", type="process").save()
        assert model_aside.put_back(aside, back_as)
        for store, has in seeded.items():
            assert has(back_as), f"{store} was not put back"
        if back_as != name:
            for store, has in seeded.items():
                assert not has(name), f"{store} came back under the old name"

    def test_every_per_model_store_module_is_registered(self):
        """Static guard: a module under engine/ that defines a per-model lifecycle move
        (``rename_database``) must appear in the registry — this is the test that fails when the
        NEXT store is written and the cascade is forgotten."""
        engine = Path(__file__).resolve().parents[1] / "src" / "prism_lca" / "engine"
        offering: set[str] = set()
        for path in engine.glob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef) and node.name == "rename_database":
                    offering.add(path.stem)
        # params is bw2data-backed and stays an explicit cascade step (ordering constraints around
        # Brightway's own rename); everything else with a rename_database must be in the registry.
        offering.discard("params")
        registered_modules = {
            "tags", "chat_store", "parameter_groups", "scenarios", "study",
            "report_store", "research_log", "review_log", "view_store", "model_folders",
        }
        assert {s.name for s in per_model_stores()} == {
            "tags", "chats", "parameter_groups", "scenarios", "study",
            "reports", "research_log", "review_log", "views", "model_folders",
        }
        assert offering == registered_modules, (
            f"store modules with rename_database {sorted(offering)} != registered {sorted(registered_modules)} "
            "— register the new store in per_model_stores() (and seed it in the cascade test above)"
        )
