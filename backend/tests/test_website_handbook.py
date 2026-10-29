"""The handbook is built from Website2/content/handbook/ and must not drift from it.

Tripwire for ``Website2/tools/build_handbook.py``: editing a page, nav.json, a screenshot or the site's navigation
without re-running the builder fails here, and so does a source the builder would refuse. Offline; skips without
Website2/.
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
from pathlib import Path

import pytest

_BUILDER = Path(__file__).resolve().parent.parent.parent / "Website2" / "tools" / "build_handbook.py"


@pytest.fixture(scope="module")
def handbook():
    if not _BUILDER.exists():
        pytest.skip("no Website2/ in this checkout")
    spec = importlib.util.spec_from_file_location("build_handbook", _BUILDER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def outputs(handbook):
    return handbook.build()


def test_pages_are_current(outputs):
    stale = [os.path.basename(p) for p, text in outputs.items()
             if not os.path.exists(p) or Path(p).read_text(encoding="utf-8") != text]
    assert not stale, f"handbook pages are stale: {stale} — run: python3 Website2/tools/build_handbook.py"


def test_no_orphan_pages(handbook, outputs):
    built = {p for p in outputs if p.endswith(".html")}
    present = {os.path.join(handbook.OUT, f) for f in os.listdir(handbook.OUT) if f.endswith(".html")}
    assert not present - built, "pages no longer in nav.json — run the builder, it removes them"


def test_every_image_exists(handbook, outputs):
    for path, text in outputs.items():
        if not path.endswith(".html"):
            continue
        for src in re.findall(r'<img[^>]+src="([^"]+)"', text):
            assert (Path(handbook.OUT) / src).resolve().exists(), f"{os.path.basename(path)}: missing {src}"


def test_where_to_go_next_only_ends_a_section(handbook):
    """The cards block closes a section; inside one the Previous/Next buttons do that job."""
    sections, _ = handbook.load()
    for sec in sections:
        for page in sec["pages"][:-1]:
            raw = Path(page.path).read_text(encoding="utf-8")
            assert not re.search(r"<h2[^>]*>\s*Where to go next", raw), (
                f"{page.slug}.html: 'Where to go next' belongs on the last page of a section; use "
                '<p class="hb-seealso">See also: …</p> here'
            )
