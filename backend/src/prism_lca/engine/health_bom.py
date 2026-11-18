"""The health check's bill-of-materials reconciliation: researched component masses against what the model books.

The bill-of-materials researcher finds a component, sources its mass, logs it — and nothing else checks that
the modeller then built it. On a pavilion run the ground pegs (0.2 kg, sourced from the manufacturer's own
manual, 1.5 % of the product mass against a declared 0.5 % cut-off) sat in the shipping weight and in a dormant
end-of-life branch, and in no production exchange at all; the research had delivered, the model computed
consistently, and the gap was visible to nobody.

A component counts as booked when

* a parameter carrying its figure raises a positive exchange amount when it is raised (``_probe``) — a figure
  that only enters a subtraction (``rest = total - water - additives``) or a waste amount books nothing, and
  neither does one that only raises a transport, energy or time amount (``_books_material``);
* a positive exchange in the mass family carries (about) the figure itself — never a negative one: a treatment
  amount is waste leaving, and a cardboard disposal of 0.1 kg once answered for 0.14 kg of zinc;
* a number in a positive mass exchange's formula is the figure and raises the amount (``0.14 / frame_kg``
  books 0.14 kg of zinc per kilogram of frame; ``1 - 0.14`` does not).

``health`` hands in the model's technosphere exchanges and turns each answer into an info finding
(``bom_item_unbooked``).

What this does not see: a part whose mass only scales another material (packaging taken as a share of the
shipping weight), and a part booked only through a processing service sold by the kilogram (moulding, metal
working) — an exchange carries no word of what its provider is.
"""
from __future__ import annotations

import ast
import re

from prism_lca import _log
from prism_lca.engine import units as units_of

#: How close a booked mass has to be to a researched component mass to count as "this component is in the
#: model". Wide on purpose: loss factors (×1.05) and a modeller's deliberate deviation from the researched
#: figure (0.3 kg booked where research said 0.4) are modelling, not gaps.
_BOM_MATCH_TOLERANCE = 1.5

#: How close a figure has to be to the researched mass to BE it — a rounding (8.30 against 8.3), not a
#: neighbourhood. Used where a looser match would let a neighbouring mass answer for the component: a
#: parameter carrying the figure, a typed amount beside such a parameter, a number inside a formula.
_EXACT_TOLERANCE = 1.05

#: Fallback for research entries logged before the masses were stored structured: the BOM tool has always
#: written "component (material): 9 kg" into the finding text.
_BOM_TEXT = re.compile(r"^(.+?)(?:\s*\([^)]*\))?:\s*([0-9]+(?:\.[0-9]+)?)\s*kg\s*$")

#: How far a probe raises a value: one percent of it, always upwards — a negative intermediate parameter
#: multiplied by 1.01 would fall instead. A value of zero is raised by this much outright.
_PROBE = 0.01

#: (unit, amount, formula) of one technosphere exchange, as the caller's pass over the model collects them.
Exchange = tuple[str, float, str]

#: What an exchange measures when it buys something done TO a part rather than the part itself: hauling it
#: (tkm), powering its making (kWh, MJ), running a machine for it (hours). A part's mass raises such an amount
#: wherever the model sums the parts into a shipping weight and carries that — and a part that sits only in the
#: shipping weight was produced nowhere. Volume, area, length and pieces stay bookings: timber is bought by the
#: cubic metre, boards by the square metre, cable by the metre.
_SERVICE_DIMENSIONS = frozenset({"transport", "energy", "time"})


def _books_material(unit: str) -> bool:
    """Whether an exchange in ``unit`` can book a part. A unit we have no dimension for keeps counting, as
    every unit did before: unknown is no evidence of a service."""
    from prism_lca.engine.dataimport.units import dimension

    return dimension(unit) not in _SERVICE_DIMENSIONS


#: (kg, what the research was of) of one researched figure — the product a research_bom call was asked about.
Figure = tuple[float, str]

_BOM_QUESTION = "Bill of materials: "


