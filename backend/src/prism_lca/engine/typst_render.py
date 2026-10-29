"""Typesetting: turn Typst sources into a PDF.

Why Typst rather than printing HTML from the embedded browser: a PDF is an endpoint, a ``.typ`` file
is a working state. The report can be handed over as sources the user keeps editing, and customers can
bring their own template.

The compiler arrives as a **self-contained wheel** (the ``typst`` package: a compiled extension with no
dependencies, wheels for Windows, macOS and Linux) — no CLI binary to vendor, no ``subprocess``.

Output is deterministic across machines: ``ignore_system_fonts=True`` means only our bundled fonts
(``assets/fonts``, see the NOTICE there) plus the families the compiler embeds itself are available.
Without that flag the same report would silently pick up whatever the machine happens to have
installed and look different on the next one.
"""
from __future__ import annotations

import hashlib
import re
import tempfile
from collections import OrderedDict
from pathlib import Path

import typst

from prism_lca.errors import PrismError

_ASSETS = Path(__file__).resolve().parent.parent / "assets"

#: Families the Typst wheel embeds — usable without shipping any file.
EMBEDDED_FONTS = ("Libertinus Serif", "New Computer Modern", "DejaVu Sans Mono")


def assets_dir() -> Path:
    return _ASSETS


def font_dir() -> Path:
    return _ASSETS / "fonts"


#: The typesetting templates that ship with the app: id -> (file, label).
#:
#: They differ ONLY in their cover page. The id `default` is kept for every report already stored against
#: it; only its label says what it is. Two of them place a picture you upload and one brings its own
#: composition, so the choice is between "my photograph" and "no photograph", not between two half-designs.
#:
#: A template cannot import a shared base (the contract materialises exactly one `template.typ` into the
#: project), so each of these is a copy of `template.typ` with a different cover. A change to the
#: document *body* has to be made in all of them.
#: ``cover_image`` says whether the template has somewhere to put an uploaded picture, ``client_logo``
#: whether it draws the commissioning party's mark. The UI reads both rather than knowing the ids, so a
#: template that starts or stops placing either needs no change there — it says "not used by this
#: template" beside the control instead of accepting an upload that then goes nowhere.
#: Themes that shipped once and have been removed. A stored report pointing at one falls back to the current
#: default instead of failing to render: the report was written against numbers and chapters, not against a
#: cover, and a 404 on a document nobody touched is the wrong way to retire a design.
RETIRED_TEMPLATES = frozenset({
    "prism-editorial",
    "prism-editorial-card",
    # The two picture covers, retired. `default` is here rather than deleted for the usual
    # reason *and* one of its own: reports store the string "default", and the id was the app's fallback for
    # years. `template.typ` stays on disk — it is the file every other theme was copied from and the starting
    # point the download offers — it is simply no longer a theme anyone can choose.
    "default",
    "prism-arcs",
    # Shapes and card and its plain sibling, retired for the variant without the circles, which took over
    # the name. Their ids stay here so a report that points at one renders in the default instead of 404ing.
    "prism-editorial-5",
    "prism-editorial-4",
})

#: The theme a new report starts on. First in the registry too, because the gallery follows this order —
#: and its label says "(PrismLCA Default)", which has to be true of something.
DEFAULT_TEMPLATE = "prism-network"

