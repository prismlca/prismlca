"""Colour sets the report themes draw from.

Every shipped theme used to declare the same eight colours at the top of its own file, so changing the
look of a document meant editing five Typst files identically. They now import ``palette.typ``, which the
assembler writes per render from the set the report names — one choice that reaches whichever theme is in
use, which is the point: a theme decides the *layout* (where the cover picture sits, how a heading is
set), a palette decides the *colour*, and those are two questions.

Analysis behind the shape of a set: of the eight names, only two carry the design — ``accent`` (4 to 10
uses per theme: rules, marks, the badge, the coloured shapes) and ``deep`` (5 to 10: headings, dark bands,
the second shape). ``paper`` tints the cover of two themes. The rest are neutrals, identical everywhere.
So a set is chosen by three colours and defines its neutrals explicitly rather than deriving them: a
derived grey is a plausible grey, and "plausible" is not what a client document needs.

``prism-plum`` is gone. It was declared in four themes and used in none.

**Sets of your own.** Beside the shipped sets, a user may name sets of their own: three colours — accent,
deep tone, paper, the three a reader sees — and a name. They belong to the installation, not to a report or
a workspace (`<data dir>/prism_meta/report-palettes.json`): a house style is chosen once and used in every
study. The neutrals and the mark come from the default set, for the reason the shipped sets name theirs
explicitly — a derived grey is a plausible grey — and because the per-report colour fields have always done
exactly that: three colours over the default's neutrals.
"""
from __future__ import annotations

import re
import secrets
import threading
from pathlib import Path

from prism_lca.config import get_settings
from prism_lca.engine._store import now_iso, read_json, write_json_atomic
from prism_lca.errors import PrismError

#: One palette: the two colours that carry the design, a second mark, the paper of the cover, and the neutrals.
#: Keys are the Typst names the themes already use, so a theme body needs no change to adopt a set.
#:
#: ``prism-accent2`` came with the Network themes, which need a colour for the *one* thing a page points at —
#: the product node at the end of the graph, the row a table wants read first. Derived would have been wrong
#: here: a complement computed from the accent lands wherever the hue wheel puts it, and half the time that is
#: a colour nobody would choose against this paper. So each set names it, and the five older themes ignore it.
_KEYS = (
    "prism-green", "prism-navy", "prism-accent2", "prism-ink", "prism-text", "prism-gray", "prism-line",
    "prism-muted", "paper",
)

