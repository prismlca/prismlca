"""Website news, its RSS feed and the feed the app ships are built from one source and must not drift.

Tripwire for ``Website2/tools/build_news.py``: editing ``Website2/content/news.html`` (or the site's
navigation) without re-running the builder fails here, and so does a source the builder would refuse.
Offline: reads files only. Skips when the site folder is not part of this checkout.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parent.parent.parent
_BUILDER = _REPO / "Website2" / "tools" / "build_news.py"


@pytest.fixture(scope="module")
def news():
    if not _BUILDER.exists():
        pytest.skip("no Website2/ in this checkout")
    spec = importlib.util.spec_from_file_location("build_news", _BUILDER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_outputs_are_current(news):
    for path, text in news.build().items():
        assert Path(path).read_text(encoding="utf-8") == text, f"{path} is stale — run: python3 Website2/tools/build_news.py"


def test_source_rules(news, tmp_path):
    good = '<article data-slug="a-b" data-date="2026-10-01" data-tag="release"><h2>T</h2><p>x</p></article>'
    (tmp_path / "ok.html").write_text(good, encoding="utf-8")
    assert news.read_items(str(tmp_path / "ok.html"))[0]["teaser"] == "x"
    for bad in (good.replace('data-tag="release"', 'data-tag="misc"'),
                good.replace("<p>x</p>", '<p onclick="x()">x</p>'),
                good.replace("<p>x</p>", "<script>x</script>"),
                good + good):
        (tmp_path / "bad.html").write_text(bad, encoding="utf-8")
        with pytest.raises(news.NewsError):
            news.read_items(str(tmp_path / "bad.html"))


def test_app_link_shape(news):
    # The app's feed parser keeps only https links; the start page opens them in the browser.
    for item in news.read_items()[:10]:
        assert f"{news.BASE_URL}news.html#{item['slug']}".startswith("https://www.prismlca.com/news.html#")
