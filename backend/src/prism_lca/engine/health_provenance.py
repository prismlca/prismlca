"""What a model's figures rest on — the health check's provenance count.

Two questions decide the count, and both live here: which text cites a source, and which comment is about a
figure at all. ``health`` collects the texts while it walks the model and turns the answer into a finding.
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


def cites_a_source(text: str) -> bool:
    """Whether a description or comment names where its figure comes from: a link, a DOI or a table
    of the Eurostat tool. A bare domain ("laut schubkarrenprofi.de") is not one: it names a shop, not
    the page the figure is on."""
    low = text.lower()
    return any(m in low for m in _SOURCE_MARKERS) or bool(_EUROSTAT_TABLE.search(text))


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
    """
    from prism_lca.engine import params

    try:
        rows = params.list_params(database, with_usage=False)
    except Exception as exc:  # noqa: BLE001 — an optional signal, never a reason to fail the linter
        _log.swallowed(exc, "unsourced_figures")
        return None
    texts = [str(p.get("description") or "") for p in rows]
    # A handful of parameters is not a study; the check would fire on every sketch.
    if len(texts) < 3:
        return None

    def sourced(items: list[str]) -> int:
        return sum(1 for t in items if cites_a_source(t))

    p_ok, p_all = sourced(texts), len(texts)
    c_ok, c_all = sourced(comment_texts), len(comment_texts)
    # Quiet as soon as a third of the assumptions cite something. Not a quality bar — a threshold
    # low enough that a study which does source its figures never sees this line.
    if p_ok * 3 >= p_all:
        return None
    return (
        f"Data provenance: {p_ok} of {p_all} parameters and {c_ok} of {c_all} process/exchange "
        "comments contain a source (a link, a DOI or a table code of the Eurostat tool; structural "
        "links and dormant scenario switches are not counted); the rest are figures this model states "
        "without saying where they come from. That is a legitimate way to run a SCREENING study, "
        "and it is not what a reader assumes unless the study says so. Either research the ones "
        "that carry the result and cite them (research_bom for a composition, research_web for a "
        "rate or a factor), or record in the goal and in the limitations that the inventory rests "
        "on typical industry values. Which figures carry the result is what explain_result tells "
        "you — start there rather than sourcing everything."
    )
