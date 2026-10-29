"""The videos page loads nothing from YouTube before a click, and the privacy notice says what happens after it.

Tripwire for ``Website2/tools/build_videos.py``: a stale page fails here, and so does anything that would contact
Google on page load (a YouTube thumbnail URL, an iframe in the HTML) or a CSP/notice that no longer matches the
player in ``assets/videos.js``. Offline; skips without Website2/.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

_SITE = Path(__file__).resolve().parent.parent.parent / "Website2"


@pytest.fixture(scope="module")
def site() -> Path:
    if not (_SITE / "tools" / "build_videos.py").exists():
        pytest.skip("no Website2/ in this checkout")
    return _SITE


def test_page_is_current(site):
    r = subprocess.run([sys.executable, str(site / "tools" / "build_videos.py"), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr or r.stdout


@pytest.mark.parametrize("name", ["videos.html", "index.html"])
def test_nothing_from_youtube_before_the_click(site, name):
    # index.html carries the product tour with the same player (assets/videos.js).
    page = (site / name).read_text(encoding="utf-8")
    assert "<iframe" not in page
    assert not re.search(r'(src|srcset|poster)="[^"]*(ytimg|youtube|googlevideo)', page)
    for m in re.finditer(r'(?:src|srcset)="([^"]+)"', page):
        for url in m.group(1).split(","):
            url = url.strip().split(" ")[0]
            assert not url.startswith(("http:", "https:", "//")), f"foreign resource on {name}: {url}"
            if url.startswith("assets/videos/"):
                assert (site / url).exists(), f"missing preview image {url}"


def test_start_page_player_matches_the_videos_page(site):
    # The consent step is the same text on both pages: index.html carries a copy of the player dialog, and a
    # changed notice on one page without the other would ask for consent with different words.
    def dialog(name):
        page = (site / name).read_text(encoding="utf-8")
        return page[page.index("<!-- The player opens here"):page.index("</dialog>") + len("</dialog>")]
    assert dialog("index.html") == dialog("videos.html")
    index = (site / "index.html").read_text(encoding="utf-8")
    assert 'href="assets/videos.css"' in index and 'src="assets/videos.js"' in index
    privacy = (site / "privacy.html").read_text(encoding="utf-8")
    assert 'href="index.html#tour"' in privacy and 'id="tour"' in index


def test_player_csp_and_notice_agree(site):
    js = (site / "assets" / "videos.js").read_text(encoding="utf-8")
    csp = (site / "server" / "contact" / "Caddyfile.snippet").read_text(encoding="utf-8")
    privacy = (site / "privacy.html").read_text(encoding="utf-8")
    assert "https://www.youtube-nocookie.com/embed/" in js
    assert "frame-src https://www.youtube-nocookie.com;" in csp
    # YouTube's player needs a Referer; a stricter policy breaks it (error 153).
    assert "Referrer-Policy strict-origin-when-cross-origin" in csp
    assert 'id="videos"' in privacy and "www.youtube-nocookie.com" in privacy and "Google Ireland Limited" in privacy


def test_no_page_links_into_an_archive_folder(site):
    # Folders starting with "_" (e.g. assets/videos/_archiv-ohne-bildmodell/) are archives and are not uploaded
    # (DEPLOY.md section 1); a page that pointed into one would show a broken image on the live site.
    pages = [p for p in site.rglob("*.html") if not any(part.startswith("_") for part in p.parts)]
    for p in pages:
        text = p.read_text(encoding="utf-8")
        assert not re.search(r'(?:src|srcset|href)="(?:[^"]*[/ ,])?_[^/"]+/', text), f"{p.name} links into an archive folder"
