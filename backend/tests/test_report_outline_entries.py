"""A contents, figure or table list entry too long for one line.

Its second line goes on where its title starts, not under its number: a list is read down the title
column, and a line that runs back under "Table 4" reads as an entry of its own. Typst's own entries do
that; a theme that sets its entries itself has to ask for it.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest
import typst

from prism_lca.engine import report_palettes, typst_render

HEADING = "Contribution of the life-cycle stages to the climate change result per functional unit, by process group"
CAPTION = ("Characterised results of the three packaging variants for all impact categories of the EF 3.1 "
           "method set, per functional unit")

# Every word of a long title records where it was set, under the title's key. The title is set twice —
# in the list and in the text — and the list comes first. The marker shares a box with its word: on its
# own, Typst keeps an empty element at the end of the line a break follows, not at the start of the next.
DOCUMENT = f"""#import "template.typ": *
#let marked(key, words) = words.split(" ").map(w => box[#context [#metadata((key: key, page: here().page(),
  x: here().position().x.pt(), y: here().position().y.pt()))<word>]#w]).join([ ])
#show: lca-report-template.with(
  title: "Outline test", subtitle: "Long entries", author: "PrismLCA",
  meta: (("Author", "PrismLCA"), ("Date", "2026-01-01")), lang: "en",
)
#lca-outlines()
= Results
== #marked("heading", "{HEADING}")
#lca-table(("A", "B"), (("x", "1"),), caption: marked("caption", "{CAPTION}"))
"""


def _lines_in_the_list(template_id: str, key: str) -> list[list[float]]:
    """The x of each word of one title as the list sets it, line by line."""
    with tempfile.TemporaryDirectory(prefix="prism-outline-") as tmp:
        root = Path(tmp)
        (root / "template.typ").write_text(typst_render.builtin_template_source(template_id))
        (root / "palette.typ").write_text(report_palettes.palette_typst(None))
        (root / "main.typ").write_text(DOCUMENT)
        marks = json.loads(typst.query(str(root / "main.typ"), "<word>", field="value", root=str(root),
                                       font_paths=[str(typst_render.font_dir())], ignore_system_fonts=True))
    words = [m for m in marks if m["key"] == key]
    in_list = [m for m in words if m["page"] == min(w["page"] for w in words)]
    lines: dict[float, list[float]] = {}
    for m in in_list:
        lines.setdefault(round(m["y"], 1), []).append(m["x"])
    return [sorted(xs) for _, xs in sorted(lines.items())]


@pytest.mark.parametrize("template_id", sorted(typst_render.BUILTIN_TEMPLATES))
@pytest.mark.parametrize("key", ["heading", "caption"])
def test_a_title_that_wraps_goes_on_under_itself_not_under_its_number(template_id, key):
    lines = _lines_in_the_list(template_id, key)
    assert len(lines) >= 2, f"{template_id}: the {key} fits on one line here and proves nothing — lengthen it"
    first, second = lines[0][0], lines[1][0]
    assert second == pytest.approx(first, abs=0.5), (
        f"{template_id}: the {key}'s second line starts at {second:.1f} pt, its title at {first:.1f} pt")
