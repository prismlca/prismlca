"""Model-health linter (ADR-005 guardrail layer).

A read-only sweep over a foreground database that surfaces the structural problems that
make a model wrong or uncomputable *before* the user hits Calculate — the class of issue
openLCA hides behind opaque "does not link" errors. Every finding says what and where and,
via its ``code``, why. Pure inspection: no writes, no command bus.

Severities:
  * ``error``   — the model is wrong or will not compute (unlinked input, no/again-too-many
                  reference products, zero production amount, an interrupted scenario window whose
                  overrides may still be sitting in the parameters).
  * ``warning`` — suspicious but sometimes legitimate (self-loop, circular reference, a process
                  nothing consumes, a process reached twice through the reference process).
  * ``info``    — worth knowing, not a defect (negative production = treatment activity,
                  duplicate identity, a parameter nothing refers to).

Most findings sit on an activity. A few are about the model rather than any one process — an
unused parameter has no activity to point at, so ``activity`` is ``None`` and the subject is named
in a field of its own.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

from prism_lca import _log
from prism_lca.engine import units as units_of
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.health_phases import _phase_findings
from prism_lca.engine.health_structure import two_ways_in, unreached
from prism_lca.engine.model import _db_or_404
from prism_lca.engine.tags import TagStore

_SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}

#: A dataset that produces recycled material — name or reference product says so. Deliberately
#: narrow: "recycl" catches recycling/recycled/recyclate across the ecoinvent vocabulary, and the
#: finding it feeds is additionally gated on the buyer's end-of-life tag.
_RECYCLATE_RE = re.compile(r"recycl", re.IGNORECASE)

#: An end-of-life phase tag, whatever the tag dimension is called and in the languages models
#: actually write ("End-of-Life", "EoL", "Entsorgung", "disposal").
_EOL_TAG_RE = re.compile(r"end[\s_-]*of[\s_-]*life|\beol\b|entsorgung|disposal", re.IGNORECASE)


def _resolve(bd, key) -> object | None:
    """Return the activity a stored exchange key points at, or None if it doesn't link."""
    if not key:
        return None
    try:
        return bd.get_node(database=key[0], code=key[1])
    except Exception as exc:
        _log.swallowed(exc, "_resolve")
        return None


def _provider_production(act) -> float:
    """First non-zero production amount of a provider (negative = treatment activity)."""
    try:
        for ex in act.production():
            amt = float(ex["amount"])
            if amt != 0.0:
                return amt
    except Exception as exc:  # pragma: no cover - defensive against odd datasets
        _log.swallowed(exc, "_provider_production")
    return 1.0


def _find_cycles(adjacency: dict) -> list[list]:
    """Detect directed cycles in the foreground technosphere graph (excluding self-loops,
    which are reported separately). Returns each cycle once as a list of activity keys."""
    cycles: list[list] = []
    seen_cycles: set[frozenset] = set()
    WHITE, GREY, BLACK = 0, 1, 2
    color = {node: WHITE for node in adjacency}

    def visit(node, stack):
        color[node] = GREY
        stack.append(node)
        for nxt in adjacency.get(node, ()):  # noqa: B007
            if nxt == node:
                continue  # self-loop handled elsewhere
            if nxt not in color:
                continue  # points outside the graph slice
            if color[nxt] == GREY:
                cyc = stack[stack.index(nxt):]
                fp = frozenset(cyc)
                if fp not in seen_cycles:
                    seen_cycles.add(fp)
                    cycles.append(list(cyc))
            elif color[nxt] == WHITE:
                visit(nxt, stack)
        stack.pop()
        color[node] = BLACK

    for node in adjacency:
        if color[node] == WHITE:
            visit(node, [])
    return cycles


#: Units this check can add up, in kilograms. Anything else — kWh, m3, unit, kg*year — is a different
#: quantity and is left out of the sum rather than guessed at.
_MASS_IN_KG = {
    "kg": 1.0, "kilogram": 1.0, "kilograms": 1.0,
    "g": 0.001, "gram": 0.001, "grams": 0.001,
    "mg": 1e-6,
    "t": 1000.0, "ton": 1000.0, "tonne": 1000.0, "tonnes": 1000.0, "metric ton": 1000.0,
}

#: How far below its own product a process's mass inputs may fall before this says anything. Wide on
#: purpose: the point is to catch a process that declares a kilogram and was filled with a tenth of one,
#: not to audit anybody's arithmetic.
_MASS_SHORTFALL = 0.5

#: Physical quantity per unit string, for the dimension check below. Only the families where a
#: mix-up silently rescales a result; anything unlisted is "unknown" and is never reported.
_QUANTITY = {
    "kg": "mass", "kilogram": "mass", "kilograms": "mass", "g": "mass", "gram": "mass",
    "grams": "mass", "mg": "mass", "t": "mass", "ton": "mass", "tonne": "mass",
    "tonnes": "mass", "metric ton": "mass",
    "m3": "volume", "cubic meter": "volume", "cubic metre": "volume", "l": "volume",
    "litre": "volume", "liter": "volume", "ml": "volume",
    "kwh": "energy", "mj": "energy", "wh": "energy", "megajoule": "energy",
    "kilowatt hour": "energy",
    "m2": "area", "square meter": "area", "square metre": "area", "ha": "area", "hectare": "area",
    "m": "length", "meter": "length", "metre": "length", "km": "length", "kilometer": "length",
    "kilometre": "length",
    "tkm": "freight", "ton kilometer": "freight", "metric ton kilometer": "freight",
    "pkm": "passenger transport", "person kilometer": "passenger transport",
}

#: A bare parameter reference: the whole formula is one name, so no conversion factor is in play.
_BARE_PARAM = re.compile(r"^\s*-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*$")


def _dimension_note(ex: dict, provider_unit: str, param_units: dict[str, str]) -> str | None:
    """Flag an amount driven *directly* by a parameter whose unit is a different physical quantity
    from the dataset it feeds — or None.

    The failure this catches is invisible to every other check: an exchange amount is expressed in
    the provider's unit, so a figure the modeller thought of in kilograms, pointed at a dataset
    measured in cubic metres, is simply wrong by a density and nothing complains. `check_model_health`
    reported it as a healthy model.

    Narrow on purpose — it fires ONLY when the formula is a single parameter name. The moment there is
    any arithmetic (``-mass_solution / 1000``) a conversion may be exactly what that arithmetic is
    for, and a checker that cannot tell the two apart would flag correct models and be switched off.
    """
    formula = (ex.get("formula") or "").strip()
    if not formula:
        return None
    m = _BARE_PARAM.match(formula)
    if not m:
        return None
    pu = _QUANTITY.get(param_units.get(m.group(1), "").strip().lower())
    du = _QUANTITY.get((provider_unit or "").strip().lower())
    if not pu or not du or pu == du:
        return None
    return (
        f"Amount is driven directly by parameter '{m.group(1)}' "
        f"({param_units.get(m.group(1))}, a {pu}), but the input is measured in "
        f"'{provider_unit}' (a {du}). An exchange amount is always in the input's unit, so either "
        "the parameter is the wrong one or the formula is missing its conversion factor."
    )


def _mass_note(bd, act, exchanges: list) -> tuple[str, float, float] | None:
    """A gentle note when a mass-based process has far less mass going in than coming out — or None.

    This exists because of a real, expensive miss: a foreground process declared **1 kg** of film and
    its inputs were filled with the mass of a whole roll (0.43 kg), so the demand was applied twice and
    the study came out a factor of two too low. `check_model_health` said 0 errors, 0 warnings.

    It is deliberately a hint and nothing stronger, because mass is *not* conserved in plenty of honest
    processes. Agriculture is the clearest case — photosynthesis takes carbon out of the air, so a
    tonne of wheat needs nowhere near a tonne of inputs — and the same goes for water uptake and
    mineral extraction. Those are recognisable: they draw a natural-resource flow from the biosphere,
    and wherever one is present this says nothing at all. The other direction, mass *leaving* (drying,
    combustion, losses), is never mentioned either: it is routine and explained by emissions.

    So the note fires only when mass appears out of nowhere, in a process that claims no environmental
    source for it — and even then it asks rather than asserts.
    """
    production = [e for e in exchanges if e.get("type") == "production" and (e.get("amount") or 0)]
    if len(production) != 1:
        return None  # a cardinality problem of its own, already reported
    made = float(production[0].get("amount") or 0)
    if made <= 0:
        return None  # treatment activity: the convention inverts, and waste in is the product
    unit = str(act.get("unit") or "").strip().lower()
    if unit not in _MASS_IN_KG:
        return None
    made_kg = made * _MASS_IN_KG[unit]

    inputs_kg = 0.0
    counted = 0
    for ex in exchanges:
        kind = ex.get("type")
        amount = float(ex.get("amount") or 0)
        if not amount:
            continue
        inp = _resolve(bd, ex.get("input"))
        if inp is None:
            continue
        if kind == "biosphere":
            # Anything drawn from the environment can be the missing mass. Present = say nothing.
            cats = inp.get("categories") or ()
            if cats and str(cats[0]) == "natural resource":
                return None
            continue
        if kind != "technosphere" or amount < 0:
            continue  # a negative technosphere amount leaves the process; it is not an input
        iu = str(inp.get("unit") or "").strip().lower()
        if iu in _MASS_IN_KG:
            inputs_kg += amount * _MASS_IN_KG[iu]
            counted += 1

    if not counted or inputs_kg >= made_kg * _MASS_SHORTFALL:
        return None
    text = (
        f"Mass in ({inputs_kg:g} kg over {counted} input{'s' if counted != 1 else ''}) is well under "
        f"mass out ({made_kg:g} kg). Often that is fine — growth, water or mineral uptake all add mass "
        "from the environment, and this process names none. Worth a glance if it was meant to balance: "
        "a per-kilogram process holding a whole product's worth of inputs computes the demand twice."
    )
    # The numbers ride along so the caller can recognise the sharper shape: a consumer that demands
    # exactly the inputs' mass of this under-filled process (see mass_scaled_demand in lint_database).
    return text, made_kg, inputs_kg


