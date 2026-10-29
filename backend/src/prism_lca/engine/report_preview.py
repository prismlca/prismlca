"""Theme previews: a theme's cover page, typeset with sample data, for the picker.

A theme is the whole look of a document, and its label can only hint at that. "Curved band" and "Shapes
and card" are two very different pages, and the only honest way to choose between them is to look at them —
so every theme carries a rendered cover, in the colour set the report is typeset in.

Rendered on demand and cached by the *hash of the template source*, rather than shipped as image files:
a committed PNG goes stale the moment someone edits a cover, and a stale preview is worse than none. The
cache is in memory, because a preview costs one Typst compile of a single page (~0.3 s) and there are
five of them.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict

from prism_lca.engine import report_palettes, typst_render
from prism_lca.engine import report_typst as rt

#: Enough themes for the gallery plus a project's own, in a few colour sets: an entry is a few tens of kB,
#: and since a palette is part of the key, switching between two of them must not evict the one you came
#: from — clicking back and forth through the sets is exactly how a set gets chosen.
_CACHE: OrderedDict[str, bytes] = OrderedDict()
_CACHE_MAX = 72

#: 72 ppi puts A4 at 595×842 px, the classic A4-at-72dpi raster. Shown at ~130 px wide, so it is downsampled
#: four-fold — which is the point: at 48 ppi the hatched circle's 0.8 pt rules and the soft edge where the
#: green overprints the navy aliased badly enough that a round shape stopped looking round. Downsampling a
#: bigger raster removes that; rendering closer to the display size cannot.
#:
#: The rounding is also smaller here. A4 at 48 ppi is 396.85 px wide, which the rasteriser rounds to 397 —
#: a 0.08 % horizontal stretch. At 72 ppi it is 595.28 → 595, a 0.05 % squeeze. Both are invisible, but the
#: CSS used to add its own 0.25 % on top by fixing *both* dimensions; it now sets the height only.
PREVIEW_PPI = 72

#: What the sample cover says. A plausible study rather than "Lorem ipsum", but a *short* one: these covers
#: are drawn for a heading of two lines, and at thumbnail size a five-line title is a grey block that says
#: nothing about the theme — which is the one job the preview has. The details go in as a study snapshot, so
#: the assembler labels them itself and the preview cannot drift from what a real cover prints.
SAMPLE_TITLE = "Apple juice, 1 L glass bottle"
SAMPLE_SUBTITLE = "Cradle-to-grave, Germany, 2026"
SAMPLE_STUDY = {
    "author": "Jane Doe",
    "organisation": "Doe Consulting",
    "commissioner": "Example Beverages Ltd",
    "date": "2026-07-29",
}


def preview_png(
    source: str | None, *, ppi: int = PREVIEW_PPI, palette: str | None = None,
    palette_colors: dict | None = None,
) -> bytes:
    """The first page of a document typeset with this theme, as PNG.

    `source` is a full `template.typ`; `None` means the shipped default file, which is what the store
    returns for the theme named "default".

    **No mark of any kind** — a preview is of the theme, not of whoever happens to have configured this
    installation. Nothing has to be switched off for that any more: a logo is printed only when one is
    given. The shipped photograph *is* passed, because the themes that place one are chosen for that band
    and look unfinished without it.
    """
    body = source if source is not None else typst_render.default_template_source()
    # The sample content is part of the key, not only the template: editing the sample text has to show up
    # in the picker, and hashing the template alone kept serving the old picture until a restart. The
    # palette belongs in it for the same reason — the gallery shows every theme in the report's colours, so
    # switching the colour set has to repaint eleven tiles rather than serve eleven cached ones.
    fingerprint = "\x00".join(
        [
            body, SAMPLE_TITLE, SAMPLE_SUBTITLE, repr(sorted(SAMPLE_STUDY.items())),
            report_palettes.resolve(palette)["id"],
            # And colours picked by hand, which are the one part of "the report's colours" that is not in
            # the set's id: without them the gallery served the tiles of the set while the document was
            # already being typeset in something else.
            repr(sorted((palette_colors or {}).items())),
        ]
    )
    key = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest() + f":{ppi}"
    hit = _CACHE.get(key)
    if hit is not None:
        _CACHE.move_to_end(key)
        return hit

    sources = rt.wrap_document(
        [
            {"type": "heading", "level": 1, "text": "Goal and scope definition"},
            {
                "type": "prose",
                "text": (
                    "The functional unit is one litre of cloudy apple juice in a 1 L glass bottle at "
                    "retail, including the bottle, its closure and the label."
                ),
            },
        ],
        title=SAMPLE_TITLE,
        subtitle=SAMPLE_SUBTITLE,
        study=SAMPLE_STUDY,
        lang="en",
        template=body,
        palette=palette,
        palette_colors=palette_colors,
        cover_image=typst_render.default_cover_bytes(),
        generated="2026-07-29 09:00 UTC",
    )
    png, _ = typst_render.compile_png(sources, page=1, ppi=ppi)
    _CACHE[key] = png
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)
    return png