BUILTIN_TEMPLATES: dict[str, dict] = {
    # Order is the order of the gallery, so the one a report starts on comes first: Network, then Gradient
    # strip, Ribbons, Facets, Flows, Planes, Declining emissions, Network on dark, Shapes and card, Curved band
    # and the two from the second set of drafts.
    #
    # The pair from the HTML drafts: a process network converging on the product under study, set in a
    # monospace and a humanist sans. One light, one dark — generated from a single source and differing only
    # in their tone block, so a change to one belongs in the other.
    #
    # "on dark" is a tone, not a hue, which is why it stands in a label where a colour may not: the two are
    # the same layout and the paper is the whole difference between them.
    "prism-network": {
        "file": "template-network.typ",
        "label": "Network (PrismLCA Default)",
        "cover_image": False,
        # The fonts the theme typesets in. The renderer draws the report's figures, so a chart has to be
        # lettered in the same faces as the page around it — see the frontend's `figureFonts`.
        "fonts": {"body": "IBM Plex Sans", "mono": "JetBrains Mono"},
    },
    # A strip of colour down the left edge of the cover and the title in capitals on bars of paper running
    # out of it. A colour set has three colours and the strip needs four tones, so the theme computes its
    # ramp from the set in OKLCH — see "the ramp" in the file. Set in IBM Plex Sans throughout.
    "prism-strip": {
        "file": "template-strip.typ",
        "label": "Gradient strip",
        "cover_image": False,
        # One face for prose and figures alike: the tables set their figures in Plex's tabular digits, so a
        # chart's axis numbers match them in the same face rather than in a monospace.
        "fonts": {"body": "IBM Plex Sans", "mono": "IBM Plex Sans"},
    },
    # Eight ribbons of colour sweeping across the cover from the top right to the bottom left, the title in
    # tight capitals in the white below them and the study's year under it in the set's second colour. The
    # ribbons' eight tones run from the accent through a dark middle to the mark, computed from the set in
    # OKLCH like Gradient strip's — see "the ribbons' ramp" in the file. Set in Noto Sans throughout.
    "prism-ribbons": {
        "file": "template-ribbons.typ",
        "label": "Ribbons",
        "cover_image": False,
        "fonts": {"body": "Noto Sans", "mono": "Noto Sans"},
    },
    # A cover cut into thirteen facets like a cut stone, light at the top and dark at the foot, each a step
    # on a ramp from the accent to the deep tone computed like Flows'; the title, a large subtitle and
    # the date under them in white. The pages after it are Flows', with a bar of three solid lengths of
    # the set's colours under the running head. Montserrat for the headings, Open Sans for the prose.
    "prism-facets": {
        "file": "template-facets.typ",
        "label": "Facets",
        "cover_image": False,
        "fonts": {"body": "Open Sans", "mono": "Open Sans"},
    },
    # A cover of colour from edge to edge: eight bands ending in arrowheads, from the accent lightened at the
    # top to the deep tone darkened at the foot, computed from the set like Ribbons' — and the title and the
    # study's details on them in white. Montserrat for the headings, Open Sans for the prose.
    "prism-sans-duo": {
        "file": "template-sans-duo.typ",
        "label": "Flows",
        "cover_image": False,
        # The prose face: a chart's labels sit next to the prose, not next to the headings.
        "fonts": {"body": "Open Sans", "mono": "Open Sans"},
    },
    # A few large planes of flat colour on the paper — a slanted field, a disc cut by the edge, a dark arc —
    # tinted and mixed from the set, under a large light title. Libre Franklin labels, Libre Baskerville prose.
    "prism-planes": {
        "file": "template-planes.typ",
        "label": "Planes",
        "cover_image": False,
        # A chart's labels match the tables and captions around it, which are set in the label face.
        "fonts": {"body": "Libre Franklin", "mono": "Libre Franklin"},
    },
    # A typographic cover — the accent
    # square, the kind of document, a rule, a 43pt title, the study's details in a row — over three curves
    # falling across the foot of the page, every coloured thing a gradation of the set's one accent. Set in
    # Instrument Sans for the labels and Source Sans 3 for the prose, both bundled for it.
    "prism-study": {
        "file": "template-study.typ",
        "label": "Declining emissions",
        "cover_image": False,
        # The label face is a proportional sans, not a monospace: the "mono" slot is what a chart letters its
        # axis figures in, and on this theme those are set like the table heads around them.
        "fonts": {"body": "Source Sans 3", "mono": "Instrument Sans"},
    },
    # The dark half of the Network pair — see there: one source, so a change to one belongs in the other.
    # Further down the gallery than its light half: the order here is the gallery's, not the pair's.
    "prism-network-dark": {
        "file": "template-network-dark.typ",
        "label": "Network on dark",
        "cover_image": False,
        # The one flag the *renderer* needs from a theme. Figures are drawn in the frontend with echarts, so
        # their axis text, grid lines and legends have to know they will land on near-black paper — on light
        # defaults a dark theme prints charts with invisible axes. It cannot be read off the colour set: the
        # paper is this theme's own decision, not the palette's, which is what makes it a flag here.
        "dark": True,
        "fonts": {"body": "IBM Plex Sans", "mono": "JetBrains Mono"},
    },
    # The label, a heading and the study's details on a white card over a diagonal foot. Its id says "6"
    # because an id is what a stored report points at — it outlives both the label and the two earlier
    # variants (with circles, and plain), which are retired.
    "prism-editorial-6": {
        "file": "template-editorial-6.typ",
        # Labels name the *layout*, never a colour: a theme decides where the shapes sit and how a heading
        # is set, and the colours are a set of their own.
        "label": "Shapes and card",
        "cover_image": False,
        # A single mark: its head is one column, and two logos side by side there would compete with the
        # label and the heading hanging under them.
        "client_logo": False,
    },
    "prism-cover": {"file": "template-cover.typ", "label": "Curved band", "cover_image": False},
    # The second pair from the drafts, and a pair by contrast rather than
    # by construction: one is white paper, a serif and a measuring rule, the other a block of caps over a
    # field of the set's deep tone. The ids keep the drafts' working names because an id is what a stored
    # report points at — it outlives the label and whatever the cover ends up looking like.
    "prism-measured": {
        "file": "template-measured.typ",
        # Labels name the *layout*, never a colour.
        "label": "Serif and rule",
        "cover_image": False,
        # Prose in Noto Sans, headings in Source Serif 4 — a chart carries labels, not headings, so the body
        # face is the one a figure is lettered in.
        "fonts": {"body": "Noto Sans", "mono": "DejaVu Sans Mono"},
    },
    "prism-field": {
        "file": "template-field.typ",
        "label": "Panel and year",
        "cover_image": False,
        # Prose in Noto Sans, display type in its condensed cut. The body face again: a chart's labels sit
        # next to the prose, not next to the title.
        "fonts": {"body": "Noto Sans", "mono": "JetBrains Mono"},
    },
}


