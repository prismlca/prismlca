"""THIRD-PARTY-NOTICES.md is generated, current, and passes the licence policy.

This is a tripwire: a dependency change (uv.lock, package-lock.json, a bundled font or notice)
without re-running ``uv run python scripts/third_party_notices.py`` fails here. Offline: the
generator reads only the installed packages, ``node_modules`` and checked-in texts.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
_SCRIPT = _ROOT / "scripts" / "third_party_notices.py"


def _load():
    spec = importlib.util.spec_from_file_location("third_party_notices", _SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # @dataclass resolves annotations through sys.modules
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def tool():
    return _load()


@pytest.fixture(scope="module")
def generated(tool):
    """One generation per module: the npm ls call is the slow part."""
    text, failures, python, npm = tool.generate()
    return {"text": text, "failures": failures, "python": python, "npm": npm}


def test_committed_files_are_current(tool, generated):
    fresh = tool.comparable(generated["text"])
    for path in tool.OUTPUTS:
        assert path.exists(), f"{path} missing — run scripts/third_party_notices.py"
        committed = tool.comparable(path.read_text(encoding="utf-8"))
        assert committed == fresh, (
            f"{path.relative_to(tool.REPO)} is stale — run "
            "`cd backend && uv run python scripts/third_party_notices.py`"
        )


def test_required_texts_present(tool, generated):
    text = generated["text"]
    intel = importlib.metadata.distribution("onemkl-license")
    licence = next(f for f in intel.files if f.name == "LICENSE.txt")
    assert tool.normalize_text(Path(str(intel.locate_file(licence))).read_bytes()) in text
    assert tool.read_text(tool.TEXTS / "feather-LICENSE.txt") in text
    assert tool.read_text(tool.TEXTS / "lucide-LICENSE.txt") in text
    assert tool.read_text(tool.TEXTS / "lobehub-icons-LICENSE.txt") in text
    assert "EUPL-1.2" in text and "### searoute shipping-lane network" in text
    assert tool.read_text(tool.TEXTS / "EUPL-1.2.txt") in text
    for family in (p for p in tool.FONTS_DIR.iterdir() if p.is_dir()):
        assert f"### {family.name} — " in text, family.name
    for _, revision, _, _ in tool.MODELS:
        assert revision in text
    assert "5617a9f61b028005a4858fdac845db406aefb181" in text
    assert "3d7cfbdacd47fdda877c5cd8a79fbcc4f2a574f3" in text


def test_policy_passes(tool, generated):
    assert generated["failures"] == []
    names = {p.name for p in generated["python"]}
    for build_only in tool.BUILD_ONLY:
        assert build_only not in names
    assert generated["npm"], "npm inventory is empty"
