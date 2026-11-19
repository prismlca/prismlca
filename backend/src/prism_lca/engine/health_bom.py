"""The health check's bill-of-materials entry: the part masses the research has on record, for whoever holds
them against the model.

The bill-of-materials researcher finds a part, sources its mass and logs it; the modeller then builds from the
answer. Nothing ties a logged part to the exchange that books it — an exchange carries a unit, an amount and a
formula, and no word of which part it is — so this module does not decide whether a part is booked. A check
that matched figures did decide, and was wrong both ways: a paint exchange of 0.2 kg answered for 0.2 kg of
ground pegs, two namesakes were silenced by one booking, and timber booked by the cubic metre was reported as
missing.

What it gives instead is one info entry per model (``bom_research_on_record``): every recorded part mass with
the product it was researched for and its source — the evidence a modeller or a reviewer holds against the
model — and the plain statement that the check compared nothing. No row is ever left out because a number in
the model resembles it.

One observation rides on a row: a mass parameter that holds the row's value and from which no formula leads to
a positive input other than transport, energy or time. That is how a part researched and then left out remains
in a model built with one parameter per part — on a pavilion run the ground pegs' 0.2 kg sat in the shipping
weight and in a dormant end-of-life branch, and in no production exchange. It is a statement about the
parameter, not a verdict on the part: a part booked without its parameter (typed in as a volume) carries the
remark as well, a parameter of another part that happens to hold the value can draw it, and a row without a
remark has not been found in the model.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from urllib.parse import unquote, urlsplit

from prism_lca import _log
from prism_lca.engine import units as units_of

#: (unit, evaluated amount, formula) of one technosphere exchange, as the caller's pass over the model collects them.
Exchange = tuple[str, float, str]

#: What an exchange measures when it buys something done TO a part rather than the part itself: hauling it
#: (tkm), powering its making (kWh, MJ), running a machine for it (hours). A part's mass reaches such an amount
#: wherever the model sums the parts into a shipping weight and carries that — and a part that sits only in the
#: shipping weight was produced nowhere. Volume, area, length and pieces may be the part: timber is bought by
#: the cubic metre, boards by the square metre, cable by the metre.
_SERVICE_DIMENSIONS = frozenset({"transport", "energy", "time"})

_BOM_QUESTION = "Bill of materials: "

#: Bill-of-materials entries logged before the masses were stored structured: the tool has always written
#: "component (material): 9 kg" into the finding text.
_BOM_TEXT = re.compile(r"^(.+?):\s*([0-9]+(?:\.[0-9]+)?)\s*kg\s*$")

#: How close a parameter has to be to a recorded mass to hold "this value": the same figure up to the digits a
#: unit conversion costs (200 g against 0.2 kg), never a neighbouring mass.
_SAME_VALUE = 1e-3

#: Rows one entry prints. A model's research is a handful of calls of two to eight parts; beyond this the
#: oldest rows are counted, not printed, and the entry says so.
MAX_ROWS = 60
#: Same-valued parameters one row names.
_NAMED_PARAMETERS = 3

_LABEL_CHARS = 110
_PRODUCT_CHARS = 90


@dataclass(frozen=True)
class _Row:
    """One recorded part mass: a finding of a bill-of-materials call, not necessarily a part of its own."""

    product: str
    asked: str
    label: str
    mass: float
    finding: dict = field(compare=False)


@dataclass(frozen=True)
class OnRecord:
    """What the health check says about the research: the entry's text, how many part masses the log holds and
    the remarks alone — each one readable without its row, for a reader who has the rows elsewhere."""

    message: str
    parts: int
    remarks: list[str]


def _cap(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


#: How the research tool closes a label whose mass covers several pieces.
_PIECES = re.compile(r"\s*\(\d+ pieces\)$")


def _label(text: str) -> str:
    """A part's label cut to length, keeping the number of pieces it ends on: without it a reader cannot tell
    the mass of a set from the mass of one piece."""
    text = " ".join(text.split())
    pieces = _PIECES.search(text)
    if not pieces or len(text) <= _LABEL_CHARS:
        return _cap(text, _LABEL_CHARS)
    return _cap(text[: pieces.start()], _LABEL_CHARS - len(pieces.group())) + pieces.group()


def _recorded(database: str) -> list[_Row]:
    """Every part mass the research log holds, in the order of the log. Nothing is merged: the same name
    researched for two products is two rows, and so is a part researched twice with another figure."""
    from prism_lca.engine.research_log import ResearchLogStore

    rows: list[_Row] = []
    for entry in ResearchLogStore().list(database):
        question = " ".join(str(entry.get("question") or "").split())
        of_bom = question.startswith(_BOM_QUESTION)
        product = question.removeprefix(_BOM_QUESTION)
        asked = str(entry.get("asked") or "")[:10]
        for finding in entry.get("findings") or []:
            text = str(finding.get("text") or "").strip()
            written = _BOM_TEXT.match(text)
            component = str(finding.get("component") or "").strip()
            mass = finding.get("mass_kg")
            if component and isinstance(mass, (int, float)) and not isinstance(mass, bool):
                # The text names material and number of pieces beside the component; the mass is the stored one.
                label = written.group(1) if written else component
            elif of_bom and written:
                label, mass = written.group(1), float(written.group(2))
            else:
                continue
            if mass <= 0 or not math.isfinite(mass):
                continue
            rows.append(_Row(product, asked, _label(label), float(mass), finding))
    return rows


def _source_id(url: str) -> str:
    """Host plus the last path segment: two pages of one retailer are two sources."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return url[:40]
    host = (parts.hostname or "").removeprefix("www.")
    if not host:
        return url[:40]
    last = [s for s in parts.path.split("/") if s]
    return f"{host}/{unquote(last[-1])[:40]}" if last else host


