"""Report language: fixed strings and locale-aware number formatting.

Two deliberate separations.

**Fixed strings are translated, not generated.** Headings, table headers, standard phrases and the
disclaimer come from the table below. Letting the model translate them would produce a slightly
different wording on every regeneration and spend tokens on text that never changes.

**Identifiers are never translated.** Dataset names ("market for electricity, low voltage"), method
names and units stay verbatim — they are identifiers, and translating them would destroy traceability.
A German report therefore contains English dataset names, which is correct.

Number formats follow the report language, which is the second reason numbers live in placeholders:
switching the language reformats every figure without touching a word of prose.
"""
from __future__ import annotations

import json
from pathlib import Path

# Chapter kind -> the string key that names it: from the ChapterKind registry, the one place a
# chapter kind gets a name. `report_render` takes the default heading for a kind via this module, so
# a key that drifted used to drift in both places at once — one source removes the pair.
from prism_lca.engine.report_kinds import KIND_TITLES  # noqa: F401

#: Decimal and thousands separator per language. French uses a narrow no-break space (U+202F), which
#: is what the Imprimerie nationale prescribes and what Typst renders without a line break.
SEPARATORS: dict[str, tuple[str, str]] = {
    "en": (".", ","),
    "de": (",", "."),
    "fr": (",", " "),
    "es": (",", "."),
    "pt": (",", "."),
}

#: Languages with a reviewed string table. Adding one is a table entry, not a code change.
LANGUAGES = tuple(SEPARATORS)

#: The five reviewed tables live as JSON beside the fonts and templates (assets/i18n/<lang>.json) —
#: 870 lines of literal drowned this module's actual logic (formatting, plural rules). Loaded once at
#: import, same path pattern as `typst_render._ASSETS`; a missing or unparsable table is a packaging
#: error and crashes the import rather than falling back silently. `ensure_ascii=False` on the dump
#: keeps the files reviewable as text.
_I18N_DIR = Path(__file__).resolve().parent.parent / "assets" / "i18n"

_STRINGS: dict[str, dict[str, str]] = {
    lang: json.loads((_I18N_DIR / f"{lang}.json").read_text(encoding="utf-8")) for lang in LANGUAGES
}


def normalise(lang: str | None) -> str:
    """Accept "de", "de-DE", "DE_at" — fall back to English for anything without a table."""
    if not lang:
        return "en"
    base = str(lang).replace("_", "-").split("-")[0].lower()
    return base if base in _STRINGS else "en"


def t(key: str, lang: str = "en", **kwargs: object) -> str:
    """A fixed string. Falls back to English, then to the key itself — a missing string shows up as
    a visible key rather than as an empty heading."""
    lc = normalise(lang)
    text = _STRINGS[lc].get(key) or _STRINGS["en"].get(key) or key
    return text.format(**kwargs) if kwargs else text


def kind_title(kind: str, lang: str = "en") -> str:
    """The standard heading for a chapter kind — the raw kind for one nobody has named yet.

    The fallback is deliberate and it is the slug: a kind this table does not know is a chapter the
    software has just learned about, and printing `plan_b` beats printing nothing at all. Everything
    shipped has an entry.
    """
    key = KIND_TITLES.get(str(kind))
    return t(key, lang) if key else str(kind)


def chapter_name(section: dict[str, object], lang: str = "en") -> str:
    """What a chapter is called: its own title, else the standard name of its kind, else the raw kind.

    A chapter carries a title only once somebody has renamed it, so an untitled one holds an empty
    string — the normal case, not the exception, and interpolating it raw produced "Section '' is
    frozen" in four refusals (V192). The same chain the author already sees in the chapter list.

    English by default, and that is the point of the default rather than an oversight. These names go
    into *interface* text — an error message, a refusal — which is English whatever language the report
    is written in; pass ``lang`` only where the name is going into the document itself.
    """
    return str(section.get("title") or "").strip() or kind_title(str(section.get("kind") or ""), lang)


