"""The bundle check's list of on-demand imports stays complete (prism_lca/bundle_check.py).

A third-party module imported inside a function is invisible to every start-up test of the packaged
backend; the bundle check imports it explicitly, but only if it is on ``LAZY_IMPORTS``.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

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