def _researched(database: str) -> list[tuple[str, Figure, list[Figure]]]:
    """(component, named figure, other figures) per researched part with a mass, one row per name.

    A name is one part, and every figure the log retains for it counts: the ones the research counted, in every
    record of the name, and the others it found beside them (``alternatives_kg``: a variant, a second source). A
    part researched again — a corrected source, another version — is booked by its new figure as much as by its
    old one: this check asks whether the part is in the model, not which figure is right, and the log cannot say
    that either (a later record is not a better one, and a repeat that confirms an older figure is not stored again).
    The figure named is the one the last record of the name counted; the others follow in the order of the log.

    Two limits come with the name as the part's identity. Namesakes — "screws" of the frame and "screws" of the
    lid, researched apart — are one part here, so a booking of either answers for both; the finding names what
    each figure was researched for, so a reader can tell them apart. And every figure brings its own tolerance
    window, so a part with several figures is easier for a neighbouring mass to answer for.
    """
    from prism_lca.engine.research_log import ResearchLogStore

    parts: dict[str, tuple[str, Figure, list[Figure]]] = {}
    for entry in ResearchLogStore().list(database):
        of = " ".join(str(entry.get("question") or "").split()).removeprefix(_BOM_QUESTION)
        of = of if len(of) <= 80 else of[:79].rstrip() + "…"
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
            others = [
                (float(v), of)
                for v in finding.get("alternatives_kg") or []
                if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0
            ]
            key = " ".join(component.lower().split())
            figures = parts[key][2] if key in parts else []
            parts[key] = (component, (float(mass), of), [*figures, (float(mass), of), *others])
    items: list[tuple[str, Figure, list[Figure]]] = []
    for component, named, figures in parts.values():
        others: list[Figure] = []
        for value, of in figures:
            if value != named[0] and all(value != v for v, _of in others):
                others.append((value, of))
        items.append((component, named, others))
    return items


def _within(a: float, b: float, tolerance: float) -> bool:
    return a > 0 and b > 0 and max(a / b, b / a) <= tolerance


def _mass_inputs(exchanges: list[Exchange]) -> list[tuple[float, float, str]]:
    """(kg, kilograms per unit, formula) of every POSITIVE exchange in a mass unit. Exchange units are the
    datasets' long forms ("kilogram"), so they go through MASS_IN_KG, not units.base."""
    out = []
    for symbol, amount, formula in exchanges:
        factor = units_of.MASS_IN_KG.get(symbol.strip().lower())
        if factor is not None and amount and float(amount) > 0:
            out.append((float(amount) * factor, factor, formula))
    return out


def _booked_directly(mass: float, inputs: list[tuple[float, float, str]], tolerance: float) -> bool:
    return any(_within(kg, mass, tolerance) for kg, _f, _formula in inputs)


class _Formulas:
    """The model's parameters evaluated once, and any formula evaluated against them — with one parameter or
    one number in it raised, to read which way the formula moves. ``ValueError`` when the parameters cannot
    be evaluated."""

    def __init__(self, stored: list[dict]) -> None:
        from asteval import Interpreter

        from prism_lca.engine.params import evaluate_overrides

        data = {
            str(p.get("name")): (
                {"formula": p["formula"]} if p.get("formula") else {"amount": float(p.get("amount") or 0)}
            )
            for p in stored
            if p.get("name")
        }
        glo = _project_parameters()
        try:
            self.base = evaluate_overrides("", {}, namespace=(data, glo))
        except Exception as exc:  # noqa: BLE001 — bw2parameters and our own checks raise several kinds
            raise ValueError(str(exc)) from exc
        self.derived = {n: str(spec["formula"]) for n, spec in data.items() if spec.get("formula")}
        self._interp = Interpreter(usersyms={**glo, **self.base}, minimal=True, config={"ifexp": True})

    def value(self, formula: str, raised: str | None = None) -> float | None:
        if raised is not None:
            was = self.base[raised]
            self._interp.symtable[raised] = was + (_PROBE * abs(was) if was else _PROBE)
        try:
            result = self._interp.eval(formula, show_errors=False)
        finally:
            if raised is not None:
                self._interp.symtable[raised] = self.base[raised]
        if self._interp.error or isinstance(result, bool) or not isinstance(result, (int, float)):
            return None
        return float(result)

    @staticmethod
    def way(before: float, after: float) -> int:
        """+1, 0 or -1: which way a value moved, beyond rounding."""
        tol = 1e-12 * max(abs(before), 1e-12)
        return (after > before + tol) - (after < before - tol)

    def moves(self, formula: str, name: str) -> tuple[float, int] | None:
        """(value, -1/0/+1) of ``formula`` and the way it moves when ``name`` alone rises."""
        b, r = self.value(formula), self.value(formula, name)
        return None if b is None or r is None else (b, self.way(b, r))

    def literal_raises(self, formula: str, figure: float, tolerance: float) -> bool | None:
        """Whether raising a number in ``formula`` that is ``figure`` raises the formula's positive value.
        Read from the syntax, so a figure in a comment is no number, and one that is subtracted or switched
        off by a factor of zero raises nothing. None when the formula cannot be evaluated."""
        try:
            tree = ast.parse(formula, mode="eval")
        except SyntaxError:
            return None
        before = self.value(formula)
        if before is None:
            return None
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Constant) and type(node.value) in (int, float)):
                continue
            if not _within(float(node.value), figure, tolerance):
                continue
            was = node.value
            node.value = was * (1 + _PROBE)
            after = self.value(ast.unparse(tree))
            node.value = was
            if after is not None and before > 0 and self.way(before, after) > 0:
                return True
        return False