PALETTES: list[dict] = [
    {
        "id": "prism",
        "label": "PrismLCA",
        "hint": "The house palette: lime green on navy.",
        # Exactly the values every theme carried before, so the default changes nothing.
        "colors": {
            "prism-green": "#93c120",
            "prism-navy": "#2f4e66",
            # The mark for the one thing a page points at. Warm against the lime, so it reads as "this one".
            "prism-accent2": "#d18a00",
            "prism-ink": "#303030",
            "prism-text": "#626b71",
            "prism-gray": "#8a8a8a",
            "prism-line": "#cbcbcb",
            "prism-muted": "#f2f2f2",
            "paper": "#f8f9fa",
        },
    },
    {
        # The Network themes' own pairing, and the set they are designed against — a technical teal with an
        # amber for the one thing the page points at. It replaced "Graphite & amber", whose brown accent was
        # the wrong lead colour for a document.
        "id": "teal-amber",
        "label": "Teal & amber",
        "hint": "Technical teal with an amber mark. The Network themes are drawn for this one.",
        "colors": {
            "prism-green": "#0e8f82",
            "prism-navy": "#14181c",
            "prism-accent2": "#d9862f",
            "prism-ink": "#14181c",
            "prism-text": "#5c636b",
            "prism-gray": "#8a9098",
            "prism-line": "#cdd1cc",
            "prism-muted": "#eceeea",
            "paper": "#f6f6f3",
        },
    },
    {
        # A red lead colour, which nothing else here has: brick rather than scarlet, so it reads as editorial
        # emphasis and not as an alarm. Replaced "Brass & aubergine" for the same reason as above.
        "id": "brick",
        "label": "Brick & slate",
        "hint": "A brick red on blue-grey slate — the one set here that leads with a warm red.",
        "colors": {
            "prism-green": "#b0432f",
            "prism-navy": "#2b3a42",
            "prism-accent2": "#4f7d8c",
            "prism-ink": "#26303a",
            "prism-text": "#5d666d",
            "prism-gray": "#8b9298",
            "prism-line": "#ccd2d4",
            "prism-muted": "#f0f2f2",
            "paper": "#f8f7f5",
        },
    },
    {
        "id": "teal",
        "label": "Teal & clay",
        "hint": "Terracotta on deep teal. Prints well and looks like nothing else here.",
        "colors": {
            "prism-green": "#bb5c37",
            "prism-navy": "#17505a",
            "prism-accent2": "#c9a227",
            "prism-ink": "#2c3134",
            "prism-text": "#5c686c",
            "prism-gray": "#8a959a",
            "prism-line": "#c8d0d2",
            "prism-muted": "#eff3f3",
            "paper": "#f8f6f4",
        },
    },
    {
        "id": "indigo",
        "label": "Indigo & rose",
        "hint": "Editorial: a muted rose against indigo.",
        "colors": {
            "prism-green": "#ab4a64",
            "prism-navy": "#2e3566",
            "prism-accent2": "#d08b3a",
            "prism-ink": "#2c2e39",
            "prism-text": "#5e627a",
            "prism-gray": "#8c90a4",
            "prism-line": "#cbcdd9",
            "prism-muted": "#f1f1f6",
            "paper": "#f8f8fb",
        },
    },
    {
        "id": "steel",
        "label": "Steel & ink",
        "hint": "A blue accent on warm black — the only set here whose accent is cool. Prints anywhere.",
        "colors": {
            "prism-green": "#2c6e93",
            "prism-navy": "#23211e",
            "prism-accent2": "#c2703a",
            "prism-ink": "#24221f",
            "prism-text": "#5c5851",
            "prism-gray": "#8b877e",
            "prism-line": "#ccc8c0",
            "prism-muted": "#f2f0ec",
            "paper": "#f7f8fa",
        },
    },
    {
        # ---- The three below are the 2026 sets (the first three were all muted near-hues; these are
        # ---- three directions this app did not have). Anchored in what is actually named for the year:
        # ---- Pantone's Colour of the Year 2026 "Cloud Dancer" (#f0eee9, an airy off-white) and the
        # ---- WGSN/Coloro key colours for 2026 — Fresh Purple, Electric Fuchsia, Cocoa Powder, Jelly Mint.
        #
        # The quiet one, and the only set here whose *paper* is the statement: Cloud Dancer as the page,
        # with a matcha green doing the pointing. Nothing else in the app leads with a desaturated accent —
        # everything is a saturated hue on a dark neutral — which is exactly the editorial register 2026 went
        # to. Serif and rule is the layout it was drawn against.
        "id": "cloud",
        "label": "Cloud & matcha",
        "hint": "Pantone's 2026 off-white as the paper, with a matcha green. The quietest set here.",
        "colors": {
            "prism-green": "#6c7d43",
            "prism-navy": "#2b2c26",
            # Clay, for the one thing a page points at: warm against the matcha without turning it autumnal.
            "prism-accent2": "#a4552f",
            "prism-ink": "#22241f",
            "prism-text": "#5b5f53",
            "prism-gray": "#8b8f81",
            "prism-line": "#cfd0c4",
            "prism-muted": "#eceade",
            "paper": "#f0eee9",
        },
    },
    {
        # The loud one, and the only purple in the app: WGSN's Fresh Purple as the field, Electric Fuchsia as
        # the accent — the pair 2026 is actually shouting with. On Panel and year the aubergine third of the
        # page carries it; on the quieter layouts it is one 2mm rule and a page number, which is where a
        # colour this strong belongs.
        "id": "aubergine",
        "label": "Aubergine & fuchsia",
        "hint": "A fuchsia accent on deep aubergine — the loudest set here, and the only purple.",
        "colors": {
            "prism-green": "#c02a6e",
            "prism-navy": "#2b1830",
            # Amber, deliberately not another pink: the second mark has to be *another* colour or the page
            # points at two things in the same voice.
            "prism-accent2": "#d59a2b",
            "prism-ink": "#241a28",
            "prism-text": "#5f5566",
            "prism-gray": "#8f8595",
            "prism-line": "#d5ccd8",
            "prism-muted": "#f4eff5",
            "paper": "#faf7fa",
        },
    },
    {
        # Warm field, cool accent — the one combination none of the others make. Cocoa Powder as the deep
        # tone with Jelly Mint as the accent: it is the "Earthy Warmth" palette everyone lists for 2026, but
        # pointed with a mint rather than the mustard that makes it read as autumn. Darkened for 7pt type the
        # mint holds up on paper, which a mint usually does not.
        "id": "cocoa",
        "label": "Cocoa & mint",
        "hint": "A cool mint on deep cocoa. Warm field, cool accent — nothing else here does that.",
        "colors": {
            "prism-green": "#2f8f77",
            "prism-navy": "#3a2a21",
            "prism-accent2": "#c98a2b",
            "prism-ink": "#2a211b",
            "prism-text": "#61564e",
            "prism-gray": "#8e8378",
            "prism-line": "#d6ccc2",
            "prism-muted": "#f2ece5",
            "paper": "#faf7f3",
        },
    },
]