#: The label a chapter references -> the string key that names what stands there. A caption where the
#: block has a fixed one, because a caption is the line the reader will find under the table; the
#: chapter's own heading where the caption names an indicator or a breakdown dimension the label alone
#: does not carry ("{indicator} — comparison of the assessed variants" cannot be filled in from a
#: label, and a key with an unfilled argument would print a brace at the reader). A label that is not
#: here is not a mistake — it gets the plain kind word, which is enough wherever a chapter has one.
_REF_NAMES: dict[str, str] = {
    "t-lcia": "caption.lcia",
    "t-method-legend": "caption.methods",
    "t-contribution": "caption.contribution",
    "t-completeness": "caption.completeness",
    "t-sensitivity": "caption.sensitivity",
    "t-consistency": "caption.consistency",
    "t-parameters": "caption.parameters",
    "t-scenarios": "caption.scenarios",
    "t-methods": "caption.method_choice",
    "t-foreground": "caption.foreground",
    "t-datasets": "caption.datasets",
    "t-inventory": "caption.inventory",
    "t-references": "references.title",
    "t-sources": "caption.cited_sources",
    "t-web-research": "caption.researched_sources",
    "t-abbreviations": "abbreviations.title",
    "f-lcia": "lcia.title",
    "f-contribution": "contribution.title",
    "f-heatmap": "caption.figure_heatmap",
    "f-radar": "caption.figure_radar",
    "f-system-model": "system_model.title",
    "t-contribution-hotspots": "caption.hotspots",
    "t-deltas": "caption.deltas",
}


def ref_phrase(label: str, lang: str = "en") -> str:
    """What a cross-reference reads like where the document's number is not available (V183).

    The document prints "Table 8", and that 8 is Typst's, produced while it sets the whole document —
    counted over every table that survived, in the order they end up in, with the supplement word
    ("Table"/"Tabelle") coming from Typst's own localisation. None of it exists in a correction dialog,
    and half of it cannot: the charts are drawn in the frontend and handed to the renderer at export
    time, so a figure's number is not computable here at all. A number that disagrees with the PDF
    would be worse than no number, so this names the thing instead of counting it.

    ``t-`` is a table and ``f-`` is a figure — the renderer's own convention, and the only two prefixes
    it emits (`report_render`, `report_typst`). Indexed labels (`f-lcia-2`, `t-contribution-1`) share
    their base name: which of three contribution tables it is, is what the sentence around it says.
    A label the map does not know — a chapter's own figure, or one from a later version — still gets
    the plain kind word rather than its id.
    """
    name = (label or "").strip()
    kind = "table" if name.startswith("t-") else "figure"
    key = _REF_NAMES.get(name) or _REF_NAMES.get(name.rsplit("-", 1)[0] if name[-1:].isdigit() else name)
    if not key:
        return t(f"ref.{kind}_any", lang)
    return t(f"ref.{kind}", lang, name=t(key, lang))


#: Words that join two names in the five report languages, matched with spaces around them so
#: "Alexander" or "Andes" cannot trigger on their "and"/"e".
_AUTHOR_CONJUNCTIONS = (" und ", " and ", " et ", " y ", " e ", " & ")


def is_plural_authors(value: str) -> bool:
    """Whether an author field names more than one person.

    The field is free text — there is no list to count. Two levels of certainty:

    * A semicolon, an ampersand or a conjunction means two names. Nobody writes one name that way.
    * A comma is ambiguous, because "Doe, Jane" is one person written surname-first. So a comma only
      counts when *every* part around it contains a space, i.e. each looks like a full name:
      "Jane Doe, John Smith" is two people, "Doe, Jane" is one.

    Wrong either way costs a plural "s" on a cover, so the rule errs towards the singular.
    """
    text = (value or "").strip()
    if not text:
        return False
    if ";" in text or " & " in text:
        return True  # nobody writes one name with a semicolon or an ampersand
    # A word conjunction only counts when both sides look like full names (contain a space
    # themselves): Romance compound surnames use the same word — "Costa e Silva" is one Portuguese
    # author, and the docstring's promise to err towards the singular has to hold for them too.
    lowered = text.lower()
    for word in _AUTHOR_CONJUNCTIONS:
        at = lowered.find(word)
        if at > 0:
            left, right = text[:at].strip(), text[at + len(word):].strip()
            if " " in left and " " in right:
                return True
    parts = [p.strip() for p in text.split(",") if p.strip()]
    return len(parts) > 1 and all(" " in p for p in parts)