#: A report whose ``cover_image`` is this word uses the picture shipped with the app instead of one the
#: user uploaded. Stored as a word rather than a copy of the bytes: every report would otherwise carry
#: 270 kB of the same PNG, and nothing could tell "the default" from "a picture that happens to match".
DEFAULT_COVER = "default"


def default_cover_bytes() -> bytes:
    """The shipped placeholder cover, a generated image of our own. A JPEG, not a PNG: it is a
    photograph, and at 1672x941 (quality 95, full chroma) that is 300 kB instead of 1.7 MB — a difference
    paid for in the repository, in every exported project and in the app download. 200 dpi across a
    210mm page, which is enough for a cover."""
    path = _ASSETS / "images" / "cover-default.jpg"
    if not path.is_file():
        raise PrismError(
            "The default cover image is missing from the installation.", code="cover_default_missing"
        )
    return path.read_bytes()


def builtin_template_source(template_id: str) -> str:
    """The shipped source of a built-in template id."""
    entry = BUILTIN_TEMPLATES.get(template_id)
    if entry is None:
        raise PrismError(
            f"No built-in theme '{template_id}'.",
            code="report_template_not_found",
            status_code=404,
            hint=f"Built-in themes: {', '.join(BUILTIN_TEMPLATES)}.",
        )
    return template_source(entry["file"])


def default_template_source() -> str:
    """The source of the theme a report gets when it names none — `DEFAULT_TEMPLATE`, whichever that is.

    `template=None` used to mean the file `template.typ`, which was fine while that file was also a theme in
    the picker. It is not any more (its id is retired), so "no theme chosen" has to resolve to the theme the
    app actually starts on, or an old report would render a cover nobody can select.
    """
    return builtin_template_source(DEFAULT_TEMPLATE)


def template_source(name: str = "template.typ") -> str:
    """Read one of the shipped Typst sources (a built-in template, the fixture).

    `template.typ` is still here as the file every other theme was copied from, and as the starting point the
    download offers — it is simply no longer offered as a theme of its own.
    """
    path = _ASSETS / "typst" / name
    if not path.is_file():
        raise PrismError(f"Typst source '{name}' is missing from the installation.", code="typst_asset_missing")
    return path.read_text(encoding="utf-8")


#: Typst's own diagnostic carries `path:line:column` under a box-drawing rule. The path is inside the
#: throwaway build directory, so only its tail is of any use here.
_DIAGNOSTIC_LOCATION = re.compile(r"([^\s:]+\.typ):(\d+):(\d+)")

#: A Typst heading, which is what a reader recognises as "the chapter".
_TYPST_HEADING = re.compile(r"^=+\s+(.*)$")


def _where_it_failed(exc: Exception, sources: dict[str, str | bytes]) -> str | None:
    """Which chapter and which line the compiler choked on, in words.

    Typst reports "unclosed label" and nothing else through `str(exc)` — a message that says a report
    cannot be produced and gives no way to find out why. Its `diagnostic` attribute does carry the
    position, so the useful half of that is recovered here: the file, the line, the heading the line
    sits under, and the line itself. It only ever *adds* to the compiler's own message, and any
    surprise in the diagnostic's shape simply yields None (V170).
    """
    diagnostic = str(getattr(exc, "diagnostic", "") or "")
    match = _DIAGNOSTIC_LOCATION.search(diagnostic)
    if not match:
        return None
    name = match.group(1).rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    number = int(match.group(2))
    # The build directory is a temporary copy, so match the file back to the source it was written from.
    key = next((k for k in sources if k == name or k.endswith("/" + name)), None)
    content = sources.get(key) if key else None
    if not isinstance(content, str):
        return None
    lines = content.split("\n")
    if not 1 <= number <= len(lines):
        return None
    chapter = ""
    for previous in reversed(lines[: number - 1]):
        heading = _TYPST_HEADING.match(previous)
        if heading:
            chapter = heading.group(1).strip()
            break
    offending = lines[number - 1].strip()
    if len(offending) > 120:
        offending = offending[:117] + "…"
    place = f"{key}, line {number}"
    if chapter:
        place += f", under “{chapter}”"
    return f"{place}: {offending}" if offending else place