def _row_line(row: _Row) -> str:
    f = row.finding
    rng = f.get("mass_range_kg")
    others = [v for v in f.get("alternatives_kg") or [] if isinstance(v, (int, float)) and not isinstance(v, bool)]
    judged = "/".join(str(f[k]) for k in ("source_class", "confidence") if f.get(k))
    sources = list(dict.fromkeys(_source_id(str(s)) for s in f.get("sources") or [] if str(s).strip()))
    return "".join(
        [
            f"- {row.label}: {row.mass:g} kg",
            f" (range {rng[0]:g}–{rng[1]:g} kg)" if isinstance(rng, (list, tuple)) and len(rng) == 2 else "",
            f" (version: {_cap(str(f['version']), 80)})" if f.get("version") else "",
            # Other figures the research found for the same part — a variant, a second source. Never a further
            # mass to book: the part is in the model once, at whichever figure the sources carry.
            f" (alternatives found: {', '.join(f'{v:g} kg' for v in others)})" if others else "",
            f" [{judged}]" if judged else "",
            f" — {', '.join(sources)}" if sources else "",
        ]
    )


def _may_be_the_part(unit: str) -> bool:
    """Whether an input in ``unit`` can be a part. A unit we have no dimension for counts: unknown is no
    evidence of a service."""
    from prism_lca.engine.dataimport.units import dimension

    return dimension(unit) not in _SERVICE_DIMENSIONS


def _mass_parameters(stored: list[dict]) -> list[tuple[str, float]]:
    """(name, kg) of every parameter that holds a mass with a positive value.

    A mass, or a mass per something counted — "kg/piece", "kg/Regal" is how a part's mass per product is
    declared. A mass per square metre, per kilogram or per year is a rate, a share or a flow: its number may
    equal a part's mass and still has nothing to do with it.
    """
    from prism_lca.engine.dataimport.units import dimension

    placed = units_of.base(1.0, "kg")
    if placed is None:  # pragma: no cover — kg is always convertible
        return []
    mass_family = placed[0]
    out: list[tuple[str, float]] = []
    for param in stored:
        name, amount = str(param.get("name") or ""), param.get("amount")
        if not name or not isinstance(amount, (int, float)) or isinstance(amount, bool) or not amount:
            continue
        unit, _, per = str(param.get("unit") or "").partition("/")
        if dimension(per.strip()) not in ("", "count"):
            continue
        placed = units_of.base(float(amount), unit.strip())
        if placed and placed[0] == mass_family and placed[1] > 0:
            out.append((name, placed[1]))
    return out