DEFAULT_PALETTE = "prism"

_BY_ID = {p["id"]: p for p in PALETTES}


def resolve(palette_id: str | None) -> dict:
    """The named set — shipped or the user's own — or the default. An unknown id falls back rather than
    failing: a report that names a palette a later version removed, or a set of your own that was deleted
    or lives on another computer, still has to render."""
    pid = str(palette_id or "")
    if pid in _BY_ID:
        return _BY_ID[pid]
    for p in user_palettes():
        if p["id"] == pid:
            return p
    return _BY_ID[DEFAULT_PALETTE]


#: The three a report may override by hand, mapped onto the names the themes use. The same three the
#: picker shows as swatches: they are what a reader sees as the document's colour, and the neutrals are
#: what keeps a document readable — a hand-picked grey is how a report ends up with grey-on-grey rules.
OVERRIDABLE = {"accent": "prism-green", "deep": "prism-navy", "paper": "paper"}

_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def check_colors(colors: dict | None) -> dict[str, str]:
    """Validate a set of hand-picked colours: `{accent, deep, paper}`, each a `#rgb` or `#rrggbb`.

    Refused here rather than at render time. An unchecked string reaches `rgb("…")` in `palette.typ` and
    fails the *compile*, so a typo in a colour field would surface as "the report cannot be typeset" —
    on a page that no longer shows the field that caused it.
    """
    if not colors:
        return {}
    out: dict[str, str] = {}
    for key, value in colors.items():
        if key not in OVERRIDABLE:
            raise PrismError(
                f"Unknown colour '{key}'.",
                code="report_color_unknown",
                hint=f"Overridable: {', '.join(OVERRIDABLE)}.",
            )
        text = str(value or "").strip()
        if not text:
            continue  # an empty field means "use the set's own", not "black"
        if not _HEX.match(text):
            raise PrismError(
                f"'{text}' is not a hex colour.",
                code="report_color_invalid",
                hint="Write it as #rrggbb (or #rgb), for example #2f4e66.",
            )
        out[key] = text.lower()
    return out


def palette_typst(palette_id: str | None = None, colors: dict | None = None) -> str:
    """``palette.typ``: the set as Typst bindings, under the names the themes already use.

    Written into every render beside `template.typ`. A theme adopts a set by importing it; an uploaded
    theme that declares its own colours keeps them, which is why the import is the theme's decision and
    not something the assembler does to it.

    `colors` are a report's own accent, deep tone and paper, replacing the set's — written into this file
    rather than kept anywhere else, so the export carries them like every other colour and the themes need
    to know nothing about them.
    """
    p = resolve(palette_id)
    picked = check_colors(colors)
    values = dict(p["colors"])
    for key, name in OVERRIDABLE.items():
        if key in picked:
            values[name] = picked[key]
    lines = [
        "// Written by PrismLCA from the report's colour set — do not edit; it is replaced on every render.",
        f"// Set: {p['label']} ({p['id']})",
    ]
    if picked:
        lines.append(
            "// With colours chosen on the report: "
            + ", ".join(f"{OVERRIDABLE[k]} {picked[k]}" for k in OVERRIDABLE if k in picked)
        )
    lines.append("")
    lines += [f'#let {key} = rgb("{values[key]}")' for key in _KEYS]
    return "\n".join(lines) + "\n"