def _figure_in_formula(
    mass: float, inputs: list[tuple[float, float, str]], formulas: _Formulas | None
) -> bool:
    """A number in a positive mass exchange's formula that is the researched figure and raises the amount
    when it rises: `0.14 / frame_kg` books 0.14 kg of zinc spread over the frame's kilograms; `1 - 0.14`,
    `0.14 * switched_off` and a 0.14 in a comment do not. Where the formula cannot be evaluated, a number that
    stands in its syntax counts — a comment never does."""
    for _kg, factor, formula in inputs:
        if not formula:
            continue
        raises = formulas.literal_raises(formula, mass / factor, _EXACT_TOLERANCE) if formulas else None
        if raises is not None:
            if raises:
                return True
            continue
        try:
            tree = ast.parse(formula, mode="eval")
        except SyntaxError:
            continue
        if any(
            isinstance(n, ast.Constant)
            and type(n.value) in (int, float)
            and _within(float(n.value) * factor, mass, _EXACT_TOLERANCE)
            for n in ast.walk(tree)
        ):
            return True
    return False


def _probe(formulas: _Formulas, carrier: str, exchanges: list[Exchange]) -> tuple[bool, str] | None:
    """Does raising ``carrier`` raise a positive exchange amount along some chain of formulas?

    Asked by the numbers, not the names: `m_other_ingredients = m_fill - m_water - m_additives` names
    `m_additives`, and the water exchange that uses the rest names `m_other_ingredients` — yet raising the
    additives LOWERS the water, and no exchange books them. Each step of a chain (a parameter's formula, an
    exchange's formula) is probed on its own: raise one name, everything else at its value, and read which
    way the formula moves. A chain books the figure when the signs along it multiply to a rise of a positive
    amount. Step by step rather than all at once, because a closed recipe cancels: `water = m_water +
    m_other_ingredients` does not move when `m_water` rises, as the rest falls by as much — and the water is
    booked all the same. A product or a division is read the way the engine computes it; the price is that a
    figure in a divisor (a per-kilogram amount of a part whose mass is the rest of a total) raises that
    amount when the total shrinks, and counts as booked.

    (True, "") when a chain books it. (False, what) when none does, ``what`` saying where the figure goes
    instead: the parameter it lowers, the inputs it lowers, only outputs, or nowhere (switched off, or
    cancelled inside a formula). None when no formula on the way can be evaluated — then the caller keeps
    to what the names say.
    """
    from prism_lca.engine.param_references import names_in

    derived = [(n, f, names_in(f)) for n, f in formulas.derived.items()]
    used = [(f, names_in(f)) for _s, _a, f in exchanges if f]
    judged = lowers_input = enters_output = False
    lowered: str | None = None
    stack, seen = [(carrier, 1)], set()
    while stack:
        name, sign = stack.pop()
        if (name, sign) in seen or name not in formulas.base:
            continue
        seen.add((name, sign))
        for formula, names in used:
            if name not in names or (step := formulas.moves(formula, name)) is None:
                continue
            judged = True
            amount, way = step
            if amount > 0 and way * sign > 0:
                return True, ""
            lowers_input |= amount > 0 and way * sign < 0
            enters_output |= amount < 0 and way != 0
        for other, formula, names in derived:
            if other == name or name not in names or (step := formulas.moves(formula, name)) is None:
                continue
            if step[1]:
                stack.append((other, sign * step[1]))
                if name == carrier and step[1] < 0 and lowered is None:
                    lowered = other
    if not judged:
        return None
    if lowered:
        return False, f"only reduces '{lowered}'"
    if lowers_input:
        return False, "only reduces the input amounts that use it"
    if enters_output:
        return False, "only enters outputs (waste or end-of-life amounts)"
    return False, "moves no input amount — it is switched off or cancels out where it is used"