def _compile_failed(exc: Exception, sources: dict[str, str | bytes]) -> PrismError:
    """One error for both compile paths, so a PDF and a preview report a failure the same way."""
    hint = "If a custom template is in use, this is where its error shows up."
    where = _where_it_failed(exc, sources)
    if where:
        hint = f"The compiler stopped at {where}\n{hint}"
    return PrismError(
        f"The report could not be typeset: {exc}",
        code="typst_compile_failed",
        hint=hint,
    )


def _materialise(sources: dict[str, str | bytes], root: Path) -> None:
    """Write in-memory sources into a build directory, creating subdirectories as needed.

    The containment check is not paranoia: a source key comes from a report definition, and a template
    or chapter path with `..` in it would otherwise write into the user's filesystem.

    A project with no `palette.typ` gets the default set. The shipped themes import their colours from it,
    so a caller that assembles a project by hand — a test, a probe, a one-off compile — would otherwise fail
    on a missing file rather than on anything to do with what it was checking. It cannot mask a wrong colour:
    the assembler always writes the report's own set, and "absent" only ever means "nobody chose".
    """
    if "palette.typ" not in sources:
        from prism_lca.engine import report_palettes

        sources = {**sources, "palette.typ": report_palettes.palette_typst()}
    for rel, content in sources.items():
        target = root / rel
        if not target.resolve().is_relative_to(root.resolve()):
            raise PrismError(f"Refusing to write outside the build directory: {rel}", code="typst_bad_path")
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")


#: Rasterised pages of the last few documents, keyed by a hash of their sources.
#:
#: One compile produces every page, so paging through a preview used to recompile the whole document for
#: each page — the reader clicked "next" and waited half a minute for a document that was already sitting
#: in memory a moment earlier. Three documents is plenty: a preview is one document at a time, and the
#: spare slots cover switching back and forth between two reports.
_PAGE_CACHE: OrderedDict[str, list[bytes]] = OrderedDict()
_PAGE_CACHE_MAX = 3


def _sources_key(sources: dict[str, str | bytes], ppi: int) -> str:
    digest = hashlib.sha256()
    for name in sorted(sources):
        content = sources[name]
        digest.update(name.encode("utf-8"))
        # Delimiter between name and content: without it {"ab.typ": "c…"} and {"a": "b.typc…"} hash alike.
        digest.update(b"\x00")
        digest.update(content if isinstance(content, bytes) else content.encode("utf-8"))
        digest.update(b"\x00")
    digest.update(str(ppi).encode("ascii"))
    return digest.hexdigest()


def compile_png(
    sources: dict[str, str | bytes], main: str = "main.typ", *, page: int = 1, ppi: int = 96
) -> tuple[bytes, int]:
    """Render one page as PNG, and say how many pages there are.

    This exists so the preview can show the actual typeset document rather than an HTML approximation
    of it. Reordering chapters is the moment that matters: the point of dragging is to see what you
    are dragging, and page breaks, table widths and caption numbering only exist after typesetting.

    Same compiler, same fonts, same `ignore_system_fonts` as the PDF — the preview is not a second
    renderer that could disagree with the output.

    Pages are cached per document, so turning a page costs nothing: the compiler produced them all the
    first time. Any edit changes the sources and therefore the key, so a stale page cannot be served.
    """
    if main not in sources:
        raise PrismError(f"The main source '{main}' is not among the given sources.", code="typst_no_main")

    key = _sources_key(sources, ppi)
    cached = _PAGE_CACHE.get(key)
    if cached:
        _PAGE_CACHE.move_to_end(key)
        index = max(1, min(int(page), len(cached))) - 1
        return cached[index], len(cached)

    with tempfile.TemporaryDirectory(prefix="prism-typst-") as tmp:
        root = Path(tmp)
        _materialise(sources, root)
        try:
            pages = typst.compile(
                str(root / main),
                root=str(root),
                font_paths=[str(font_dir())],
                ignore_system_fonts=True,
                format="png",
                ppi=ppi,
            )
        except Exception as exc:
            raise _compile_failed(exc, sources) from exc

    # A single-page document comes back as bytes, several pages as a list. Normalising here keeps the
    # two cases out of the endpoint.
    images = pages if isinstance(pages, list) else [pages]
    if not images:
        raise PrismError("Typst produced no pages.", code="typst_bad_output")
    _PAGE_CACHE[key] = images
    while len(_PAGE_CACHE) > _PAGE_CACHE_MAX:
        _PAGE_CACHE.popitem(last=False)
    index = max(1, min(int(page), len(images))) - 1
    return images[index], len(images)