def list_palettes() -> list[dict]:
    """The catalogue for the picker: id, label, hint and the three colours worth showing as swatches —
    the shipped sets first, then the user's own in the order they were added.

    Three, not eight: those are the ones a reader sees as the document's colour — the accent, the deep
    tone and the cover's paper. The neutrals belong to the set but choosing by them is choosing by grey.
    `builtin` tells the picker which ones it may offer to delete.
    """
    return [
        {
            "id": p["id"],
            "label": p["label"],
            "hint": p["hint"],
            "swatches": [p["colors"]["prism-green"], p["colors"]["prism-navy"], p["colors"]["paper"]],
            "builtin": p.get("builtin", True),
        }
        for p in [*PALETTES, *user_palettes()]
    ]


# ---- sets of your own ---------------------------------------------------------------------------------

#: Long enough for "Doe Consulting house style", short enough to fit a chip in the picker.
LABEL_MAX = 40

_USER_LOCK = threading.Lock()


def _user_path() -> Path:
    # Under the data directory, not a workspace's `prism_meta`: a set belongs to the installation.
    return get_settings().data_dir / "prism_meta" / "report-palettes.json"


def _six(hex_colour: str) -> str:
    """`#abc` as `#aabbcc`. The picker's colour well only takes six digits, and one spelling per colour
    keeps two sets of the same colours from looking different on disk."""
    h = hex_colour.lower()
    return "#" + "".join(c * 2 for c in h[1:]) if len(h) == 4 else h


def _stored() -> list[dict]:
    data = read_json(_user_path(), default={}, on_error="empty_io")
    return [p for p in (data.get("palettes") or []) if isinstance(p, dict) and p.get("id")]


def user_palettes() -> list[dict]:
    """The user's own sets, in the shape of a shipped one: the three chosen colours over the default
    set's neutrals and mark."""
    base = _BY_ID[DEFAULT_PALETTE]["colors"]
    out = []
    for p in _stored():
        colors = dict(base)
        colors.update({"prism-green": p["accent"], "prism-navy": p["deep"], "paper": p["paper"]})
        out.append({
            "id": p["id"],
            "label": p["label"],
            "hint": "Your own set: accent, deep tone and paper; the greys and the mark are PrismLCA's.",
            "colors": colors,
            "builtin": False,
        })
    return out


def add_user_palette(label: str, accent: str, deep: str, paper: str) -> dict:
    """Store a named set of three colours and return it in the picker's shape.

    All three are required — a set of your own has no set underneath to fill a gap from — and the name must
    differ from every other set's, shipped or own, or the picker would show two chips nobody can tell apart.
    """
    name = " ".join(str(label or "").split())
    if not name:
        raise PrismError("A colour set needs a name.", code="palette_name_missing")
    if len(name) > LABEL_MAX:
        raise PrismError(
            f"A set's name can be at most {LABEL_MAX} characters.", code="palette_name_too_long",
        )
    picked = check_colors({"accent": accent, "deep": deep, "paper": paper})
    missing = [k for k in OVERRIDABLE if k not in picked]
    if missing:
        raise PrismError(
            f"A colour set needs all three colours; missing: {', '.join(missing)}.",
            code="palette_color_missing",
        )
    with _USER_LOCK:
        stored = _stored()
        taken = {p["label"].casefold() for p in PALETTES} | {p["label"].casefold() for p in stored}
        if name.casefold() in taken:
            raise PrismError(
                f"There is already a colour set called '{name}'.",
                code="palette_name_taken",
                hint="Give this one another name.",
            )
        entry = {
            "id": f"own-{secrets.token_hex(4)}",
            "label": name,
            "accent": _six(picked["accent"]),
            "deep": _six(picked["deep"]),
            "paper": _six(picked["paper"]),
            "created": now_iso(),
        }
        write_json_atomic(_user_path(), {"palettes": [*stored, entry]})
    return next(p for p in list_palettes() if p["id"] == entry["id"])


def remove_user_palette(palette_id: str) -> None:
    """Delete a set of your own. A report that names it renders in the default set from then on — the same
    fallback as for any set that is gone — and the shipped sets cannot be deleted at all."""
    if palette_id in _BY_ID:
        raise PrismError(
            "The sets that ship with PrismLCA cannot be deleted.", code="palette_builtin",
        )
    with _USER_LOCK:
        stored = _stored()
        kept = [p for p in stored if p["id"] != palette_id]
        if len(kept) == len(stored):
            raise PrismError(f"No colour set '{palette_id}'.", code="palette_not_found", status_code=404)
        write_json_atomic(_user_path(), {"palettes": kept})