def _project_parameters() -> dict:
    try:
        from bw2data.parameters import ProjectParameter

        return ProjectParameter.static()
    except Exception as exc:  # noqa: BLE001 — a probe without project parameters reads the model's own
        _log.swallowed(exc, "health_bom._project_parameters")
        return {}


def _unbooked(component: str, detail: str) -> str:
    # A reconciliation task, not a diagnosis: the check compares numbers, so a part booked inside another part,
    # split differently or in another unit lands here too — and "model it or call it cut-off" would then mean
    # booking it twice or recording a cut-off the study never made.
    return (
        f"The bill-of-materials research recorded '{component}' at {detail}, and the check could not match it "
        "to anything the model books. Find it in the model before you change anything: it may sit inside "
        "another part, be split over several inputs, or be booked as pieces, a volume or an area — judge by the "
        "amounts and the sources, not by comments. If it is booked in full, add nothing; where its mass or "
        "product version differs from the research, settle which is right from the sources — ask the user when "
        "they do not decide it — and say why in the process comment. If it is missing in whole or in part, model "
        "what is missing, or leave it out only where the study's cut-off criteria allow it and name it where the "
        "study records its cut-off decisions."
    )


def _only_reduces(component: str, mass: float, carrier: str, what: str) -> str:
    return (
        f"The bill-of-materials research recorded '{component}' at {mass:g} kg. Parameter '{carrier}' carries "
        f"that figure but {what} — no exchange books it. If it is booked another way — its parts one by one, "
        "or as a volume or an area — that is fine and nothing needs to change; otherwise model it, or leave it "
        "out only where the study's cut-off criteria allow it and name it where the study records its cut-off "
        "decisions."
    )