def compile_pdf(sources: dict[str, str | bytes], main: str = "main.typ") -> bytes:
    """Compile a set of in-memory sources to PDF bytes.

    `sources` maps relative paths ("main.typ", "chapters/01.typ", "charts/gwp.svg") to their content;
    subdirectories are created as needed. Binary assets (images) are passed as bytes.

    A compiler error becomes a PrismError carrying Typst's own message — the generated code plus a
    possibly foreign template means errors point at lines nobody wrote, so the raw message is the
    only useful thing we can hand on.
    """
    if main not in sources:
        raise PrismError(f"The main source '{main}' is not among the given sources.", code="typst_no_main")

    with tempfile.TemporaryDirectory(prefix="prism-typst-") as tmp:
        root = Path(tmp)
        _materialise(sources, root)

        try:
            pdf = typst.compile(
                str(root / main),
                root=str(root),
                font_paths=[str(font_dir())],
                ignore_system_fonts=True,
            )
        except Exception as exc:  # typst.TypstError and anything the extension raises
            raise _compile_failed(exc, sources) from exc

    if isinstance(pdf, list):  # a per-page result would mean the format was not PDF
        raise PrismError("Typst returned pages instead of a PDF document.", code="typst_bad_output")
    if not pdf.startswith(b"%PDF"):
        raise PrismError("Typst produced something that is not a PDF.", code="typst_bad_output")
    return pdf


#: What a theme has to define. The fixture calls exactly these, so a theme missing one of them fails to
#: compile — with "unknown variable: lca-outlines", which names an internal symbol the author has never
#: read and reveals the contract one upload at a time. Kept here, beside the check that enforces it.
TEMPLATE_CONTRACT: tuple[str, ...] = (
    "lca-report-template",
    "lca-outlines",
    "lca-kv",
    "lca-table",
    "lca-figure",
)


def _contract_gap(template: str, exc: PrismError) -> PrismError | None:
    """Turn "unknown variable: lca-…" into the sentence the theme author actually needs.

    Deliberately additive: the compiler stays the authority on whether a theme works, and this only
    replaces the *message* when the source visibly defines none of the missing names. A theme that
    provides them some other way (an import, a loop) keeps the compiler's own wording, so a crude
    string search can never refuse something that compiles.
    """
    if "unknown variable: lca-" not in str(exc):
        return None
    missing = [name for name in TEMPLATE_CONTRACT if f"#let {name}" not in template]
    if not missing:
        return None
    names = ", ".join(missing)
    return PrismError(
        "This theme does not define everything a report is typeset with: "
        f"{names}. A theme has to provide all five — lca-report-template (page setup and cover), "
        "lca-outlines (contents, and the figure and table lists), lca-kv (a key/value block), "
        "lca-table (a data table) and lca-figure (an image with a caption). Download one of the "
        "themes here and edit that file: it is the contract in full, and it compiles before you start.",
        code="report_template_contract",
        hint=str(exc),
    )


def validate_template(template: str, *, palette: str | None = None) -> None:
    """Compile the fixture against `template` — the contract check before a template is used.

    Raises PrismError with the compiler's message when the template does not satisfy the contract
    (missing function, syntax error, wrong signature).

    `palette` names the colour set to validate against; the default is enough for an upload (a theme that
    compiles in one set compiles in all of them, since a set is only rgb values under fixed names), and the
    argument exists so the test suite can prove that of every combination rather than assume it.
    """
    fixture_figure = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">'
        '<rect width="80" height="40" fill="#93c120"/></svg>'
    )
    from prism_lca.engine import report_palettes

    sources: dict[str, str | bytes] = {
        "template.typ": template,
        "fixture.typ": template_source("fixture.typ"),
        "fixture-figure.svg": fixture_figure,
        # The shipped themes import their colours; the fixture has to provide them, or validating one
        # of our own templates would fail on a missing file. An uploaded theme that declares its own
        # colours simply does not import it.
        "palette.typ": report_palettes.palette_typst(palette),
    }
    try:
        compile_pdf(sources, main="fixture.typ")
    except PrismError as exc:
        raise _contract_gap(template, exc) or exc from None
