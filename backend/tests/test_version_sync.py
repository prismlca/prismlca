"""One version for the whole app: the shell refuses to start when the
frontend and the backend disagree, so the two files that carry it must never drift. The release
script (frontend/scripts/release/) sets both; this catches a hand edit that sets only one."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_frontend_and_backend_carry_the_same_version():
    frontend = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))["version"]
    pyproject = (ROOT / "backend" / "pyproject.toml").read_text(encoding="utf-8")
    backend = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE).group(1)
    assert frontend == backend


def test_the_source_fallback_reads_pyproject_rather_than_a_copy():
    from prism_lca import _version_from_pyproject

    pyproject = (ROOT / "backend" / "pyproject.toml").read_text(encoding="utf-8")
    assert _version_from_pyproject() == re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE).group(1)