def fmt_column(values: list[float], lang: str = "en") -> list[str]:
    """Format a column of numbers with the *same* number of decimals.

    Per-value formatting is what a single figure in a sentence wants, but in a column it reads as
    sloppiness: 1,201 next to 2,3 looks like two different measurements. The decimals follow the
    **largest** magnitude in the column, so the leading value reads cleanly and the small ones fall away
    into zeros — their weight is in the share column anyway. Keying off the smallest instead, as an
    earlier version did, let one 0,000338 row impose six decimals on everything above it.

    Values spanning many orders of magnitude fall back to per-value formatting, because forcing common
    decimals there would print either a wall of zeros or nothing at all.
    """
    import math

    # NaN/inf must not pick the column format: NaN slips past every range check and then crashes
    # `log10` — one bad score took the whole render down. Per-value formatting handles them.
    finite = [abs(v) for v in values if v != 0.0 and math.isfinite(v)]
    if not finite:
        return [fmt_number(v, lang) for v in values]
    low, high = min(finite), max(finite)
    # `high < 1e-3` guards the four-decimal cap below: an ODP- or toxicity-sized column (1e-6…1e-4)
    # would otherwise format every cell to "0.0000" — three genuinely different variants, all zeros.
    if high / low >= 1e4 or high >= 1e5 or high < 1e-3 or low < 1e-6:
        return [fmt_number(v, lang) for v in values]

    digits = max(0, min(4, 2 - int(math.floor(math.log10(high)))))
    return [fmt_number(v, lang, digits=digits) for v in values]


def fmt_number(value: float, lang: str = "en", *, digits: int | None = None) -> str:
    """Format a number for the report language.

    `digits` pins the decimals; otherwise the significant-digit behaviour of the impact scores is
    kept (compact, scientific for very large/small values) and only the separators are localised.
    """
    lc = normalise(lang)
    dec, thou = SEPARATORS[lc]

    if digits is not None:
        raw = f"{value:,.{digits}f}"
    elif value == 0:
        return "0"
    else:
        ax = abs(value)
        if ax >= 1e4 or ax < 1e-3:
            # Scientific notation carries no separators; only the decimal mark is localised. Two
            # mantissa digits: "8,70e-07" says everything an LCA figure of that size supports, where
            # "8,7000e-07" only looked precise.
            return f"{value:.2e}".replace(".", dec)
        # One significant-digit rule, whatever the magnitude: three. It used to be six digits above 1
        # and four below, so the same series printed at two precisions — a contribution table read
        # "0.549" while the sentence above it read "1.16081 kg CO2-Eq", six digits of a figure built
        # from typical values and estimated split rates. Three is what an LCA score supports and what a
        # reader can hold; a caller that genuinely needs more passes `digits`.
        #
        # Computed as decimal places rather than with "%.3g", which switches to exponent notation as
        # soon as the exponent reaches the precision — it turned 1234.5 into "1.23e+03", an ordinary
        # four-digit number written as physics. The scientific range is decided above, on purpose.
        import math

        exponent = math.floor(math.log10(ax))
        raw = f"{value:,.{max(0, 2 - exponent)}f}"
        # Trailing zeros carry no information and misrepresent what is known: a count of seven processes
        # is "7", not "7.00", and this function formats counts as well as scores. Stripped only where the
        # digits are genuinely absent — a caller that pins `digits` keeps every one of them, and the
        # per-column formatter aligns decimals within a table itself.
        if "." in raw:
            raw = raw.rstrip("0").rstrip(".")

    # Python formats as 1,234.56 — swap to the target locale via a placeholder so the two
    # separators cannot overwrite each other.
    return raw.replace(",", "\x00").replace(".", dec).replace("\x00", thou)