def _unused_parameters(database: str) -> list[tuple[str, str]]:
    """Parameters from which no exchange formula can be reached, following the chain of parameters.

    Two shapes, one question. The plain one is a leftover: a figure that was parameterised, then
    superseded or hard-coded back into an amount, and the name stayed. The other one hides: a
    parameter that IS referenced — by another parameter — whose chain then runs into a dead end. It
    reads as used, it is printed as an assumption, and it cannot move a single number.

    Both are ``info``: a model with a spare name is untidy, not wrong. But the second one is worth
    naming precisely, because the reader's next question is "then what was it for?", and the answer
    is the terminus. A balcony-solar model had six of them behind one leaf, and three
    of its four scenarios were built on them (V233).

    **The remedy is three options, in order, and "delete it" is the last of them.** It used to be
    "delete it, or use it", which is wrong for the one case that is not a leftover at all: under the
    cut-off convention a recycled share leaves the system burden-free — it has no exchange *by
    design* — so a sourced EPA figure was being recommended for deletion out of the report's
    parameter table. Two models were measured against the old wording: one rewrote
    every split as `1 - a - b` and called it "faking usage" in its own critique, the other invented
    an `eol_total = a + b + c` parameter that nothing consumes either, so it would have been the
    same finding one row further down plus a meaningless line in the report (V278).

    The verdict does not move. A share nothing can reach really cannot change a result, and a
    scenario on it really does return the baseline — that half is exactly what V233 was. What
    changed is that the message now names the shape that fixes it, which is also the better model:
    written as the remainder, the parts are guaranteed to sum to 1. The EPA rates in that run added
    up to 100.1 %.
    """
    from prism_lca.engine import params

    dead = params.unreachable_parameters(database)
    out: list[tuple[str, str]] = []
    for name in sorted(dead):
        termini = dead[name]
        if not termini:
            out.append(
                (
                    name,
                    f"Parameter '{name}' is referenced by no exchange formula and by no other "
                    "parameter, so changing it cannot change any result and a scenario built on it "
                    "returns the baseline. Three ways out, in this order. (1) If it records a share "
                    "of a SPLIT whose other parts you did model — an end-of-life fate under cut-off "
                    "is the usual case, where the recycled share leaves burden-free and carries no "
                    "exchange by design — then write the part you DID model as the REMAINDER: give "
                    f"it the formula \"1 - {name} - <the other shares>\" instead of a typed number. "
                    "The share is then real input to a result, a scenario on it works, and the parts "
                    "are guaranteed to sum to 1. (2) If it belongs in a formula that simply does not "
                    "reference it yet, put it there. (3) If it is a leftover from an earlier "
                    "version, delete it. Do NOT invent a parameter that merely adds the shares up: "
                    "nothing would consume that either, and it would stand in the report's "
                    "parameter table as an assumption the study does not rest on.",
                )
            )
        else:
            ends = ", ".join(f"'{t}'" for t in termini)
            out.append(
                (
                    name,
                    f"Parameter '{name}' looks used — another parameter refers to it — but the "
                    f"chain ends at {ends}, which no exchange formula uses. So changing '{name}' "
                    "cannot change any result, and a scenario built on it returns the baseline. "
                    "Either give the chain an exchange to land on, or delete the branch.",
                )
            )
    return out


def _unrecorded_scope(database: str) -> str | None:
    """The ISO 14044 §5.2 fields this study leaves empty, as one sentence — or None if it records them.

    The report's scope panel says the same thing, and the assistant never reads it: it has no report
    tools and no reason to open the page. The health check is the one report it runs by itself, so
    this is where it finds out — and it can act on it, because `model_info` action="set" takes every
    one of these fields. In the run that prompted this, five of the six were left empty by an
    assistant that had used the same tool to set the functional unit an hour earlier.
    """
    from prism_lca.engine.study import StudyMetaStore, unrecorded_scope

    missing = [label for _key, label in unrecorded_scope(StudyMetaStore().get(database))]
    if not missing:
        return None
    review = (
        " An empty critical review is a legitimate answer, but record it as one instead of leaving "
        "the field blank."
        if "critical review" in missing
        else ""
    )
    return (
        f"The study records no {', no '.join(missing)}. ISO 14044 §5.2 expects a report to state "
        "them, and the report's goal-and-scope chapter is written from these fields — an empty one "
        "becomes \"not defined\" in the document. Set them with `model_info` action=\"set\"; ask the "
        f"user where the answer is theirs to give rather than inventing one.{review}"
    )


#: What counts as a source, in any language: a link or a DOI. Deliberately not a word list — "laut
#: Hersteller", "per the datasheet" and "typical" are prose, and a check that tried to read prose
#: would be wrong in both directions. A URL is unambiguous, and it is what the report prints.
_SOURCE_MARKERS = ("http://", "https://", "doi:", "doi.org")


#: ecoinvent's shaping services, by the word that identifies them. Small and closed on purpose: this
#: is a name comparison against a known vocabulary, not a guess about what a dataset is.
_FORMING_SERVICES = (
    "rolling",
    "drawing",
    "moulding",
    "molding",
    "extrusion",
    "extruding",
    "casting",
    "forging",
    "stamping",
    "metal working",
    "calendering",
    "thermoforming",
    "machining",
    "welding",
    "punching",
    "coating",
    "coat, pieces",
)
#: Bulk materials that reach a product only through one of the services above.
_SHAPEABLE_MATERIALS = (
    "steel",
    "aluminium",
    "copper",
    "brass",
    "zinc",
    "polyethylene",
    "polypropylene",
    "polystyrene",
    "polycarbonate",
    "polyvinyl chloride",
    "abs copolymer",
    "nylon",
    "polyamide",
    "polyethylene terephthalate",
)
#: …unless the dataset's own name already says it has been shaped. `steel, low-alloyed, hot rolled`
#: carries its rolling; `steel, unalloyed` does not. Every entry earned its place against a real
#: model: `packaging film, low density polyethylene` in a wall-paint model is a finished
#: film and was the one false positive of the first draft.
_ALREADY_SHAPED = (
    "rolled",
    "extruded",
    "cast",
    "sheet",
    "foil",
    "film",
    "foam",
    "slab",
    "wire",
    "profile",
    "section bar",
    "moulded",
    "molded",
    "reinforcing steel",
    "pipe",
    "tube",
    "coil",
    "mesh",
    "granulate, blown",
    "fibre",
    "powder",
    "scrap",
    "waste",
)


def _unformed_materials(input_names: list[str]) -> str | None:
    """Bulk metal or plastic in the model with no shaping service anywhere in it.

    The mirror image of the trap V78/V95 watch: there, `market for section bar extrusion, aluminium`
    was read as *the metal* and the study was a factor of two out. Here the metal is right and the
    step that turns it into a part is missing, and nothing looked.

    Twice in two runs. A solar lamp: 320 g of chromium steel, 72 g of polycarbonate and 80 g
    of ABS, no sheet rolling and no injection moulding. An apple sauce: a twist-off jar lid
    linked to `steel production, converter, unalloyed` — crude steel, CPC "in ingots or other primary
    forms" — while `sheet rolling, steel` and `deep drawing, steel` both exist in the same database
    and add 0.78 kg CO2-Eq per kg, +1.5 % of that study's result. The reviewer of that run saw the lid
    and challenged the *tin coating* instead, which really is negligible (0.04 %), so the model
    dismissed the point along with the reason.

    Deliberately model-wide, not per process: splitting materials and forming into two processes is a
    normal way to build, and a per-process check would fire on it. And deliberately ``info`` — a study
    may have its shaping inside the dataset name, in another model, or genuinely not need one.
    """
    lower = [n.lower() for n in input_names]
    if any(s in n for n in lower for s in _FORMING_SERVICES):
        return None
    bulk = sorted(
        {
            n
            for n in lower
            if any(m in n for m in _SHAPEABLE_MATERIALS) and not any(s in n for s in _ALREADY_SHAPED)
        }
    )
    if not bulk:
        return None
    return (
        f"Shaping: the model links bulk metal or plastic ({'; '.join(bulk[:4])}"
        f"{', …' if len(bulk) > 4 else ''}) but no forming step anywhere — no rolling, drawing, "
        "moulding, extrusion, casting or metal working. A material dataset ends at the material: "
        "turning it into a lid, a housing or a profile is a separate ecoinvent activity, and those "
        "activities exist (`market for sheet rolling, steel`, `market for deep drawing, steel, …`, "
        "`market for injection moulding`, `market for section bar extrusion, aluminium`). Add the "
        "one that applies, or say in the limitations that forming is excluded. Ignore this if the "
        "shaping is already inside the dataset you linked (a name containing 'hot rolled', 'cast' or "
        "'extruded') or sits in another process of a larger study."
    )


#: "42 g", "~400 km", "0.8 g", "1.5 kg", "85 %" — a number with the unit it is written in.
_FIGURE = re.compile(r"([0-9]+(?:[.,][0-9]+)?)\s*(%|[A-Za-zµ]{1,4})\b")

#: How a description points at the parameter a figure belongs to. One convention, used throughout the
#: models this app writes: "(parameter mass_glass_bottle)".
_PARAM_REF = re.compile(r"\(?\s*parameter\s+([A-Za-z_][A-Za-z0-9_]*)")

#: How far back a figure may sit and still be the one this reference is about. Long enough for
#: "1.5 kg of apples per 1 L of juice (parameter apples_per_litre)", short enough that the sentence
#: before it is out of reach.
_FIGURE_WINDOW = 70


def frozen_parameter_figures(
    text: str, values: dict[str, float], units: dict[str, str]
) -> list[tuple[str, str, float]]:
    """Figures a description states beside a parameter that the parameter no longer has.

    A model's process notes are written once and read forever. They name the parameter *and* spell its
    value out — "EUR pallet share per bottle: 42 g wood (parameter mass_pallet_share)" — and the
    inventory chapter prints them verbatim. Change the parameter and the note lies, in the delivered
    PDF, three pages from the parameter table that has the right number, with every chapter reporting
    itself current: the figure is prose, so no placeholder and no staleness check can see it (V164,
    an apple-juice run — four wrong numbers in one chapter).

    Narrow by construction: only a figure within `_FIGURE_WINDOW` characters before the reference, only
    a unit the family table can convert, and only when the numbers really disagree (1 % tolerance, so
    "~400 km" against 400 is silence). A description that names the parameter without a figure, or one
    whose figure is in a unit we cannot place, is left alone.

    Returns (parameter, the figure as written, the parameter's value) per finding.
    """
    out: list[tuple[str, str, float]] = []
    for ref in _PARAM_REF.finditer(text or ""):
        name = ref.group(1)
        if name not in values:
            continue
        symbol = (units.get(name) or "").split("/")[0].strip()
        # A parameter without a unit is a share — 0.85 — and the note writes it as "85 %". Both sides
        # end up as the fraction, which is what the percent family's factor does to the written form.
        target = units_of.base(values[name], symbol) if symbol else (units_of.PERCENT_FAMILY, values[name])
        if target is None:
            continue
        window = text[max(0, ref.start() - _FIGURE_WINDOW) : ref.start()]
        for figure in reversed(list(_FIGURE.finditer(window))):
            written = units_of.base(float(figure.group(1).replace(",", ".")), figure.group(2))
            if written is None or written[0] != target[0]:
                continue  # a quantity of another kind — "per 1 L of juice" beside a mass
            if abs(written[1] - target[1]) > max(abs(target[1]), 1e-12) * 0.01:
                out.append((name, figure.group(0).strip(), values[name]))
            break  # the nearest figure of the right kind is the one the reference is about
    return out


