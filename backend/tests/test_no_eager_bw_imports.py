"""Guard against the class of bug where a module imports Brightway at top level.

bw2data reads BRIGHTWAY2_DIR at import time. If any module does a module-level
`import bw2data`/`bw2io`/… it forces bw2data to initialise before bootstrap sets the app data
dir, so the whole backend silently runs on bw2data's default ~/.local/share/Brightway3 instead
of the app project directory (the "search not indexed / ecoinvent invisible" incident). All
Brightway access must go through the lazy accessors in bootstrap.py.

conftest sets BRIGHTWAY2_DIR before importing the app, so this never surfaces at runtime in the
test suite — hence this static AST check.
"""
from __future__ import annotations

import ast
from pathlib import Path

_PKG = Path(__file__).resolve().parents[1] / "src" / "prism_lca"
_FORBIDDEN = {"bw2data", "bw2io", "bw2calc", "bw2analyzer", "bw_processing", "matrix_utils"}
_ALLOWED_FILES = {"bootstrap.py"}  # the one place that owns Brightway init


def _module_level_bw_imports(tree: ast.Module) -> list[str]:
    hits: list[str] = []
    for node in tree.body:  # module level only — imports inside functions are lazy and fine
        if isinstance(node, ast.Import):
            hits += [n.name for n in node.names if n.name.split(".")[0] in _FORBIDDEN]
        elif isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] in _FORBIDDEN:
            hits.append(node.module)
    return hits


def test_no_top_level_brightway_imports():
    offenders: dict[str, list[str]] = {}
    for path in _PKG.rglob("*.py"):
        if path.name in _ALLOWED_FILES:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        hits = _module_level_bw_imports(tree)
        if hits:
            offenders[str(path.relative_to(_PKG))] = hits
    assert not offenders, (
        "Module-level Brightway imports break the data-dir bootstrap — use get_bd()/get_bi(): "
        f"{offenders}"
    )
