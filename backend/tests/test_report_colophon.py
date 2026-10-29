"""The colophon links to the website in the surrounding colour and carries no caveat text."""

from __future__ import annotations

import pytest

from prism_lca.engine import report_typst as rt

LANGS = ["en", "de", "fr", "es", "pt"]


@pytest.mark.parametrize("lang", LANGS)
def test_colophon_links_the_website_and_has_no_caveat(lang):
    text = rt.colophon("0.8.0", "2026-10-25 UTC", lang)
    assert '#link("https://prismlca.com")[#underline[prismlca.com]]' in text
    assert "ISO" not in text and "14044" not in text
    assert "{link}" not in text and "colophon." not in text
    # No colour is set on the link: it keeps the colophon's own fill.
    assert text.count("fill:") == 1  # the text fill only; the link adds none