#: A ratio counts as a decimal slip when it is within this much of a power of ten. Tight, because the
#: whole point is to separate "somebody typed grams into a kilogram field" from "the model uses a
#: slightly different number than the brief" — the second is a modelling decision and none of this
#: check's business.
_SLIP_TOLERANCE = 0.02

#: Below this factor the two figures are simply different numbers, and a linter that says so is noise.
#: 100 rather than 10, because a factor of ten is a plausible modelling choice (ten bottles per case)
#: while a hundred is not a choice anyone makes by accident in the direction that matters.
_SLIP_MIN_FACTOR = 100.0

#: …and above this one, the mismatch stops being a plausible slip. Real slips are metric-prefix hops
#: — g↔kg, ml↔l, mm↔m are 10³ — and the corridor ends one decade past them. The check's first fire
#: in the field was "3 m" (a pavilion's FOOTPRINT, from "3 m × 3 m") against a 300-km transport
#: parameter, announced as "a factor of 100000 away": nobody types metres into a kilometre field and
#: misses by five decades (V280).
_SLIP_MAX_FACTOR = 10_000.0

#: A measurement expression — "3 m × 3 m", "300 x 300 cm" — is geometry, not a bookable quantity.
#: Skipping ONLY these keeps the check's purpose intact: the functional-unit prose it was built to
#: read ("…0.25 kg LDPE wrap per 2,016 bottles") carries no ×, a footprint always does (V280).
_DIMENSION_EXPR = re.compile(
    r"[0-9]+(?:[.,][0-9]+)?\s*(?:%|[A-Za-zµ]{1,4})?\s*[×x*]\s*[0-9]+(?:[.,][0-9]+)?"
    r"\s*(?:%|[A-Za-zµ]{1,4})?",
    re.IGNORECASE,
)

#: How close a parameter has to be for the declared figure to count as booked. A rounding, not a
#: neighbourhood: 8.30 g against 8.3 g is the same figure, 0.2 kg against a declared 0.25 kg is not.
#:
#: It started at 1.5 and swallowed the very case it was built for — the pallet's *nail* mass of
#: 0.2 kg sits within 1.5x of the declared 0.25 kg of wrap, so an unrelated parameter of the same
#: family declared the quantity booked and the check went silent on a thousand-fold slip. Being
#: strict here is safe because the second condition does the real work: a figure only becomes a
#: finding when something sits a CLEAN POWER OF TEN away from it.
_BOOKED_TOLERANCE = 1.05

#: A figure that is a thousands-grouped integer in German/French notation as readily as a decimal in
#: English: one separator, exactly three digits after it (`22.848`, `2,016`). See _declared_but_not_booked.
_THOUSANDS_GROUPED = re.compile(r"[0-9]{1,3}[.,][0-9]{3}")


def _declared_but_not_booked(database: str) -> list[tuple[str, str]]:
    """Quantities the study DECLARES that no parameter carries — at a decimal factor away from one.

    Every other check in this file asks whether the model is consistent **with itself**. None of them
    asks whether it is the model the brief described, and that is the gap three thousand-fold slips
    walked through in one session: pallet wood, pallet wrap and nails were each entered
    in grams into a field measured in kilograms. The computed result was 42x too high, and every
    structural check stayed green, because a self-consistent model is exactly what it was.

    What caught two of the three was `frozen_parameter_figures`, and only because the modeller had
    written the figure into the parameter's own comment beside the parameter's name. The study's
    functional unit held the same figure all along — "…0.25 kg LDPE wrap per 2,016 bottles" — and
    nothing ever compared it to the 0.00025 that was booked (V273).

    Narrow by three deliberate rules, because a noisy version of this check is worse than none:

    * both sides go through `units_of.base`, so 8.30 g against 0.0083 kg is silence — this is about
      decimal slips, not about how a figure is written;
    * it fires only when NO parameter of that unit family sits within `_BOOKED_TOLERANCE` of the
      declared figure, i.e. the quantity is booked nowhere at the declared size;
    * and only when some parameter sits a clean power of ten away from it, at least
      `_SLIP_MIN_FACTOR`. A number that is merely different is a modelling decision.

    Returns (the figure as the study wrote it, the parameter and factor that look like the slip).
    """
    # `list_params`, not `list_parameters`. The wrong name is right above in `lint_database`, with a
    # note saying it cost that check months of silence — an ImportError swallowed by a broad `except`.
    from prism_lca.engine.params import list_params
    from prism_lca.engine.study import REPORTABLE, StudyMetaStore

    meta = StudyMetaStore().get(database)
    declared = " ".join(str(meta.get(key) or "") for key, _label in REPORTABLE).strip()
    if not declared:
        return []
    try:
        stored = list_params(database, with_usage=False)
    except Exception as exc:  # noqa: BLE001 — a linter must not fall over on an unreadable parameter file
        _log.swallowed(exc, "_declared_but_not_booked")
        return []
    booked: list[tuple[int, float, str]] = []
    for param in stored:
        amount = param.get("amount")
        if not isinstance(amount, (int, float)) or isinstance(amount, bool) or not amount:
            continue
        symbol = str(param.get("unit") or "").split("/")[0].strip()
        if not symbol:
            continue  # a bare share has no family to compare against
        placed = units_of.base(float(amount), symbol)
        if placed:
            booked.append((placed[0], placed[1], str(param.get("name") or "")))

    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    # Geometry first: every figure inside an "A × B" measurement expression is off the table. The
    # pavilion case fired on the first half of "3 m × 3 m Grundfläche" (V280).
    dimension_spans = [(m.start(), m.end()) for m in _DIMENSION_EXPR.finditer(declared)]
    for figure in _FIGURE.finditer(declared):
        if any(s <= figure.start() < e for s, e in dimension_spans):
            continue
        written = units_of.base(float(figure.group(1).replace(",", ".")), figure.group(2))
        if not written or not written[1]:
            continue
        family, value = written
        same = [(v, n) for f, v, n in booked if f == family and v]
        if not same:
            continue
        if any(1 / _BOOKED_TOLERANCE <= v / value <= _BOOKED_TOLERANCE for v, _n in same):
            continue  # booked at the declared size somewhere — nothing to say
        # "22.848 km" in a German scope is twenty-two thousand, not twenty-two and a bit: a figure whose
        # only separator is followed by exactly three digits reads both ways, and the thousands reading
        # is the one the model booked (km_sea = 22848.4). Firing there is the check's own false alarm
        # (V404): the figure was booked, in the notation the study was written in. So the
        # grouped reading counts as booked too — the decimal reading still fires when NEITHER matches.
        grouped = _THOUSANDS_GROUPED.fullmatch(figure.group(1))
        if grouped:
            alt = units_of.base(float(figure.group(1).replace(".", "").replace(",", "")), figure.group(2))
            if alt and alt[1] and any(
                1 / _BOOKED_TOLERANCE <= v / alt[1] <= _BOOKED_TOLERANCE for v, _n in same
            ):
                continue
        # Every candidate, not the first. Arithmetic cannot tell which parameter the declared figure
        # was meant to be — in the run this was built for, the label and the wrap both stood at
        # 0.00025 and naming only the earlier one would have pointed at the innocent parameter. What
        # the check knows is "nothing carries this quantity, and these sit a decade away"; that is
        # what it says.
        candidates: list[str] = []
        for v, name in sorted(same, key=lambda item: item[1]):
            ratio = max(v / value, value / v)
            # A corridor, not a floor: past four decades the mismatch is no longer a plausible
            # prefix slip — see _SLIP_MAX_FACTOR for the five-decade false positive that set it.
            if not _SLIP_MIN_FACTOR <= ratio <= _SLIP_MAX_FACTOR:
                continue
            decades = round(math.log10(ratio))
            if abs(ratio - 10**decades) > 10**decades * _SLIP_TOLERANCE:
                continue
            # The whole derivation, not just the verdict (V280): which parameter, holding what,
            # against what the scope's figure comes to in the family's base unit. Without it the
            # reader's first job is to reconstruct the arithmetic to decide whether to believe it.
            candidates.append(
                f"{name} holds {v:g} where the scope's figure comes to {value:g} in the same base "
                f"unit — a factor of {10**decades:g}"
            )
        token = figure.group(0).strip()
        if candidates and token not in seen:
            seen.add(token)
            out.append((token, ", ".join(candidates)))
    return out


#: How close a booked mass has to be to a researched component mass to count as "this component is
#: in the model". Wide on purpose: loss factors (×1.05) and a modeller's deliberate deviation from
#: the researched figure (0.3 kg booked where research said 0.4) are modelling, not gaps.
_BOM_MATCH_TOLERANCE = 1.5

#: Fallback for research entries logged before the masses were stored structured: the BOM tool has
#: always written "component (material): 9 kg" into the finding text.
_BOM_TEXT = re.compile(r"^(.+?)(?:\s*\([^)]*\))?:\s*([0-9]+(?:\.[0-9]+)?)\s*kg\s*$")