def bom_items_unbooked(database: str, exchanges: list[Exchange]) -> list[tuple[str, str]]:
    """(component, finding text) per researched component mass that no exchange books.

    `exchanges` is (unit, evaluated amount, formula) per technosphere exchange, collected by the caller's
    pass over the model.
    """
    from prism_lca.engine.params import downstream_of, list_params

    items = _researched(database)
    if not items:
        return []
    placed = units_of.base(1.0, "kg")
    if placed is None:  # pragma: no cover — kg is always convertible
        return []
    mass_family = placed[0]
    try:
        stored = list_params(database, with_usage=False)
    except Exception as exc:  # noqa: BLE001 — a linter must not fall over on an unreadable parameter file
        _log.swallowed(exc, "bom_items_unbooked")
        stored = []
    mass_params: list[tuple[str, float]] = []
    for param in stored:
        amount = param.get("amount")
        if not isinstance(amount, (int, float)) or isinstance(amount, bool) or not amount:
            continue
        placed = units_of.base(float(amount), str(param.get("unit") or "").split("/")[0].strip())
        if placed and placed[0] == mass_family and placed[1] > 0:
            mass_params.append((str(param.get("name") or ""), placed[1]))
    inputs = _mass_inputs(exchanges)
    material = [x for x in exchanges if _books_material(x[0])]
    try:
        formulas: _Formulas | None = _Formulas(stored)
    except ValueError as exc:  # unevaluable parameters: the names decide, as they did before the probe
        _log.swallowed(exc, "bom_items_unbooked")
        formulas = None

    def finding(component: str, mass: float) -> str | None:
        """The finding for one researched figure of a component, or None when the model books it."""
        # A typed amount or a formula number that IS the figure books it, whatever the parameters say.
        if _booked_directly(mass, inputs, _EXACT_TOLERANCE) or _figure_in_formula(mass, inputs, formulas):
            return None
        # A parameter that carries the figure is the authoritative trail — when one exists, the question is
        # whether IT feeds anything, and a coincidental exchange of similar size must not answer for it.
        # Measured live on the pavilion model: the pegs' 0.2 kg sat in a dormant parameter, and a 0.22-kg
        # polyurethane-coating exchange two components over would have declared them booked under the wide
        # tolerance.
        #
        # Exact carriers displace loose ones for the same reason, measured on the same model in the next
        # breath: the connectors' 0.3 kg sits at exactly 1.5x of the pegs' 0.2 kg, feeds a live exchange, and
        # answered for them. A parameter holding the figure itself outranks one that merely lies within the
        # deviation tolerance; the loose match exists only for the case where the modeller deviated AND
        # parameterised (researched 0.4, booked as verbinder_masse = 0.3).
        exact = [name for name, value in mass_params if name and _within(value, mass, _EXACT_TOLERANCE)]
        carriers = exact or [
            name for name, value in mass_params if name and _within(value, mass, _BOM_MATCH_TOLERANCE)
        ]
        if not carriers:
            # No parameter trail: a positive mass exchange within the wide tolerance settles it, so a
            # deliberate deviation from the researched figure stays modelling, not a gap.
            if not _booked_directly(mass, inputs, _BOM_MATCH_TOLERANCE):
                return _unbooked(component, f"{mass:g} kg")
            return None
        named: list[str] = []  # carriers some non-zero material exchange formula reaches, if only by name
        serviced: dict[str, list[str]] = {}  # carriers that reach only service exchanges, and their units
        for name in carriers:  # the figure may arrive one step removed, via a derived parameter
            ident = re.compile(r"\b(?:" + "|".join(map(re.escape, downstream_of(stored, name))) + r")\b")
            reached = [unit for unit, amount, f in exchanges if amount and f and ident.search(f)]
            if any(_books_material(unit) for unit in reached):
                named.append(name)
            elif reached:
                serviced[name] = sorted(set(reached))
        if not named:
            if serviced:
                # Where the figure goes is known, and none of it is a booking; whether the part is booked under
                # another figure or inside another part is not — the reconciliation the finding asks for.
                name, used_in = next(iter(serviced.items()))
                detail = (
                    f"{mass:g} kg — parameter '{name}' carries the figure but feeds only exchanges in "
                    f"{', '.join(used_in)} (transport, energy or time), which book no part"
                )
            else:
                detail = f"{mass:g} kg — parameter '{carriers[0]}' carries the figure but feeds no non-zero exchange"
            return _unbooked(component, detail)
        # The probe asks the material exchanges only: a part's mass that raises a shipping weight in a tkm
        # formula, or the kWh of its pressing, carries or processes the part and makes it nowhere.
        verdicts = [(name, _probe(formulas, name, material) if formulas else None) for name in named]
        if any(v is None or v[0] for _n, v in verdicts):
            return None
        name, verdict = verdicts[0]
        return _only_reduces(component, mass, name, verdict[1])

    out: list[tuple[str, str]] = []
    for component, named, others in items:
        text = finding(component, named[0])
        # A booking of another figure the research found for the part (the variant the user's product turned out
        # to be, a later research's corrected figure) books it as well; when none is booked, the finding names the
        # figure last counted and the others beside it.
        if text is None or any(finding(component, other) is None for other, _of in others):
            continue
        out.append((component, text + _other_figures(named, others)))
    return out


#: Other figures of a part a finding names; the check reads them all.
_NAMED_OTHERS = 5


def _other_figures(named: Figure, others: list[Figure]) -> str:
    """The sentence that names a part's other figures and, where they come from other research, what each was
    researched for. It says what they may be rather than which to book: the check cannot tell a corrected figure
    of the part (book one) from a namesake elsewhere in the product (book both); the products they were
    researched for often can."""
    if not others:
        return ""
    shown: dict[str, list[float]] = {}
    for value, of in others[:_NAMED_OTHERS]:
        shown.setdefault(of, []).append(value)
    more = f" and {len(others) - _NAMED_OTHERS} more" if len(others) > _NAMED_OTHERS else ""

    def kg(values: list[float]) -> str:
        return ", ".join(f"{v:g} kg" for v in values)

    if set(shown) == {named[1]}:
        listed = kg(shown[named[1]]) + more
    else:
        listed = "; ".join(f"{kg(values)} for '{of}'" for of, values in shown.items())
        listed += f"{more} (the {named[0]:g} kg for '{named[1]}')"
    return (
        f" Under the same name the research also recorded {listed} — another research of the part, a variant "
        "of it, or a namesake elsewhere in the product; the check matched none of these either."
    )