def _leads_nowhere(stored: list[dict], name: str, exchanges: list[Exchange]) -> str | None:
    """Where parameter ``name`` leads when no formula takes it to a positive input that may be a part, or None
    when one does.

    Read from the names in the formulas — the parameter itself and every parameter derived from it — and from
    each reached exchange's unit and evaluated amount. Which way an amount moves is not asked: a figure that is
    subtracted on its way (``rest = total - part``) still leads to the input that uses the rest, and draws no
    remark. That errs towards saying nothing, which is the side a remark may err on.
    """
    from prism_lca.engine.param_references import names_in
    from prism_lca.engine.params import downstream_of

    reach = downstream_of(stored, name)
    reached = [(unit, amount) for unit, amount, formula in exchanges if formula and reach & names_in(formula)]
    if any(amount > 0 and _may_be_the_part(unit) for unit, amount in reached):
        return None
    where: list[str] = []
    services = sorted({unit for unit, amount in reached if amount > 0})
    if services:
        where.append(f"inputs in {', '.join(services)}")
    if any(amount < 0 for _unit, amount in reached):
        where.append("negative amounts (waste or end of life)")
    if any(not amount for _unit, amount in reached):
        where.append("amounts that evaluate to zero")
    return f"it leads to {'; '.join(where)}" if where else "no exchange formula uses it"


def _remark(row: _Row, mass_params: list[tuple[str, float]], stored: list[dict], exchanges: list[Exchange]) -> str:
    """The remark for one row, or '' — one sentence per same-valued parameter that leads to no candidate input."""
    said: list[str] = []
    for name, value in mass_params:
        if not math.isclose(value, row.mass, rel_tol=_SAME_VALUE):
            continue
        where = _leads_nowhere(stored, name, exchanges)
        if where is not None:
            said.append(
                f"parameter '{name}' has this value, and no formula leads from it to a positive input other "
                f"than transport, energy or time ({where})"
            )
        if len(said) == _NAMED_PARAMETERS:
            break
    return "; ".join(said)


def _head(parts: int) -> str:
    masses = "1 part mass" if parts == 1 else f"{parts} part masses"
    return (
        f"The bill-of-materials research has {masses} on record for this model, listed below. This check "
        "compares none of them with the model: a row without a remark has NOT been found in the model, and a "
        "remark says where a parameter leads, not that a part is missing. Hold the rows against the model when "
        "you build from the research or review the model; once that is done, this entry needs nothing more — it "
        "stays for as long as the research is on record. Every part is either in the model — on its own, inside "
        "another part, split over several inputs, or booked as pieces, a volume or an area; judge by the amounts "
        "and the sources, not by comments — or left out where the study's cut-off criteria allow it and named "
        "where the study records its cut-off decisions. A part that is in the model in full needs nothing added, "
        "and a loss allowance or a rounding on top of the researched mass is modelling, not a difference. Where "
        "its mass differs by more than that, or its product version differs from the research, settle which is "
        "right from the sources — ask the user when they do not decide it — and say why in the process comment. "
        "Rows are records, not "
        "parts: a part researched twice, or found in two versions, is still one part. A row's mass is that of "
        "all its pieces together."
    )


def research_on_record(database: str, exchanges: list[Exchange]) -> OnRecord | None:
    """The health check's entry on the bill-of-materials research, or None when the log holds no part mass.

    ``exchanges`` is (unit, evaluated amount, formula) per technosphere exchange, collected by the caller's
    pass over the model; it is read for the remarks only.
    """
    from prism_lca.engine.params import list_params

    rows = _recorded(database)
    if not rows:
        return None
    try:
        stored = list_params(database, with_usage=False)
    except Exception as exc:  # noqa: BLE001 — a linter must not fall over on an unreadable parameter file
        _log.swallowed(exc, "research_on_record")
        stored = []
    mass_params = _mass_parameters(stored)

    shown = rows[-MAX_ROWS:]
    lines: list[str] = [_head(len(rows))]
    if len(shown) < len(rows):
        lines.append(
            f"({len(rows) - len(shown)} earlier part masses are on record and not listed here; the "
            f"{len(shown)} most recent follow.)"
        )
    remarks: list[str] = []
    product: str | None = None
    for row in shown:
        if row.product != product:
            product = row.product
            dates = list(dict.fromkeys(r.asked for r in shown if r.product == product and r.asked))
            asked = f" (asked {', '.join(dates)})" if dates else ""
            lines.append(f"For '{_cap(product, _PRODUCT_CHARS)}'{asked}:")
        lines.append(_row_line(row))
        remark = _remark(row, mass_params, stored, exchanges)
        if remark:
            lines.append(f"    Remark: {remark}.")
            remarks.append(f"'{row.label}' ({row.mass:g} kg): {remark}.")
    return OnRecord("\n".join(lines), len(rows), remarks)