def _bom_items_unbooked(
    database: str, exchanges: list[tuple[str, float, str]]
) -> list[tuple[str, str]]:
    """Researched component masses that no non-zero exchange books — the unwatched hand-over.

    The bill-of-materials researcher finds a component, sources its mass, logs it — and nothing ever
    checks that the modeller built it. On a pavilion run the ground pegs (0.2 kg,
    sourced from the manufacturer's own manual, 1.5 % of the product mass against a declared 0.5 %
    cut-off) sat in the shipping weight and in a dormant end-of-life branch, and in no production
    exchange at all; the research had delivered, the model computed consistently, and the gap was
    visible to nobody.

    `exchanges` is (unit symbol, evaluated amount, formula) per technosphere exchange, collected by
    the caller's pass over the model. A component counts as booked when a non-zero exchange in the
    mass family sits within `_BOM_MATCH_TOLERANCE` of its researched mass, or when a parameter
    carrying the figure feeds at least one non-zero exchange through its formula.
    """
    from prism_lca.engine.params import list_params
    from prism_lca.engine.research_log import ResearchLogStore

    placed = units_of.base(1.0, "kg")
    if placed is None:  # pragma: no cover — kg is always convertible
        return []
    mass_family = placed[0]

    items: list[tuple[str, float]] = []
    seen_components: set[str] = set()
    for entry in ResearchLogStore().list(database):
        for finding in entry.get("findings") or []:
            component = str(finding.get("component") or "").strip()
            mass = finding.get("mass_kg")
            if not component or not isinstance(mass, (int, float)):
                m = _BOM_TEXT.match(str(finding.get("text") or "").strip())
                if not m:
                    continue
                component, mass = m.group(1).strip(), float(m.group(2))
            if not component or not isinstance(mass, (int, float)) or mass <= 0:
                continue
            key = component.lower()
            if key in seen_components:
                continue
            seen_components.add(key)
            items.append((component, float(mass)))
    if not items:
        return []

    try:
        stored = list_params(database, with_usage=False)
    except Exception as exc:  # noqa: BLE001 — a linter must not fall over on an unreadable parameter file
        _log.swallowed(exc, "_bom_items_unbooked")
        stored = []
    mass_params: list[tuple[str, float]] = []
    for param in stored:
        amount = param.get("amount")
        if not isinstance(amount, (int, float)) or isinstance(amount, bool) or not amount:
            continue
        placed = units_of.base(float(amount), str(param.get("unit") or "").split("/")[0].strip())
        if placed and placed[0] == mass_family and placed[1] > 0:
            mass_params.append((str(param.get("name") or ""), placed[1]))

    def close(a: float, b: float) -> bool:
        return a > 0 and b > 0 and max(a / b, b / a) <= _BOM_MATCH_TOLERANCE

    def direct_booking(mass: float, tolerance: float) -> bool:
        # Exchange units are the datasets' long forms ("kilogram"), so they go through _MASS_IN_KG,
        # not units.base.
        for symbol, amount, _formula in exchanges:
            if not amount:
                continue
            factor = _MASS_IN_KG.get(symbol.strip().lower())
            if factor is None:
                continue
            value = abs(float(amount)) * factor
            if value > 0 and mass > 0 and max(value / mass, mass / value) <= tolerance:
                return True
        return False

    out: list[tuple[str, str]] = []
    for component, mass in items:
        # A parameter that carries the figure is the authoritative trail — when one exists, the
        # question is whether IT feeds anything, and a coincidental exchange of similar size must
        # not answer for it. Measured live on the pavilion model: the pegs' 0.2 kg sat in a dormant
        # parameter, and a 0.22-kg polyurethane-coating exchange two components over would have
        # declared them booked under the wide tolerance.
        #
        # Exact carriers displace loose ones for the same reason, measured on the same model in the
        # next breath: the connectors' 0.3 kg sits at exactly 1.5x of the pegs' 0.2 kg, feeds a live
        # exchange, and answered for them. A parameter holding the figure itself outranks one that
        # merely lies within the deviation tolerance; the loose match exists only for the case where
        # the modeller deviated AND parameterised (researched 0.4, booked as verbinder_masse = 0.3).
        exact = [
            name
            for name, value in mass_params
            if name and max(value / mass, mass / value) <= _BOOKED_TOLERANCE
        ]
        carriers = exact or [name for name, value in mass_params if name and close(value, mass)]
        if carriers:
            fed = False
            for name in carriers:
                ident = re.compile(rf"\b{re.escape(name)}\b")
                if any(amount and f and ident.search(f) for _s, amount, f in exchanges):
                    fed = True
                    break
            # A literal booking of (almost) exactly the figure still counts — tight tolerance, so a
            # neighbouring mass cannot stand in.
            if fed or direct_booking(mass, _BOOKED_TOLERANCE):
                continue
            out.append(
                (
                    component,
                    f"{mass:g} kg — parameter '{carriers[0]}' carries the figure but feeds no "
                    "non-zero exchange",
                )
            )
            continue
        # No parameter trail: a non-zero mass exchange within the wide tolerance settles it, so a
        # deliberate deviation from the researched figure stays modelling, not a gap.
        if direct_booking(mass, _BOM_MATCH_TOLERANCE):
            continue
        out.append((component, f"{mass:g} kg"))
    return out


def _unsourced_figures(database: str, comment_texts: list[str]) -> str | None:
    """Says how much of the model rests on figures that cite nothing — or None when enough of it does.

    A wall-paint run built a complete cradle-to-grave model on 20 parameters, fourteen
    of whose descriptions begin with the word "ANNAHME", and **one** URL in the whole study — the one
    the user had pasted into the prompt. No research tool was called; the density, the recipe and the
    titanium-dioxide share all came out of the model's memory. Every check passed, because none of
    them asks what the numbers rest on. The assistant named this the largest accuracy loss of the run
    when asked afterwards, which is late.

    A screening study on typical values is perfectly legitimate — the point is that it should be
    stated, not discovered. So this counts rather than judges, and reports as ``info``.
    """
    from prism_lca.engine import params

    try:
        rows = params.list_params(database, with_usage=False)
    except Exception as exc:  # noqa: BLE001 — an optional signal, never a reason to fail the linter
        _log.swallowed(exc, "_unsourced_figures")
        return None
    texts = [str(p.get("description") or "") for p in rows]
    # A handful of parameters is not a study; the check would fire on every sketch.
    if len(texts) < 3:
        return None

    def sourced(items: list[str]) -> int:
        return sum(1 for t in items if any(m in t.lower() for m in _SOURCE_MARKERS))

    p_ok, p_all = sourced(texts), len(texts)
    c_ok, c_all = sourced(comment_texts), len(comment_texts)
    # Quiet as soon as a third of the assumptions cite something. Not a quality bar — a threshold
    # low enough that a study which does source its figures never sees this line.
    if p_ok * 3 >= p_all:
        return None
    return (
        f"Data provenance: {p_ok} of {p_all} parameters and {c_ok} of {c_all} process/exchange "
        "comments contain a source (a link or a DOI); the rest are figures this model states "
        "without saying where they come from. That is a legitimate way to run a SCREENING study, "
        "and it is not what a reader assumes unless the study says so. Either research the ones "
        "that carry the result and cite them (research_bom for a composition, research_web for a "
        "rate or a factor), or record in the goal and in the limitations that the inventory rests "
        "on typical industry values. Which figures carry the result is what explain_result tells "
        "you — start there rather than sourcing everything."
    )


# ---------------------------------------------------------------------------
# The rule registry.
#
# `lint_database` used to be one 633-line function: ~30 rules inline, sharing state through the
# enclosing scope. The rules are a registry now, in three scopes that mirror how the linter walks a
# model — per exchange, per activity, model-wide — and a `LintContext` carries what used to be the
# closure: the expensive pass (resolving every exchange input, the treatment cache, the collected
# adjacency/comments/records) runs ONCE at context build, never per rule.
#
# Finding ORDER is contract (`tests/test_health_order.py` pins it): the linter talks to models, and
# the sequence is part of the observed behaviour. Emission is activity-major with the rules
# interleaved per activity and per exchange — exactly the old function's textual order — so the
# registries below must keep their order when rules are added: a new per-exchange rule goes where
# its finding should appear WITHIN each exchange, not at the end of the file.


@dataclass
class _Exchange:
    """One non-production exchange, its input pre-resolved (None = does not link)."""

    ex: dict
    key: tuple | None
    inp: object | None
    #: The provider's reference product is negative (treatment) — None when the input is unresolved.
    is_treatment: bool | None


@dataclass
class _Activity:
    act: object
    akey: tuple
    exchanges: list
    production: list
    resolved: list[_Exchange]


@dataclass
class LintContext:
    """Everything the rules share — built in one pass over the database, read by all of them."""

    bd: object
    database: str
    db: object
    param_units: dict[str, str]
    param_values: dict[str, float]
    #: Parameter name -> its group label ("End-of-life", …), for the share-sum check.
    param_groups: dict[str, str]
    activities: list[_Activity]
    adjacency: dict[tuple, set]
    identities: dict[tuple, list]
    comment_texts: list[str]
    input_names: list[str]
    exchange_records: list[tuple[str, float, str]]
    mass_demands: dict[tuple, list[tuple[str, float]]]
    recyclate_buys: list[dict]


def _finding(severity: str, code: str, message: str, act=None, uid: str | None = None, **extra) -> dict:
    activity = (
        {"database": act.key[0], "code": act.key[1], "name": act.get("name")} if act is not None else None
    )
    return {"severity": severity, "code": code, "message": message, "activity": activity, "uid": uid, **extra}


