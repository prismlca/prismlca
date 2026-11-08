"""The bundle check's list of on-demand imports stays complete (prism_lca/bundle_check.py).

A third-party module imported inside a function is invisible to every start-up test of the packaged
backend; the bundle check imports it explicitly, but only if it is on ``LAZY_IMPORTS``.
"""
from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

import pytest

from prism_lca import bundle_check

SRC = Path(__file__).resolve().parents[1] / "src" / "prism_lca"


def _function_level_imports() -> set[str]:
    found: set[str] = set()
    for path in SRC.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for func in ast.walk(tree):
            if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for node in ast.walk(func):
                if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                    found.add(node.module)
                elif isinstance(node, ast.Import):
                    found.update(alias.name for alias in node.names)
    return {
        name
        for name in found
        if name.split(".")[0] not in sys.stdlib_module_names and not name.startswith("prism_lca")
    }


def test_every_on_demand_import_is_on_the_list():
    missing = sorted(_function_level_imports() - set(bundle_check.LAZY_IMPORTS))
    assert not missing, (
        f"imported inside a function but not on bundle_check.LAZY_IMPORTS: {missing} — add them, so the "
        "packaged backend proves it can import them before a user needs them"
    )


def test_everything_imports_here(capsys):
    assert bundle_check.run() == 0, capsys.readouterr().out


def test_the_typesetting_probe_reports_a_worker_that_fails(monkeypatch):
    from prism_lca.engine import typst_render
    from prism_lca.errors import PrismError

    assert bundle_check._typesetting_failures() == []

    def stopped(*_args, **_kwargs):
        raise PrismError("The typesetting process stopped unexpectedly (exit code 3).", code="typst_worker_failed")

    monkeypatch.setattr(typst_render, "compile_pdf", stopped)
    with pytest.raises(PrismError):
        bundle_check._typesetting_failures()
    monkeypatch.setattr(bundle_check, "_worker_failures", lambda: [])
    monkeypatch.setattr(bundle_check, "_conversion_failures", lambda: [])
    monkeypatch.setenv("BRIGHTWAY2_DIR", os.environ.get("BRIGHTWAY2_DIR", ""))  # run() sets its own
    assert bundle_check.run() == 1


def test_the_pdf_probe_reports_a_reader_that_fails(monkeypatch):
    from prism_lca.engine import attachment_pdf
    from prism_lca.errors import PrismError

    assert bundle_check._pdf_failures() == []

    def stopped(*_args, **_kwargs):
        raise PrismError("The process reading this PDF stopped unexpectedly (exit code 3).")

    monkeypatch.setattr(attachment_pdf, "text", stopped)
    with pytest.raises(PrismError):
        bundle_check._pdf_failures()
    monkeypatch.setattr(attachment_pdf, "text", lambda *_args: ("", False))
    monkeypatch.setattr(attachment_pdf, "page_count", lambda _path: None)
    assert bundle_check._pdf_failures() == [
        "pdf: the marker is missing from the text",
        "pdf: counted None pages, expected 1",
    ]
    monkeypatch.setattr(bundle_check, "_worker_failures", lambda: [])
    monkeypatch.setattr(bundle_check, "_conversion_failures", lambda: [])
    monkeypatch.setattr(bundle_check, "_typesetting_failures", lambda: [])
    monkeypatch.setenv("BRIGHTWAY2_DIR", os.environ.get("BRIGHTWAY2_DIR", ""))  # run() sets its own
    assert bundle_check.run() == 1


def test_the_calculation_probe_computes_the_known_score_and_leaves_no_project_behind():
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    before, projects = bd.projects.current, set(bd.projects)
    assert bundle_check._calculation_failures() == []
    assert bd.projects.current == before
    assert set(bd.projects) == projects


def test_the_calculation_probe_reports_a_wrong_score(monkeypatch):
    from prism_lca.engine import lca
    from prism_lca.engine.bootstrap import get_bd

    monkeypatch.setattr(lca, "compute_lcia", lambda *_a, **_k: {"score": 1.0, "direct": 0.1})
    assert bundle_check._calculation_failures() == [
        "calculation: score 1.0, direct 0.1; expected 1.1, 0.1"
    ]
    before = get_bd().projects.current

    def broken(*_a, **_k):
        raise RuntimeError("no solver")

    monkeypatch.setattr(lca, "compute_lcia", broken)
    with pytest.raises(RuntimeError):
        bundle_check._calculation_failures()
    assert get_bd().projects.current == before


@pytest.mark.skipif(not Path("/proc/self/fd").is_dir(), reason="reads the process's open files from /proc")
def test_the_calculation_probe_closes_the_project_files_before_deleting_them(monkeypatch):
    """Windows refuses to delete an open file; /proc shows here what would still be open there."""
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    real, still_open = bd.projects.delete_project, []

    def watched(name, delete_dir=False):
        for fd in Path("/proc/self/fd").iterdir():
            try:
                target = os.readlink(fd)
            except OSError:
                continue
            if "prism-bundle-check-" in target:
                still_open.append(target)
        return real(name, delete_dir=delete_dir)

    monkeypatch.setattr(bd.projects, "delete_project", watched)
    assert bundle_check._calculation_failures() == []
    assert still_open == []
