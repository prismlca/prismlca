"""The licence the app shows and the licence the website shows are the same text.

Tripwire for ``scripts/website_licences.py``: a change to LICENSE, to THIRD-PARTY-NOTICES.md (after a
dependency change), to the sheet sentences in frontend/src/shared/licence.ts or to the site's navigation
without re-running the script fails here. Offline and fast: it only reads checked-in files.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
_SCRIPT = _ROOT / "scripts" / "website_licences.py"


@pytest.fixture(scope="module")
def tool():
    spec = importlib.util.spec_from_file_location("website_licences", _SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_app_ships_the_repo_licence(tool):
    # The app opens resources/LICENSE.txt; it must be LICENSE, byte for byte.
    assert tool.APP_LICENSE.read_bytes() == tool.LICENSE.read_bytes()


def test_shared_sentences_are_readable(tool):
    # The generator reads the app's sheet sentences from shared/licence.ts; a reformatting that hides
    # them (template string, concatenation) must fail loudly, not drop a sentence from the site.
    constants = tool.shared_constants()
    assert constants["LICENCE_LABEL"] == "AGPL-3.0"
    assert constants["LICENCE_BLURB"].startswith("PrismLCA is free software")


def test_summary_cut_matches_the_app():
    # Same contract as summarySection() in frontend/src/main/licence.ts.
    spec = importlib.util.spec_from_file_location("website_licences_cut", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    md = "# T\n\nintro\n\n## Summary\n\n### A\n\n| x |\n|---|\n| 1 |\n\n## Python packages\nlong"
    assert module.summary_section(md) == "## Summary\n\n### A\n\n| x |\n|---|\n| 1 |"
    assert module.summary_section("no summary here") == ""


def test_website_licence_page_is_current(tool):
    if not tool.SITE.exists():
        # Not silent by intent: once the site lives in its own repository, this check moves to that
        # repository's deploy step (website_licences.py --check --site <checkout>).
        pytest.skip(f"no site folder at {tool.SITE}; set PRISM_SITE_DIR to the site checkout to check it")
    stale = [str(p) for p, text in tool.build().items()
             if not p.exists() or p.read_text(encoding="utf-8") != text]
    assert not stale, f"stale: {stale} — run: cd backend && uv run python scripts/website_licences.py"