def _build_context(database: str) -> LintContext:
    bd = get_bd()
    database = _db_or_404(bd, database)
    db = bd.Database(database)

    # Parameter name -> declared unit, for the dimension check. Read once; a model has few of them,
    # and a failure here must not stop the rest of the lint from running.
    param_units: dict[str, str] = {}
    #: …and its current value, for the frozen-figure check.
    param_values: dict[str, float] = {}
    #: …and its group, for the end-of-life share check.
    param_groups: dict[str, str] = {}
    try:
        # `list_params`, not `list_parameters` — the name this module imported for months does not
        # exist, so the import raised ImportError, the `except` below swallowed it, and the dimension
        # check silently never ran on any model. Found while wiring the frozen-figure check beside it:
        # the same empty dict made that one dead on arrival too.
        from prism_lca.engine.params import list_params

        for p in list_params(database, with_usage=False):
            if p.get("unit"):
                param_units[str(p["name"])] = str(p["unit"])
            if isinstance(p.get("amount"), (int, float)):
                param_values[str(p["name"])] = float(p["amount"])
            if p.get("group"):
                param_groups[str(p["name"])] = str(p["group"])
    except Exception as exc:  # noqa: BLE001 — an optional signal, never a reason to fail the linter
        _log.swallowed(exc, "_build_context")
        param_units, param_values, param_groups = {}, {}, {}

    activities: list[_Activity] = []
    adjacency: dict[tuple, set] = {}
    identities: dict[tuple, list] = {}
    treatment_cache: dict[tuple, bool] = {}  # provider key -> has a negative reference product
    # Every comment the model wrote itself, for the provenance count. Cheap: this pass is already
    # reading each activity and each exchange.
    comment_texts: list[str] = []
    # Every background dataset the model links, by name, for the shaping check.
    input_names: list[str] = []
    # (unit, evaluated amount, formula) of every technosphere exchange, for the bill-of-materials
    # reconciliation — same cheapness argument.
    exchange_records: list[tuple[str, float, str]] = []
    # Who demands how many kg of which FOREGROUND provider — the other half of the mass-shortfall
    # check (mass_scaled_demand, V290).
    mass_demands: dict[tuple, list[tuple[str, float]]] = {}
    # Positive purchases of recyclate-producing datasets, judged against the buyer's
    # life-cycle-phase tag by the model-wide rule (eol_buys_recyclate, V289).
    recyclate_buys: list[dict] = []

    for act in db:
        akey = act.key
        exchanges = list(act.exchanges())
        production = [e for e in exchanges if e.get("type") == "production"]
        exchange_records.extend(
            (_exchange_unit(e), float(e.get("amount") or 0), str(e.get("formula") or ""))
            for e in exchanges
            if e.get("type") == "technosphere"
        )
        if act.get("comment"):
            comment_texts.append(str(act.get("comment")))
        comment_texts.extend(str(e.get("comment")) for e in exchanges if e.get("comment"))

        resolved: list[_Exchange] = []
        same_db_inputs: set = set()
        for ex in exchanges:
            if ex.get("type") == "production":
                continue
            key = ex.get("input")
            inp = _resolve(bd, key)
            if inp is None:
                resolved.append(_Exchange(ex=ex, key=tuple(key) if key else None, inp=None, is_treatment=None))
                continue
            tkey = tuple(key)
            if ex.get("type") == "technosphere" and tkey[0] != database:
                input_names.append(str(inp.get("name") or ""))
            amount = ex.get("amount") or 0
            is_treatment: bool | None = None
            if ex.get("type") == "technosphere" and amount != 0:
                if tkey not in treatment_cache:
                    treatment_cache[tkey] = _provider_production(inp) < 0
                is_treatment = treatment_cache[tkey]
                if amount > 0 and tkey[0] == database:
                    iu = str(inp.get("unit") or "").strip().lower()
                    if iu in _MASS_IN_KG:
                        mass_demands.setdefault(tkey, []).append(
                            (str(act.get("name") or ""), amount * _MASS_IN_KG[iu])
                        )
                if amount > 0 and tkey[0] != database and not is_treatment:
                    # A positive purchase of a dataset that PRODUCES recycled material. Legitimate on
                    # the input side (a product made of recyclate), the documented cut-off mistake at
                    # end of life — which of the two it is depends on the buyer's phase tag.
                    blob = f"{inp.get('name') or ''} | {inp.get('reference product') or ''}"
                    if _RECYCLATE_RE.search(blob):
                        recyclate_buys.append(
                            {
                                "akey": akey,
                                "act": act,
                                "uid": ex.get("prism_uid"),
                                "name": str(inp.get("name") or ""),
                                "product": str(inp.get("reference product") or ""),
                                "amount": amount,
                                "unit": str(inp.get("unit") or ""),
                            }
                        )
            if ex.get("type") == "technosphere" and tkey[0] == database and tkey != akey:
                same_db_inputs.add(tkey)
            resolved.append(_Exchange(ex=ex, key=tkey, inp=inp, is_treatment=is_treatment))
        adjacency[akey] = same_db_inputs

        ident = (act.get("name"), act.get("reference product"), act.get("location"))
        identities.setdefault(ident, []).append(act)
        activities.append(
            _Activity(act=act, akey=akey, exchanges=exchanges, production=production, resolved=resolved)
        )

    return LintContext(
        bd=bd,
        database=database,
        db=db,
        param_units=param_units,
        param_values=param_values,
        param_groups=param_groups,
        activities=activities,
        adjacency=adjacency,
        identities=identities,
        comment_texts=comment_texts,
        input_names=input_names,
        exchange_records=exchange_records,
        mass_demands=mass_demands,
        recyclate_buys=recyclate_buys,
    )


# --- per-exchange rules ------------------------------------------------------


def _rule_unlinked(ctx: LintContext, a: _Activity, e: _Exchange) -> list[dict]:
    if e.inp is not None:
        return []
    where = "/".join(e.ex.get("input")) if e.ex.get("input") else "(no input set)"
    return [
        _finding(
            "error",
            "unlinked_exchange",
            f"Exchange input {where} does not link to any activity.",
            a.act,
            e.ex.get("prism_uid"),
        )
    ]


def _rule_sign_convention(ctx: LintContext, a: _Activity, e: _Exchange) -> list[dict]:
    # ecoinvent sign convention: the exchange amount must have the SAME sign as the provider's
    # reference product, or the provider runs at a negative scale. Positive amount from a treatment
    # (negative reference product) is the classic waste-sign error; negative amount from a normal
    # provider (positive reference product — including cutoff recycling activities, whose reference
    # product is the recyclate) turns all its burdens into credits. Warn only; never auto-flip.
    if e.inp is None or e.ex.get("type") != "technosphere":
        return []
    amount = e.ex.get("amount") or 0
    if amount == 0:
        return []
    if amount > 0 and e.is_treatment:
        return [
            _finding(
                "warning",
                "positive_treatment_input",
                f"Input from treatment activity '{e.inp.get('name')}' has a POSITIVE "
                "amount — sending waste to treatment is negative by the ecoinvent "
                "sign convention. Check the sign.",
                a.act,
                e.ex.get("prism_uid"),
            )
        ]
    if amount < 0 and not e.is_treatment:
        return [
            _finding(
                "warning",
                "reversed_provider_input",
                f"Input from '{e.inp.get('name')}' has a NEGATIVE amount, but the "
                "provider's reference product is positive — the provider runs "
                "backwards and its burdens count as credits. Only treatment "
                "activities (negative reference product) take negative amounts; "
                "in the cutoff model, recyclables leave the system burden-free.",
                a.act,
                e.ex.get("prism_uid"),
            )
        ]
    return []


def _rule_formula_zero(ctx: LintContext, a: _Activity, e: _Exchange) -> list[dict]:
    # A fixed amount of 0 is a person typing a zero; a FORMULA that lands on zero is almost never
    # meant, because the point of writing a formula was to compute a real quantity. Nothing else
    # notices: the exchange is still linked, still commented, still in the parameter's `used_by`
    # list, and every structural check passes — the component simply stops existing. A balcony-solar
    # model lost its whole inverter that way, 20 % of the result, to
    # `inverter_replacements` where `1 + …` was meant (V230). Warning, not error: a deliberately
    # dormant branch parked at zero is a real modelling technique, and the message says how to
    # declare it.
    # The comment is the declaration the message asks for, so it has to *count*. It did not: a
    # wood-stain model commented its dormant sea-freight branch exactly as instructed
    # ("scenario switch, only active when share_no > 0"), the warning fired anyway, and the
    # assistant then had to explain it away in prose (V242). A check that asks for an action and
    # ignores it teaches people to stop reading it.
    #
    # Any comment counts, deliberately: judging whether a sentence "really" declares a dormant
    # branch is a language question this module has no business answering, and the exchange comment
    # is not somewhere anybody writes by accident. `duplicate_input` reads the same flag for the
    # same reason.
    if e.inp is None:
        return []
    ex = e.ex
    if ex.get("formula") and not (ex.get("amount") or 0) and not (ex.get("comment") or "").strip():
        return [
            _finding(
                "warning",
                "formula_evaluates_to_zero",
                f"The amount of '{e.inp.get('name')}' comes from the formula "
                f"“{ex.get('formula')}”, which currently evaluates to 0 — so this "
                "input contributes nothing and the process behaves as if it were not there. "
                "If that is deliberate (a branch kept dormant for a scenario), say so in the "
                "exchange comment and this stops being reported; otherwise check the formula, "
                "most often a missing base quantity such as “1 + n_replacements”.",
                a.act,
                ex.get("prism_uid"),
            )
        ]
    return []


def _rule_dimension_mismatch(ctx: LintContext, a: _Activity, e: _Exchange) -> list[dict]:
    # The amount's quantity vs. the input's unit (see _dimension_note).
    if e.inp is None or not ctx.param_units:
        return []
    dim = _dimension_note(e.ex, str(e.inp.get("unit") or ""), ctx.param_units)
    if dim:
        return [_finding("warning", "unit_quantity_mismatch", dim, a.act, e.ex.get("prism_uid"))]
    return []


def _rule_self_loop(ctx: LintContext, a: _Activity, e: _Exchange) -> list[dict]:
    if e.inp is None or e.ex.get("type") != "technosphere":
        return []
    if e.key and e.key[0] == ctx.database and e.key == a.akey:
        return [
            _finding(
                "warning",
                "self_loop",
                "Activity consumes its own reference product (self-loop).",
                a.act,
                e.ex.get("prism_uid"),
            )
        ]
    return []


def _rule_constant_matches_parameter(ctx: LintContext, a: _Activity, e: _Exchange) -> list[dict]:
    # A typed constant that equals a parameter's value is, nine times in ten, a quantity somebody
    # MEANT to bind and did not: a citric-acid model carried `citric_acid_mass = 0.23`
    # and an exchange of 0.23 kg citric acid with no formula, so the two scenarios overriding the
    # parameter moved the result by −0.1 % — through a transport formula that happened to reference
    # it — and every check stayed silent, because the parameter WAS reachable (V332). Info, not
    # warning: a fixed number that coincides with a parameter is possible, and the message says how
    # to declare that. 0 and ±1 are skipped — "1 unit of the sub-process" matches every count-like
    # parameter and says nothing.
    if e.inp is None:
        return []
    ex = e.ex
    if ex.get("formula"):
        return []
    try:
        amount = float(ex.get("amount") or 0.0)
    except (TypeError, ValueError):
        return []
    if amount == 0 or abs(amount) == 1:
        return []
    same = sorted(
        name
        for name, value in ctx.param_values.items()
        if value and abs(abs(value) - abs(amount)) <= abs(value) * 1e-9
    )
    if not same:
        return []
    names = ", ".join(f"'{n}'" for n in same)
    binding = f"'{same[0]}'" if amount > 0 else f"'-{same[0]}'"
    return [
        _finding(
            "info",
            "constant_matches_parameter",
            f"'{e.inp.get('name')}' carries the typed constant {amount:g}, and parameter {names} "
            f"has that same value — a scenario or an edit of the parameter would not move this "
            f"exchange. If they are one quantity, bind it (formula {binding}); if the number is fixed on "
            "purpose, say so in the exchange comment.",
            a.act,
            ex.get("prism_uid"),
        )
    ]


