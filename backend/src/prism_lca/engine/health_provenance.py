"""What a model's figures rest on — the health check's provenance count.

Three questions decide the count, and all live here: which text cites a source, which parameter or comment
is about a figure at all, and how much of the model the sourced figures carry. ``health`` collects the
texts while it walks the model and turns the answer into a finding.
"""
from __future__ import annotations

import math
import re
from collections.abc import Mapping

from prism_lca import _log

#: What counts as a source, in any language: a link or a DOI. Deliberately not a word list — "laut
#: Hersteller", "per the datasheet" and "typical" are prose, and a check that tried to read prose
#: would be wrong in both directions. A URL is unambiguous, and it is what the report prints.
_SOURCE_MARKERS = ("http://", "https://", "doi:", "doi.org")

#: The tables of the app's own Eurostat tool (`eurostat_eol`). A figure taken from it is cited by its
#: table code — "Eurostat env_waspac W150101, DE 2024" names one table, one country and one year as
#: exactly as a link would — and a model that used the tool writes it that way rather than a URL. A
#: closed list of codes the product itself hands out, not a guess at what a source looks like; the
#: frontend's `main/eurostat/datasets.ts` defines them, and a test holds the two lists together.
EUROSTAT_TABLES = ("env_wasoper", "env_wastrt", "env_waspac", "env_wasmun")
_EUROSTAT_TABLE = re.compile(r"\b(?:" + "|".join(EUROSTAT_TABLES) + r")\b", re.IGNORECASE)

#: A page address written without its scheme — `kox-direct.de/garten/zubehoer-schubkarren/holzgriff`.
#: It names the page the figure is on as exactly as the link would, and models copy addresses out of
#: search results that way. Domain labels, a top-level domain of letters, a slash and at least one
#: character of path; not inside a word, an e-mail address or a longer address (the lookbehind).
_PAGE_ADDRESS = re.compile(r"(?<![\w@./-])(?:[^\W_][\w-]*\.)+[^\W\d_]{2,}/[^\s,;)\]]+")


def cites_a_source(text: str) -> bool:
    """Whether a description or comment names where its figure comes from: a link, a page address, a
    DOI or a table of the Eurostat tool. A bare domain ("laut schubkarrenprofi.de") is not one: it
    names a shop, not the page the figure is on."""
    low = text.lower()
    return (
        any(m in low for m in _SOURCE_MARKERS)
        or bool(_EUROSTAT_TABLE.search(text))
        or bool(_PAGE_ADDRESS.search(text))
    )


#: A number written into a formula: not part of a name (`m_film2`), not the tail of another number.
_NUMBER = re.compile(r"(?<![\w.])(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")


def _literal(formula: object) -> bool:
    """True when there is no formula, or the formula is only a number (`"1"`): nothing a parameter
    could move, so the amount is what was typed."""
    text = str(formula or "").strip()
    if not text:
        return True
    try:
        float(text)
    except ValueError:
        return False
    return True


def _own_figure(formula: object) -> bool:
    """Whether a formula holds a figure of its own — a number other than 0, 1 or a power of ten.

    `250 * use_sea_freight` carries a distance that no parameter describes, so the exchange comment is
    the only place its source can stand. `m_tray * share_eaf`, `m / (1 - loss) * share` and
    `(m_total + m_box) / 1000 * d_sea * share_sea` carry none: one and zero are arithmetic, and a
    power of ten is a unit conversion (kg to t, a percentage).
    """
    for match in _NUMBER.finditer(str(formula or "")):
        value = abs(float(match.group(0)))
        if value == 0:
            continue
        exponent = math.log10(value)
        if not math.isclose(exponent, round(exponent), abs_tol=1e-9):
            return True
    return False


def carries_a_figure(exchange: Mapping, database: str, unit: str) -> bool:
    """Whether an exchange's quantity is a figure that could cite a source — so its comment belongs
    in the provenance count. ``unit`` is the unit the exchange is measured in (its provider's).

    Three kinds of exchange cannot have a source, and counted they made a well-documented model look
    undocumented — 17 of a wheelbarrow model's 48 comments were one of them:

    - **the reference flow**: a production exchange of one, typed — the process's own normalisation.
    - **a structural link**: exactly one piece of the model's own process ("1 tray per
      wheelbarrow"), typed rather than computed. The quantity is the product's structure, not a
      measurement. A piece is a unit that measures nothing physical — "unit", or one this app has no
      dimension for ("Stück", "Pack", "pair"); one kilogram or one kilowatt hour of an own process
      is a physical quantity and still counts, as does any other amount or a formula.
    - **a dormant switch**: an exchange whose amount is zero in the baseline — a scenario branch.
      Its figures sit in the parameters that switch it, which are counted on their own — unless the
      formula carries a figure of its own (`_own_figure`), which then has nowhere else to be cited.
    """
    from prism_lca.engine.dataimport.units import dimension

    try:
        amount = float(exchange.get("amount") or 0)
    except (TypeError, ValueError):
        return True
    formula = exchange.get("formula")
    if amount == 0:
        return _own_figure(formula)
    if abs(amount) != 1 or not _literal(formula):
        return True
    if exchange.get("type") == "production":
        return False
    key = exchange.get("input")
    own = bool(key) and tuple(key)[0] == database
    return not (own and dimension(unit) in ("", "count"))


