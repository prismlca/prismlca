"""The features page is built from Website2/content/features.html and must not drift from it.

Tripwire for ``Website2/tools/build_features.py``: editing the source (or the site's navigation) without
re-running the builder fails here, and so does a source the builder would refuse. Offline; skips without
Website2/.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_BUILDER = Path(__file__).resolve().parent.parent.parent / "Website2" / "tools" / "build_features.py"


@pytest.fixture(scope="module")
def features():
    if not _BUILDER.exists():
        pytest.skip("no Website2/ in this checkout")
    spec = importlib.util.spec_from_file_location("build_features", _BUILDER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_page_is_current(features):
    assert Path(features.OUT).read_text(encoding="utf-8") == features.build(), (
        "features.html is stale — run: python3 Website2/tools/build_features.py"
    )


def test_categories(features):
    cats = features.read_categories()
    assert [c["name"] for c in cats] == ["General", "AI Assistant", "Modelling", "Results", "Report writer", "Data",
                                         "MCP", "Control and privacy"]
    assert all(c["icon"] in features.ICONS and c["tone"] in features.TONES for c in cats)


def test_source_rules(features, tmp_path):
    good = ('<section data-id="c" data-icon="info" data-tone="navy"><h2>C</h2><p>Line.</p>'
            '<div class="spot" data-id="s" data-shot="A canvas"><h3>S</h3><p>Text.</p><ul><li>One</li></ul></div>'
            '<div class="item" data-id="i"><h3>I</h3><p>Text.</p></div></section>')
    (tmp_path / "ok.html").write_text(good, encoding="utf-8")
    cat = features.read_categories(str(tmp_path / "ok.html"))[0]
    assert cat["spots"][0]["bullets"] == ["One"] and cat["items"][0]["title"] == "I"
    for bad in (good.replace('data-icon="info"', 'data-icon="rocket"'),
                good.replace('data-tone="navy"', 'data-tone="pink"'),
                good.replace(' data-shot="A canvas"', ""),
                good.replace('data-shot="A canvas"', 'data-shot="A canvas" data-img="assets/shots/nope.webp"'),
                good.replace("<p>Text.</p></div></section>", '<p style="color:red">Text.</p></div></section>'),
                good.replace('data-id="i"', 'data-id="s"'),
                good.replace("<p>Line.</p>", "")):
        (tmp_path / "bad.html").write_text(bad, encoding="utf-8")
        with pytest.raises(features.news.NewsError):
            features.read_categories(str(tmp_path / "bad.html"))


def test_webp_size_reads_the_site_screenshots(features):
    shot = Path(features.SITE) / "assets" / "shots" / "ask-card-hover.webp"
    if not shot.exists():
        pytest.skip("screenshot not in this checkout")
    assert features.webp_size(str(shot)) == (782, 1176)


def test_theme_swap_rules(features, tmp_path):
    sec = ('<section data-id="c" data-icon="info" data-tone="navy"><h2>C</h2><p>Line.</p>'
           '<div class="item" data-id="i"><h3>I</h3><p>Text.</p></div></section>')
    fig = ('<figure class="theme-swap" data-id="t" data-bar="PrismLCA" data-light="assets/shots/theme-light.webp" '
           'data-dark="assets/shots/theme-dark.webp"><h2>Light or dark</h2><p>Text.</p></figure>')
    if not (Path(features.SITE) / "assets" / "shots" / "theme-light.webp").exists():
        pytest.skip("screenshots not in this checkout")
    (tmp_path / "ok.html").write_text(sec + fig, encoding="utf-8")
    after = features.read_categories(str(tmp_path / "ok.html"))[0]["after"]
    assert after[0]["light"][1] == after[0]["dark"][1]
    for bad in (fig + sec,  # a swap must follow a category
                sec + fig.replace("theme-dark.webp", "nope.webp"),
                sec + fig.replace(' data-bar="PrismLCA"', "")):
        (tmp_path / "bad.html").write_text(bad, encoding="utf-8")
        with pytest.raises(features.news.NewsError):
            features.read_categories(str(tmp_path / "bad.html"))


def test_feature_demos(features, tmp_path):
    """Every demo is used on the page and gets what it needs."""
    cats, stats = features.read_page()
    assert any(s["count"] == "features" for s in stats)
    demos = {s["demo"] for c in cats for s in c["spots"] if s["demo"]}
    assert demos == set(features.DEMOS)

    if not (Path(features.SITE) / "assets" / "shots" / "canvas-calc-before.webp").exists():
        pytest.skip("screenshots not in this checkout")
    head = '<section data-id="c" data-icon="info" data-tone="navy"><h2>C</h2><p>Line.</p>'
    calc = ('<div class="spot" data-id="s" data-shot="A canvas" data-demo="calc" '
            'data-img="assets/shots/canvas-calc-before.webp" data-img2="assets/shots/canvas-calc-after.webp" '
            'data-total="1 kg"><h3>S</h3><p>Text.</p></div>')
    item = '<div class="item" data-id="i"><h3>I</h3><p>Text.</p></div></section>'
    (tmp_path / "ok.html").write_text(head + calc + item, encoding="utf-8")
    assert "fd-calc" in features.build(str(tmp_path / "ok.html"))
    for bad in (head + calc.replace(' data-total="1 kg"', "") + item,):  # calc without its result line
        (tmp_path / "bad.html").write_text(bad, encoding="utf-8")
        with pytest.raises(features.news.NewsError):
            features.read_page(str(tmp_path / "bad.html"))
    steps = calc.replace('data-demo="calc"', 'data-demo="steps" data-imgs="assets/shots/canvas-calc-before.webp|One"')
    (tmp_path / "bad.html").write_text(head + steps + item, encoding="utf-8")
    with pytest.raises(features.news.NewsError):  # a step demo needs at least two pictures
        features.read_page(str(tmp_path / "bad.html"))