#: Per-exchange rules, in the order their findings appear within one exchange.
EXCHANGE_RULES = [
    _rule_unlinked,
    _rule_sign_convention,
    _rule_formula_zero,
    _rule_dimension_mismatch,
    _rule_self_loop,
    _rule_constant_matches_parameter,
]


# --- per-activity rules ------------------------------------------------------


def _rule_stale_parameter_figures(ctx: LintContext, a: _Activity) -> list[dict]:
    # A note that spells out a parameter's old value (V164).
    out: list[dict] = []
    notes = [str(a.act.get("comment") or ""), *(str(e.get("comment") or "") for e in a.exchanges)]
    for note in notes:
        for pname, written, now in frozen_parameter_figures(note, ctx.param_values, ctx.param_units):
            out.append(
                _finding(
                    "warning",
                    "stale_parameter_figure",
                    f"The note says “{written}” beside parameter '{pname}', which is now {now:g}"
                    f"{(' ' + ctx.param_units[pname]) if ctx.param_units.get(pname) else ''}. The report prints "
                    "these notes as written, so the document would state a figure the model no longer "
                    "uses. Update the wording, or leave the value out and let the parameter table say it.",
                    a.act,
                )
            )
    return out


def _rule_reference_product(ctx: LintContext, a: _Activity) -> list[dict]:
    out: list[dict] = []
    if not a.production:
        out.append(_finding("error", "no_reference_product", "Activity has no production exchange.", a.act))
    elif len(a.production) > 1:
        out.append(
            _finding(
                "error",
                "multiple_reference_products",
                f"Activity has {len(a.production)} production exchanges; expected exactly one.",
                a.act,
            )
        )
    for p in a.production:
        amt = p.get("amount")
        if amt in (None, 0):
            out.append(
                _finding(
                    "error",
                    "zero_production_amount",
                    "Reference-product amount is zero or missing; the activity cannot be scaled.",
                    a.act,
                    p.get("prism_uid"),
                )
            )
        elif amt < 0:
            out.append(
                _finding(
                    "info",
                    "negative_production_amount",
                    "Negative reference product — treated as a treatment/waste activity.",
                    a.act,
                    p.get("prism_uid"),
                )
            )
    return out


def _rule_exchanges(ctx: LintContext, a: _Activity) -> list[dict]:
    """Run the per-exchange registry, exchange-major: all rules on one exchange, then the next —
    the order the old single loop emitted in."""
    out: list[dict] = []
    for e in a.resolved:
        for rule in EXCHANGE_RULES:
            out.extend(rule(ctx, a, e))
    return out


def _rule_duplicate_supply(ctx: LintContext, a: _Activity) -> list[dict]:
    # The same product supplied twice on one activity. Grouped by the product rather than the
    # dataset key on purpose: the double-counting that actually happens is a half-finished
    # replacement, where the new dataset is added and the old one is never removed. Both then
    # deliver the same product from two different datasets, which every per-dataset check reads as
    # two unrelated, perfectly valid inputs.
    by_product: dict[tuple, list[dict]] = {}
    for e in a.resolved:
        if e.inp is None or e.ex.get("type") != "technosphere":
            continue
        amount = e.ex.get("amount") or 0
        if not amount:
            continue
        product = (e.inp.get("reference product") or e.inp.get("name") or "").strip()
        if product:
            by_product.setdefault((product, e.inp.get("unit") or ""), []).append(
                {
                    "key": e.key,
                    "name": e.inp.get("name") or "",
                    "location": e.inp.get("location") or "",
                    "amount": amount,
                    "uid": e.ex.get("prism_uid"),
                    "commented": bool((e.ex.get("comment") or "").strip()),
                }
            )

    out: list[dict] = []
    # What the activity itself makes, so a set of inputs that adds up to it can be recognised as a
    # composition instead of a leftover (see the mix/replacement split below).
    ref_amount = next((e.get("amount") for e in a.production if e.get("amount")), None)
    for (product, unit), rows in by_product.items():
        # Only same-sign inputs: a positive/negative pair is a deliberate add-and-credit, not a
        # double count, and flagging it would train people to ignore this warning.
        for sign in (1, -1):
            same = [r for r in rows if (r["amount"] > 0) == (sign > 0)]
            if len(same) < 2:
                continue
            one_dataset = len({r["key"] for r in same}) == 1
            where = ", ".join(
                f"{r['name']}{' [' + r['location'] + ']' if r['location'] else ''} = {r['amount']:g}"
                for r in same[:4]
            )
            if one_dataset:
                # Two exchanges to the SAME provider compute exactly as one with their sum, so this
                # is never a numerical error — and it has a perfectly ordinary cause: two fractions
                # taking the same route (corrugated board and pallet wood both to municipal
                # incineration). Reported as tidiness, not as a defect; calling it "counted twice"
                # would train people to ignore the far more dangerous case below.
                out.append(
                    _finding(
                        "info",
                        "duplicate_input",
                        f"'{product}' is supplied by the same dataset {len(same)} times ({where}). The "
                        "amounts add up, so the result is right either way — merge them if they are one "
                        "thing.",
                        a.act,
                        same[0]["uid"],
                    )
                )
                continue
            # Different datasets delivering one product is the real risk: it is the signature of a
            # half-finished replacement, where the new dataset is added and the old one never
            # removed. Nothing per-dataset can see it, because each link is individually valid.
            #
            # But the same shape is also how a deliberate MIX looks — 33 % petrochemical glycerine
            # and 67 % from rape oil, in a process built to make that split testable. Two signals
            # separate the two, both cheap and deterministic:
            #
            #  1. the amounts add up to the reference product (0.33 + 0.67 = 1 kg), which is a
            #     composition and not a leftover; and
            #  2. every one of them carries a comment — which is exactly the remedy the old text
            #     asked for, and it asked without ever checking whether it had been done. A warning
            #     that survives its own fix is noise, and it fired on a correct model twice.
            identical = len({round(float(r["amount"]), 12) for r in same}) == 1
            total = sum(float(r["amount"]) for r in same)
            composes = ref_amount not in (None, 0) and abs(total - float(ref_amount)) <= 1e-6 * max(
                1.0, abs(float(ref_amount))
            )
            documented = all(r["commented"] for r in same)
            if composes or documented:
                out.append(
                    _finding(
                        "info",
                        "deliberate_mix",
                        f"{len(same)} datasets supply '{product}'{' in ' + unit if unit else ''} "
                        f"({where})"
                        + (
                            f" and their amounts add up to the reference product ({total:g}), so this "
                            "reads as a deliberate mix rather than a half-finished replacement."
                            if composes
                            else ", each with a comment explaining it, so this reads as deliberate."
                        )
                        + " Nothing to do unless one of them was meant to replace another.",
                        a.act,
                        same[0]["uid"],
                    )
                )
                continue
            out.append(
                _finding(
                    "warning",
                    "possible_double_count",
                    f"{len(same)} different datasets all supply '{product}'"
                    f"{' in ' + unit if unit else ''} ({where})."
                    + (
                        " Their amounts are identical, which is what a replacement looks like when the "
                        "old input was never removed."
                        if identical
                        else " If one was meant to replace another, the old one is still counted; if the "
                        "split is deliberate, comment the exchanges and this becomes a note instead."
                    ),
                    a.act,
                    same[0]["uid"],
                )
            )
    return out


#: Per-activity rules, in the order their findings appear within one activity.
def _rule_imported_unmatched(ctx: LintContext, a: _Activity) -> list[dict]:
    """Flows an import could not place. Parked with the dataset, and counted here.

    This is the other half of the import's promise:
    a flow that could not be matched is never dropped silently, because a dropped emission makes a
    dataset look *better* than it is and nothing on screen would say so. Parking it only helps if
    something later counts it — that is this rule.
    """
    parked = a.act.get("prism_unmatched") or []
    if not parked:
        return []
    shown = ", ".join(str(p.get("name") or "?") for p in parked[:3])
    more = f" and {len(parked) - 3} more" if len(parked) > 3 else ""
    return [
        _finding(
            "warning",
            "imported_unmatched_flows",
            f"{len(parked)} flow(s) from the imported source could not be matched to our "
            f"vocabulary and carry no exchange: {shown}{more}. The result of this dataset is "
            f"therefore incomplete — by that much, in that direction.",
            a.act,
        )
    ]


#: Tonne-kilometre units as ecoinvent and the importers write them.
_TKM_UNITS = {"ton kilometer", "tonne kilometer", "tonne-kilometre", "tonne kilometre", "tkm", "t*km", "t km"}

#: The longest leg a transport mode can plausibly run, in km, judged from the dataset name. Generous
#: on purpose — the finding is for the factor-of-1000 mistake, not for a long route: a road leg of
#: 5 225 km appeared in an earlier modelling session because a 12 t lot was booked per kilogram of plate
#: (V321). Air is capped at half the Earth's circumference, sea at the longest liner services.
_TRANSPORT_MODES: list[tuple[re.Pattern[str], str, float]] = [
    (re.compile(r"lorry|truck|van\b|road", re.IGNORECASE), "road", 4_000.0),
    (re.compile(r"aircraft|air\b|plane|freighter|belly", re.IGNORECASE), "air", 20_000.0),
    (re.compile(r"train|rail", re.IGNORECASE), "rail", 12_000.0),
    (re.compile(r"sea|ship|vessel|barge|ferry|waterway|tanker|bulk carrier", re.IGNORECASE), "sea", 30_000.0),
]
_TRANSPORT_CAP_UNKNOWN = 40_000.0
#: Below this implied distance the opposite slip is likely (kilograms typed where tonnes were meant).
_TRANSPORT_MIN_KM = 1.0


def _transport_mode(name: str) -> tuple[str, float]:
    for pattern, mode, cap in _TRANSPORT_MODES:
        if pattern.search(name):
            return mode, cap
    return "transport", _TRANSPORT_CAP_UNKNOWN


