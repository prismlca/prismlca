"""A table stays on one page with its caption and its column heads.

Every theme lets table figures break across pages, because an annex inventory has to. Left at that, a
twelve-row table near the foot of a page split after its head: caption and column heads on one page, the
rows on the next. A table that fits a page now moves on whole; only one taller than a page breaks, and then
its head repeats on every page it runs onto.

The test pushes the table down the page one paragraph at a time, so one of the positions puts it across a
page break — and it checks that one did, or a layout change could make the sweep test nothing.
"""
from __future__ import annotations

import io
import re

import pytest
from pdfminer.high_level import extract_text

from prism_lca.engine import report_model as rm
from prism_lca.engine import report_typst, typst_render

FILLER = "Filler sentence to push the next table toward the foot of the page. " * 6


def _pages(fill: int, theme: str) -> list[str]:
    blocks = [
        rm.heading("Results", 1),
        *[rm.prose(f"{FILLER} ({i})") for i in range(fill)],
        rm.heading("Per variant", 2),
        rm.table(
            ["Mhead", "Unit", "Value"],
            [[f"row{i}", "kg", f"{i}.0"] for i in range(12)],
            caption="Medium table",
            label="t-medium",
        ),
        rm.prose("See @t-medium."),
        rm.table(
            ["Lhead", "Unit", "Amount"],
            [[f"long{i}", "kg", str(i)] for i in range(70)],
            caption="Long table",
            label="t-long",
        ),
    ]
    files = report_typst.wrap_document(blocks, title="Test", template=theme, lang="en")
    return extract_text(io.BytesIO(typst_render.compile_pdf(files))).split("\f")


# The default theme, and the base file whose head used to be a plain first row.
@pytest.mark.parametrize("theme", ["template-network.typ", "template.typ"])
def test_a_table_that_fits_a_page_is_never_split(theme):
    source = typst_render.template_source(theme)
    moved = False
    for fill in range(4, 15):
        pages = _pages(fill, source)

        def on(pattern: str, pages: list[str] = pages) -> set[int]:
            return {i for i, page in enumerate(pages) if re.search(pattern, page)}

        rows, caption = on(r"\brow\d+\b"), on(r"Medium table")
        assert len(rows) == 1, (fill, sorted(rows))
        assert caption == rows, (fill, sorted(caption), sorted(rows))
        assert on(r"(?i)\bper variant\b") == caption, fill  # the heading above it goes along
        moved |= max(on(r"\(\d+\)")) < min(rows)  # the text ended a page earlier: the table moved whole

        long_rows = on(r"\blong\d+\b")
        assert len(long_rows) > 1, fill  # taller than a page, so it does break…
        assert all(re.search(r"(?i)\blhead\b", pages[i]) for i in long_rows), fill  # …with its head on each
    assert moved, "no position put the table at a page break — the sweep tested nothing"
