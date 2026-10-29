"""The app's privacy notice on the website is the notice the app ships, word for word.

Tripwire for ``scripts/website_privacy.py``: a change to PRIVACY.md, to the website part written in the
script, or to the site's navigation without re-running the script fails here. Offline: reads files only.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent
_SCRIPT = _ROOT / "scripts" / "website_privacy.py"


@pytest.fixture(scope="module")
def tool():
    spec = importlib.util.spec_from_file_location("website_privacy", _SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_app_part_keeps_every_paragraph(tool):
    # Every prose line of PRIVACY.md (minus the title) must reach the page; a renderer change that drops or
    # rewrites one is exactly what this page must never do.
    html = tool.app_notice_html()
    for line in tool.APP_NOTICE.read_text(encoding="utf-8").splitlines()[1:]:
        words = [w for w in line.replace("*", " ").replace("`", " ").split() if w.isalpha() and len(w) > 3]
        for word in words[:3]:
            assert word in html, (word, line)
    assert "<h1>" not in html and "<h3>Who is responsible</h3>" in html


def test_page_is_current(tool):
    page = tool.wl.SITE / "privacy.html"
    if not page.exists():
        pytest.skip(f"no site folder at {tool.wl.SITE} (set PRISM_SITE_DIR or run with --site)")
    for path, text in tool.build().items():
        assert path.read_text(encoding="utf-8") == text, (
            f"{path.name} is stale — run: cd backend && uv run python scripts/website_privacy.py"
        )


def test_statistics_paragraph_follows_the_consent_module(tool):
    """The notice describes statistics exactly when assets/consent.js has a website ID — the switch that also
    decides whether the consent bar and the tracker exist. The tool is not named."""
    if not (tool.wl.SITE / "assets" / "consent.js").exists():
        pytest.skip(f"no site folder at {tool.wl.SITE} (set PRISM_SITE_DIR or run with --site)")
    html = tool.website_part()
    if tool.stats_live():
        assert "§ 25(1) TDDDG" in html and "privacy-settings" in html
    else:
        assert "currently uses no visitor statistics" in html
    assert "{STATS" not in html and "{SHORT_" not in html
    assert "Umami" not in tool.STATS_ON["STATS"]