def _rule_transport_distance(ctx: LintContext, a: _Activity) -> list[dict]:
    """A tonne-kilometre exchange implies a distance once the product's mass is known: tkm ÷ tonnes.

    An implied leg longer than any real one of that mode is almost always the tonne conversion gone
    wrong (a lot size booked per kilogram, kilograms used as tonnes), and the sign of that mistake is
    a factor of a thousand, not a few percent — so the caps can be wide and still catch it. Only
    products declared in a mass unit are judged; for a piece or a litre the mass is unknown.
    """
    if len(a.production) != 1:
        return []
    prod = a.production[0]
    unit = str(prod.get("unit") or a.act.get("unit") or "").strip().lower()
    if unit not in _MASS_IN_KG:
        return []
    try:
        made_kg = abs(float(prod.get("amount") or 0)) * _MASS_IN_KG[unit]
    except (TypeError, ValueError):
        return []
    if made_kg <= 0:
        return []
    made_t = made_kg / 1000.0
    out: list[dict] = []
    for e in a.resolved:
        if e.inp is None or e.ex.get("type") != "technosphere":
            continue
        if str(e.inp.get("unit") or "").strip().lower() not in _TKM_UNITS:
            continue
        try:
            tkm = float(e.ex.get("amount") or 0)
        except (TypeError, ValueError):
            continue
        if tkm <= 0:
            continue
        implied_km = tkm / made_t
        name = str(e.inp.get("name") or "")
        mode, cap = _transport_mode(name)
        uid = e.ex.get("prism_uid")
        if implied_km > cap:
            out.append(
                _finding(
                    "warning",
                    "transport_distance_implausible",
                    f"{tkm:g} tkm of '{name}' for {made_kg:g} kg of product implies a {mode} leg of "
                    f"{implied_km:,.0f} km — longer than any {mode} leg ({cap:,.0f} km). The tonne "
                    f"conversion has usually slipped: tkm = mass carried in tonnes × km, per unit of "
                    f"THIS product (1 kg = 0.001 t). Check whether a lot size or a kilogram figure was "
                    f"booked as tonnes.",
                    a.act,
                    uid,
                    implied_km=round(implied_km, 1),
                    mode=mode,
                )
            )
        elif implied_km < _TRANSPORT_MIN_KM:
            # A warning, not an info: in one run the assistant read the info, called it a
            # linter false positive ("the functional unit is 1 kg, so the amounts are correct") and
            # left 0.0007 tkm standing for a 733 km rail leg — a thousandth of the real figure. The
            # message therefore does the arithmetic for THIS product, so there is nothing to argue with.
            per_km = made_t
            out.append(
                _finding(
                    "warning",
                    "transport_distance_tiny",
                    f"{tkm:g} tkm of '{name}' for {made_kg:g} kg of product is a {mode} leg of only "
                    f"{implied_km * 1000:,.0f} m. For {made_kg:g} kg (= {made_t:g} t) every kilometre is "
                    f"{per_km:g} tkm, so a {implied_km * 1000:,.0f} km leg would be {implied_km * 1000 * per_km:g} tkm "
                    f"— a thousand times this amount. Almost always the mass was divided by 1 000 twice "
                    f"(kilograms taken as tonnes, then converted again). Check the leg length in the "
                    f"comment against this amount.",
                    a.act,
                    uid,
                    implied_km=round(implied_km, 3),
                    mode=mode,
                )
            )
    return out


ACTIVITY_RULES = [
    _rule_stale_parameter_figures,
    _rule_reference_product,
    _rule_exchanges,
    _rule_duplicate_supply,
    _rule_imported_unmatched,
    _rule_transport_distance,
]


# --- model-wide rules --------------------------------------------------------


def _rule_unrecorded_scope(ctx: LintContext) -> list[dict]:
    # The study's own metadata.
    note = _unrecorded_scope(ctx.database)
    return [_finding("info", "unrecorded_scope", note)] if note else []


def _rule_missing_forming(ctx: LintContext) -> list[dict]:
    # Material linked, shaping missing.
    note = _unformed_materials(ctx.input_names)
    return [_finding("info", "missing_forming_step", note)] if note else []


def _rule_unsourced_figures(ctx: LintContext) -> list[dict]:
    # What the figures rest on.
    note = _unsourced_figures(ctx.database, ctx.comment_texts)
    return [_finding("info", "unsourced_figures", note)] if note else []


def _rule_scenario_window(ctx: LintContext) -> list[dict]:
    # A scenario window this model may still be standing in. The one finding here that is not about
    # how the model was built but about whether its numbers are the author's at all: a calculation
    # killed mid-scenario leaves the variant's values in the parameters, and where the crash marker
    # cannot prove what to put back it says so here rather than guessing (see
    # engine/param_window.py). Reported at `error`, because every score of this model is in doubt
    # until it is settled.
    try:
        from prism_lca.engine.param_window import unresolved as _unresolved_window

        stuck = _unresolved_window(ctx.database)
    except Exception as exc:  # noqa: BLE001 — an optional signal, never a reason to fail the linter
        _log.swallowed(exc, "_rule_scenario_window")
        stuck = None
    if stuck:
        return [_finding("error", "scenario_overrides_unresolved", stuck["message"])]
    return []


def _rule_scenario_no_effect(ctx: LintContext) -> list[dict]:
    # Scenarios whose overrides cannot reach a single exchange amount. The write paths refuse an
    # override set to the baseline value, but not one on a parameter the model never reads — that
    # state is ordinary while a model is being built, and only wrong once it is finished. Finished
    # is what a health check is for. Three of the four scenarios in a balcony-solar
    # model were of this kind, all three returning Δ 0 (V236).
    out: list[dict] = []
    try:
        from prism_lca.engine import scenarios as _scen

        for entry in _scen.ScenarioStore().list_all(ctx.database):
            dead = _scen.unreachable_overrides(ctx.database, entry.get("overrides") or {})
            if not dead:
                continue
            names = ", ".join(f"'{n}'" for n in sorted(dead))
            out.append(
                _finding(
                    "warning",
                    "scenario_has_no_effect",
                    f"Scenario '{entry.get('name')}' changes {names}, but no exchange amount "
                    "depends on those parameters — the variant returns the baseline result, and "
                    "a chart of it draws two bars of the same height. Wire the parameter into a "
                    "formula, or drop the scenario.",
                )
            )
    except Exception as exc:  # noqa: BLE001 — an optional signal, never a reason to fail the linter
        _log.swallowed(exc, "_rule_scenario_no_effect")
    return out


def _rule_declared_not_booked(ctx: LintContext) -> list[dict]:
    # What the study DECLARES against what the model books. The only check here that compares the
    # model to something outside itself. Everything else asks whether the model is self-consistent,
    # which a model with three grams-for-kilograms slips cheerfully is (V273).
    out: list[dict] = []
    try:
        for written, culprit in _declared_but_not_booked(ctx.database):
            out.append(
                _finding(
                    "warning",
                    "declared_not_booked",
                    f"The study's scope states {written} and no parameter books that quantity, "
                    f"while {culprit}. A clean power of ten between what the brief says and what "
                    "the model books is how a unit slip looks (a figure in grams entered into a "
                    "field measured in kilograms) — verify the named parameter against its "
                    "source before trusting any result; if it is right as booked, say so where "
                    "the scope figure is documented instead of changing either number. Every "
                    "other check in this report asks whether the model agrees with itself; this "
                    "one asks whether it is the model the scope describes.",
                )
            )
    except Exception as exc:  # noqa: BLE001 — an optional signal, never a reason to fail the linter
        _log.swallowed(exc, "_rule_declared_not_booked")
    return out


def _rule_bom_unbooked(ctx: LintContext) -> list[dict]:
    # Researched component masses the model never books. The complement of the research pipeline:
    # research_bom logs sourced masses, and until now nothing compared them with the model that was
    # then built (the pavilion's pegs).
    out: list[dict] = []
    try:
        for component, detail in _bom_items_unbooked(ctx.database, ctx.exchange_records):
            out.append(
                _finding(
                    "info",
                    "bom_item_unbooked",
                    f"The bill-of-materials research recorded '{component}' at {detail}, and no "
                    "non-zero exchange books a mass near it. Either its production was never "
                    "modelled, or it falls under the cut-off — model it, or name it where the "
                    "study records its cut-off decisions. A mass that is inside the shipping "
                    "weight but inside no process is invisible to every other check here.",
                )
            )
    except Exception as exc:  # noqa: BLE001 — an optional signal, never a reason to fail the linter
        _log.swallowed(exc, "_rule_bom_unbooked")
    return out


def _rule_unused_parameters(ctx: LintContext) -> list[dict]:
    # Parameters nothing refers to.
    return [
        _finding("info", "unused_parameter", message, parameter=name)
        for name, message in _unused_parameters(ctx.database)
    ]


def _rule_mass_shortfall(ctx: LintContext) -> list[dict]:
    # The mass shortfall, judged now that every demand is known (V290). The info stays an info
    # until the model also CONSUMES the under-filled process by exactly its inputs' mass — the
    # shape of "the reference product says 1 kg, but the process holds a whole product's worth of
    # materials". Brightway then scales the inputs twice, silently.
    out: list[dict] = []
    for a in ctx.activities:
        note = _mass_note(ctx.bd, a.act, a.exchanges)
        if not note:
            continue
        text, made_kg, inputs_kg = note
        uid = a.production[0].get("prism_uid")
        hit = next(
            (
                (consumer, d)
                for consumer, d in ctx.mass_demands.get(tuple(a.akey), [])
                if inputs_kg and abs(d - inputs_kg) <= 0.02 * max(inputs_kg, d)
            ),
            None,
        )
        if hit and made_kg and abs(made_kg - inputs_kg) > 1e-9:
            consumer, demanded = hit
            factor = demanded / made_kg
            out.append(
                _finding(
                    "warning",
                    "mass_scaled_demand",
                    f"This process declares {made_kg:g} kg of reference product but holds only "
                    f"{inputs_kg:g} kg of inputs — and '{consumer}' demands {demanded:g} kg, almost "
                    f"exactly the inputs' sum. The engine scales by demand ÷ reference amount, so these "
                    f"inputs enter the result multiplied by {factor:g}: {inputs_kg * factor:g} kg of "
                    f"materials are counted instead of {inputs_kg:g} kg. Either make the reference "
                    f"product one product's worth (e.g. 1 unit, demanded once), or fill the inputs per "
                    f"kilogram so they sum to {made_kg:g} kg.",
                    a.act,
                    uid,
                )
            )
        else:
            out.append(_finding("info", "mass_in_below_mass_out", text, a.act, uid))
    return out