#: A name in a formula — a parameter, or a function when a parenthesis follows (`max(…)`), which is
#: not one. Matched once the numbers are out, so `1e3` is not read as the name `e3`.
_NAME = re.compile(r"(?<![\w.])[^\W\d]\w*(?!\w|\s*\()")


def _states_a_figure(param: Mapping) -> bool:
    """Whether a parameter holds a figure of its own: typed, written as a constant expression
    (`10 / 100`), or computed from others with a number of its own in the formula.

    `1 - eol_steel_recycling` and `m_total - m_boards` hold none — their figure is their inputs',
    which are counted on their own. Counted as well, every end-of-life rate written with its
    complement counted twice: eight sourced rates of a wheelbarrow model were four figures.
    """
    formula = param.get("formula")
    if _literal(formula) or not _NAME.search(_NUMBER.sub(" ", str(formula))):
        return True
    return _own_figure(formula)


def _kilograms(param: Mapping) -> float:
    """The mass a parameter states, in kilograms; 0 for one not measured in a unit of mass."""
    from prism_lca.engine.dataimport.units import dimension, rescale

    unit = str(param.get("unit") or "")
    if dimension(unit) != "mass":
        return 0.0
    try:
        return abs(float(param.get("amount") or 0)) * rescale(unit, "kg").factor
    except (TypeError, ValueError):
        return 0.0


def unsourced_figures(database: str, comment_texts: list[str]) -> str | None:
    """Says how much of the model rests on figures that cite nothing — or None when enough of it does.

    A wall-paint run built a complete cradle-to-grave model on 20 parameters, fourteen
    of whose descriptions begin with the word "ANNAHME", and **one** URL in the whole study — the one
    the user had pasted into the prompt. No research tool was called; the density, the recipe and the
    titanium-dioxide share all came out of the model's memory. Every check passed, because none of
    them asks what the numbers rest on. The assistant named this the largest accuracy loss of the run
    when asked afterwards, which is late.

    A screening study on typical values is perfectly legitimate — the point is that it should be
    stated, not discovered. So this counts rather than judges, and reports as ``info``.
    ``comment_texts`` holds the process comments and the comments of exchanges that carry a figure
    (`carries_a_figure`).

    A count weighs every parameter the same, and end-of-life rates are many and cheap to cite: one
    call of the Eurostat tool returns a rate per material, each with its table code, and eight of
    them silenced the count on a wheelbarrow model whatever its masses cited. So the count is backed
    by the masses, weighed in kilograms: a product model rests on its bill of materials, and the masses set
    the scale of its material, processing, transport and disposal flows — the rates only split them.
    Totals and the parts they are made of both count, which is coarse and fine for a third.
    """
    from prism_lca.engine import params

    try:
        rows = params.list_params(database, with_usage=False)
    except Exception as exc:  # noqa: BLE001 — an optional signal, never a reason to fail the linter
        _log.swallowed(exc, "unsourced_figures")
        return None
    figures = [p for p in rows if _states_a_figure(p)]
    # A handful of figures is not a study; the check would fire on every sketch.
    if len(figures) < 3:
        return None

    cited = [cites_a_source(str(p.get("description") or "")) for p in figures]
    p_ok, p_all = sum(cited), len(figures)
    c_ok, c_all = sum(1 for t in comment_texts if cites_a_source(t)), len(comment_texts)
    kilograms = [_kilograms(p) for p in figures]
    m_all = sum(kilograms)
    m_ok = sum(kg for kg, ok in zip(kilograms, cited, strict=True) if ok)
    # Quiet as soon as a third of the figures cite something, and a third of the mass. Not a quality
    # bar — a threshold low enough that a study which does source its figures never sees this line.
    by_count = p_ok * 3 >= p_all
    by_mass = m_all <= 0 or m_ok * 3 >= m_all
    if by_count and by_mass:
        return None
    masses = ""
    if m_all > 0:
        masses = (
            f", and {int(100 * m_ok / m_all)} percent of the mass (the kilograms of all mass parameters, "
            "added up) is in parameters that cite one"
        )
    if by_count:  # the count alone would have stayed quiet: say what is missing
        masses += (
            ". Sources elsewhere do not stand in for the masses, which set the scale of the material, "
            "processing, transport and disposal flows; rates and shares only split them"
        )
    return (
        f"Data provenance: {p_ok} of {p_all} parameters and {c_ok} of {c_all} process/exchange "
        "comments contain a source (a link or page address, a DOI or a table code of the Eurostat "
        "tool; parameters computed from others, structural links and dormant scenario switches are not "
        f"counted){masses}. A figure without a source is one this model states without saying where it "
        "comes from. That is a legitimate way to run a SCREENING study, "
        "and it is not what a reader assumes unless the study says so. Either research the ones "
        "that carry the result and cite them (research_bom for a composition, research_web for a "
        "rate or a factor), or record in the goal and in the limitations that the inventory rests "
        "on typical industry values. Which figures carry the result is what explain_result tells "
        "you — start there rather than sourcing everything."
    )
