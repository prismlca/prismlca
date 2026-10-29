"""The FAQ page is built from Website2/content/faq.html and must not drift from it.

Tripwire for ``Website2/tools/build_faq.py``: editing the source (or the site's navigation) without re-running
the builder fails here, and so does a source the builder would refuse. Offline; skips without Website2/.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_BUILDER = Path(__file__).resolve().parent.parent.parent / "Website2" / "tools" / "build_faq.py"


@pytest.fixture(scope="module")
def faq():
    if not _BUILDER.exists():
        pytest.skip("no Website2/ in this checkout")
    spec = importlib.util.spec_from_file_location("build_faq", _BUILDER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_page_is_current(faq):
    assert Path(faq.OUT).read_text(encoding="utf-8") == faq.page(faq.read_categories()), (
        "faq.html is stale — run: python3 Website2/tools/build_faq.py"
    )


def test_every_category_has_an_app_icon(faq):
    cats = faq.read_categories()
    assert [c["name"] for c in cats] == ["General", "AI Assistant", "AI Report", "Modelling", "Results", "Installation", "MCP"]
    assert all(c["icon"] in faq.ICONS and c["qas"] for c in cats)


def test_source_rules(faq, tmp_path):
    good = ('<section data-id="c" data-icon="info"><h2>C</h2>'
            '<div class="qa" data-id="q"><h3>Q?</h3><p>A.</p></div></section>')
    (tmp_path / "ok.html").write_text(good, encoding="utf-8")
    assert faq.read_categories(str(tmp_path / "ok.html"))[0]["qas"][0]["question"] == "Q?"
    for bad in (good.replace('data-icon="info"', 'data-icon="rocket"'),
                good.replace("<p>A.</p>", '<p style="color:red">A.</p>'),
                good.replace('data-id="q"', 'data-id="c"'),
                good.replace("<p>A.</p>", "")):
        (tmp_path / "bad.html").write_text(bad, encoding="utf-8")
        with pytest.raises(faq.news.NewsError):
            faq.read_categories(str(tmp_path / "bad.html"))