def _rule_eol_recyclate(ctx: LintContext) -> list[dict]:
    # Recyclate bought at end of life (V289). The same purchase is correct on the input side and
    # wrong at end of life, so the phase tag is the judge. Under cut-off, the fraction that goes to
    # recycling leaves the product system burden-free — a positive input of a recyclate-producing
    # dataset in an end-of-life process charges the disposal with producing recyclate the product
    # never uses.
    if not ctx.recyclate_buys:
        return []
    eol_keys: set[tuple] = set()
    tagged: set[tuple] = set()  # every key that carries a tag at all
    try:
        for tag_key, tags in TagStore().load_map().items():
            tdb, _, tcode = tag_key.rpartition("/")
            if tdb != ctx.database or not tags:
                continue
            tagged.add((tdb, tcode))
            if any(_EOL_TAG_RE.search(str(t.get("value") or "")) for t in tags):
                eol_keys.add((tdb, tcode))
    except Exception as exc:  # noqa: BLE001 — tags are an optional signal, never a reason to fail
        _log.swallowed(exc, "_rule_eol_recyclate")
        eol_keys = set()
    out: list[dict] = []
    for buy in ctx.recyclate_buys:
        # The purchase counts where its input says it counts, else where its process does.
        own = (buy["akey"][0], TagStore.exchange_code(buy["akey"][1], buy["uid"])) if buy.get("uid") else None
        if (own if own in tagged else tuple(buy["akey"])) not in eol_keys:
            continue
        out.append(
            _finding(
                "warning",
                "eol_buys_recyclate",
                f"This end-of-life process BUYS '{buy['name']}' (+{buy['amount']:g} {buy['unit']}) — "
                f"a dataset whose reference product is the recycled material ('{buy['product']}'). "
                "Under the cut-off system model the fraction that goes to recycling leaves the "
                "product system burden-free: whoever uses the recyclate pays for producing it, and a "
                "product made of recycled material already pays on its input side. Remove this "
                "exchange and link nothing for the recycled share — only incineration and landfill "
                "carry treatment exchanges here (negative amounts, matching their reference "
                "products).",
                buy["act"],
                buy["uid"],
            )
        )
    return out


def _name_of(ctx: LintContext):
    return lambda key: (_resolve(ctx.bd, key) or {}).get("name") or key[1]


def _rule_two_ways_in(ctx: LintContext) -> list[dict]:
    # One process reached by two paths from the reference process.
    out: list[dict] = []
    for severity, code, message, key in two_ways_in(ctx.adjacency, _name_of(ctx)):
        node = _resolve(ctx.bd, key)
        if node is not None:
            out.append(_finding(severity, code, message, node))
    return out


def _rule_unreached(ctx: LintContext) -> list[dict]:
    # A process nothing consumes besides the reference process: in the model, not in the result.
    out: list[dict] = []
    for severity, code, message, key in unreached(ctx.database, ctx.adjacency, _name_of(ctx)):
        node = _resolve(ctx.bd, key)
        if node is not None:
            out.append(_finding(severity, code, message, node))
    return out


def _rule_phases(ctx: LintContext) -> list[dict]:
    # How the tagged life-cycle phases hang together.
    out: list[dict] = []
    for severity, code, message, key in _phase_findings(ctx.database, ctx.adjacency):
        node = _resolve(ctx.bd, key)
        if node is not None:
            out.append(_finding(severity, code, message, node))
    return out


def _rule_cycles(ctx: LintContext) -> list[dict]:
    # Circular references across the foreground.
    out: list[dict] = []
    for cyc in _find_cycles(ctx.adjacency):
        names = " → ".join(
            ctx.bd.get_node(database=k[0], code=k[1]).get("name") or k[1] for k in cyc
        )
        first = ctx.bd.get_node(database=cyc[0][0], code=cyc[0][1])
        out.append(_finding("warning", "circular_reference", f"Circular technosphere loop: {names} → …", first))
    return out


def _rule_duplicate_identity(ctx: LintContext) -> list[dict]:
    # Duplicate identities (informational).
    out: list[dict] = []
    for ident, acts in ctx.identities.items():
        if len(acts) > 1 and ident[0]:
            out.append(
                _finding(
                    "info",
                    "duplicate_identity",
                    f"{len(acts)} activities share name/product/location "
                    f"({ident[0]} | {ident[1]} | {ident[2]}).",
                    acts[0],
                )
            )
    return out


#: An end-of-life share parameter: by name prefix, or by the group it was filed under.
_EOL_PARAM_RE = re.compile(r"^eol_", re.IGNORECASE)
#: Shares are written to three decimals; 0.2 % absorbs that rounding and still catches the 0.4 %
#: "other recovery" that V330 buried.
_EOL_SHARE_TOLERANCE = 0.002


def _exchange_unit(e) -> str:
    """The unit an exchange is measured in — the exchange's own field when a writer set one, else
    the input dataset's. An exchange booked through the ordinary path has no `unit` field of its own
    (add_exchange leaves it to the input), and the BOM check then skipped a correctly booked 0.2 kg
    as "no unit" and reported the component as unbooked."""
    unit = e.get("unit")
    if unit:
        return str(unit)
    try:
        return str(e.input.get("unit") or "")
    except Exception:  # noqa: BLE001 - an input that does not resolve has no unit to offer
        return ""


def _rule_eol_shares(ctx: LintContext) -> list[dict]:
    """End-of-life shares that do not add up to 1.

    The split of a product's mass over its fates (recycling, incineration, landfill, other) is a set
    of fractions that must sum to one — the EoL skill says so, and models write it that way. In the
    one modelling session the assistant closed a 0.4 % gap by quietly adding Eurostat's "other
    recovery" to landfill (V330); the honest answer is a fourth parameter. This says when the group
    is short or over, and by how much. An info: the shares may be deliberately incomplete while a
    model is being built.
    """
    shares: dict[str, float] = {}
    for name, value in ctx.param_values.items():
        group = ctx.param_groups.get(name, "")
        if not (_EOL_PARAM_RE.search(name) or _EOL_TAG_RE.search(group)):
            continue
        # A parameter that declares a physical unit is not a share of anything: `eol_distance`
        # (km) filed under the same prefix made the shares "sum to 101".
        if _QUANTITY.get((ctx.param_units.get(name) or "").strip().lower()):
            continue
        shares[name] = value
    # One split per material. `eol_recycling`/`eol_landfill` split the product; `eol_steel_recycling`
    # and `eol_pp_recycling` are each the recycling rate of a DIFFERENT material and have no reason to
    # sum to anything — an earlier modelling session was told its three per-material rates "treat
    # 0.848 too much". The token after `eol_` is the material when a further token follows.
    groups: dict[str, dict[str, float]] = {}
    for name, value in shares.items():
        rest = _EOL_PARAM_RE.sub("", name)
        material = rest.split("_", 1)[0].lower() if "_" in rest else ""
        groups.setdefault(material, {})[name] = value
    findings: list[dict] = []
    for material, part in sorted(groups.items()):
        finding = _eol_group_finding(part, material)
        if finding:
            findings.append(finding)
    return findings


def _eol_group_finding(shares: dict[str, float], material: str) -> dict | None:
    if len(shares) < 2:
        return None
    total = sum(shares.values())
    if abs(total - 1.0) <= _EOL_SHARE_TOLERANCE:
        return None
    listed = ", ".join(f"{n} = {v:g}" for n, v in sorted(shares.items()))
    gap = 1.0 - total
    what = f"The end-of-life shares of '{material}'" if material else "The end-of-life shares"
    detail = (
        f"{gap:g} of the product's mass has no fate. If that is a route the statistics report "
        f"separately (e.g. Eurostat's 'other recovery'), give it its own parameter such as eol_other "
        f"rather than folding it into another route."
        if gap > 0
        else f"{-gap:g} too much — some mass is treated twice. Check the shares against their source."
    )
    return _finding(
        "info",
        "eol_shares_not_unity",
        f"{what} add up to {total:g}, not 1 ({listed}). {detail}",
        None,
        None,
        parameters=sorted(shares),
        total=round(total, 4),
    )


#: Model-wide rules, in the order their findings are emitted after the per-activity pass.
MODEL_RULES = [
    _rule_unrecorded_scope,
    _rule_missing_forming,
    _rule_unsourced_figures,
    _rule_scenario_window,
    _rule_scenario_no_effect,
    _rule_declared_not_booked,
    _rule_bom_unbooked,
    _rule_unused_parameters,
    _rule_eol_shares,
    _rule_mass_shortfall,
    _rule_eol_recyclate,
    _rule_two_ways_in,
    _rule_unreached,
    _rule_phases,
    _rule_cycles,
    _rule_duplicate_identity,
]


def lint_database(database: str) -> dict:
    """Run every check over ``database`` and return findings + a severity summary."""
    ctx = _build_context(database)

    findings: list[dict] = []
    # Activity-major, rules interleaved — the emission order the old single function had, which the
    # stable severity sort below preserves within each severity class.
    for a in ctx.activities:
        for rule in ACTIVITY_RULES:
            findings.extend(rule(ctx, a))
    for model_rule in MODEL_RULES:
        findings.extend(model_rule(ctx))

    findings.sort(key=lambda f: _SEVERITY_ORDER.get(f["severity"], 9))
    summary = {sev: sum(1 for f in findings if f["severity"] == sev) for sev in ("error", "warning", "info")}
    return {
        "database": ctx.database,
        "activities": len(ctx.db),
        "ok": summary["error"] == 0,
        "summary": summary,
        # What was actually examined. A silent linter cannot be told apart from an absent one: after
        # one run the assistant reported "there is no mass-balance check" and asked for
        # one to be built, having simply never seen _mass_note speak — because the model balanced.
        # Saying which checks ran turns silence into a result.
        "checks_run": [
            "reference products and units",
            "unlinked and orphaned references",
            "processes nothing consumes (left out of the result) and processes reached twice",
            "circular links",
            "duplicate inputs",
            "mass balance (flags mass appearing from nowhere; mass LEAVING is normal — drying, "
            "combustion, losses — and is never flagged)",
            "amount vs. input unit dimensions",
            "formulas that evaluate to zero",
            "scenarios whose overrides reach no exchange",
            "parameters that can reach no exchange (following chains of parameters)",
            "typed constants that equal a parameter's value (a quantity a scenario cannot move)",
            "life-cycle phase coverage",
            "data provenance (how many figures cite a source)",
            "shaping (bulk metal or plastic linked with no forming step in the model)",
            "transport legs (the distance a tonne-kilometre exchange implies per unit of product)",
            "end-of-life shares (parameters named eol_* or grouped under end of life sum to 1)",
        ],
        "findings": findings,
    }
