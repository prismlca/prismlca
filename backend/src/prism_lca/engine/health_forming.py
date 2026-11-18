"""The health check's shaping rule: material in primary forms that no forming step in its own process works.

A material dataset ends at the material — the cast slab, the ingot, the granulate. The step that turns it into a
sheet, a profile or a moulded part is a dataset of its own, and a model that links the material without it leaves
that step out of the result. The claim is deliberately narrow: this finds material in primary forms whose first
forming step is missing from the process that buys it. Silence says nothing about whether the rest of the
manufacturing is complete.

Everything it knows comes from the background database's own classification, not from dataset names:

* a **forming step** is a dataset in kilograms whose CPC sits in section 88/89, "manufacturing services on physical
  inputs owned by others" — by that definition it does not contain the material it works;
* **material in primary forms** carries a CPC class that says so ("in ingots or other primary forms", "unwrought",
  "plastics in primary forms") — unless its own production already consumes a forming step, which is how a
  hot-rolled chromium steel and a polystyrene foam slab sit in those classes;
* the CPC hierarchy says which step comes **first**: basic metal manufacturing (886: rolling, extrusion, forging),
  casting (8931, 8932), seamless pipe drawing (88739) and plastics moulding and extrusion (892) start from primary
  forms; forging, pressing and stamping (8933) and metal working (893) start from metal already shaped.

What is fixed here are those few classes of the UN standard. A new or renamed dataset in a later database version is
covered by the class it is given, and nothing has to be kept in step with dataset names. Where the classification
contradicts itself (a "service" that draws its own material, a "product" that draws none) the dataset is judged by
what it consumes, or the process is left unassessed. A dataset without any CPC (BAFU, libraries) leaves its process
unassessed: the check stays silent rather than guess.

The rule reads one process at a time and does not cross process boundaries: a process whose first forming steps
exceed its own material in primary forms works material from its suppliers, so those upstream processes are not
assessed for that material group. Only active links count — a supplier linked at zero passes nothing on.

First steps of one group are summed and no order is demanded among them. ecoinvent's own product datasets mostly link
crude steel with sheet rolling alone (99 of the 293 that use sheet rolling in 3.12, against 7 with hot rolling), so a
rule that asked for hot rolling first would contradict the database. The price: two steps on the same mass (hot,
then sheet rolling, each on half of it) count as covering all of it, and a partly formed material can pass.

``health`` hands in the resolved activities and turns the answers into findings.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from prism_lca import _log
from prism_lca.engine.market_suppliers import is_market, same_product_inputs

STEEL, NONFERROUS, PLASTIC = "steel", "non-ferrous metal", "plastic"

#: CPC classes of material in primary forms, by the group of forming steps that works it. Aluminium (41431) and
#: copper alloys (41413) share one group because the CPC gives their forming steps one class (88602, 8932).
_PRIMARY_CLASSES = (("4112", STEEL), ("41431", NONFERROUS), ("41413", NONFERROUS), ("347", PLASTIC))
#: The same materials once shaped: rolled, drawn or extruded metal, plastic plates, film, packaging and articles.
_SHAPED_CLASSES = (
    ("412", STEEL),
    ("4153", NONFERROUS),
    ("4151", NONFERROUS),
    ("363", PLASTIC),
    ("364", PLASTIC),
    ("369", PLASTIC),
)
#: Scrap of the same metals. Only the question "does this dataset draw its own material?" reads it: a remelter
#: classified as a service draws scrap, not ingot (ecoinvent 3.12: the scrap treatments that deliver
#: `aluminium, wrought alloy`).
_SCRAP_CLASSES = (("39310", STEEL), ("39340", STEEL), ("39361", NONFERROUS), ("39363", NONFERROUS))
#: Forming steps that start from primary forms.
_FIRST_STEPS = (
    ("88601", STEEL),
    ("8931", STEEL),
    ("88739", STEEL),
    ("88602", NONFERROUS),
    ("8932", NONFERROUS),
    ("892", PLASTIC),
)
#: Forming steps that start from metal already shaped: 8933 forging, pressing, stamping; 893 metal working.
_LATER_STEP_PREFIX = "893"

#: kg of a forming step per kg of product, among its producer's own inputs, that make a material "already shaped".
#: A producer consumes its forming at 1 kg per kg (hot rolling in hot-rolled steel, film extrusion in film);
#: half of that leaves room for yields and blends without catching auxiliaries.
_EMBEDDED = 0.5
#: kg of its own material group per kg that a CPC-88/89 dataset may draw and still be the service it is classified
#: as. Services draw only what they lose (sheet rolling 0.09 kg, forging 0.24 kg per kg); a dataset drawing more is
#: a material under a service class (ecoinvent 3.12: `aluminium, wrought alloy`, `casting, steel, lost-wax`).
_DRAWS = 0.5
#: …and above this it has lost material to shaping (lost-wax casting draws 1.89 kg of steel per kg of cast part),
#: below it the material only changed hands (wrought alloy: ingot in, billet out).
_SHAPED_YIELD = 1.2

#: The gap between material in primary forms and its first forming steps that is reported, as a share of the
#: material: forming yields of 0.976–0.994 and cutting allowances move the masses apart by a few per cent.
_GAP = 0.10
#: The most a forming step loses (yield 0.976); a smaller gap is never reported…
_LOSS = 0.025
#: …and a gap between the two is reported when it is as large as one whole input (9 kg of granulate moulded,
#: 1 kg of film granulate with no film step).
_WHOLE_INPUT = 0.9
#: First forming steps more than this share above the process's own material in primary forms work material from
#: elsewhere — the suppliers upstream, or (doubled) material already shaped.
_OVERSHOOT = 1.1

#: What the missing step is, in words, by group — for the message only, never matched against anything.
_STATE = {STEEL: "cast slab or billet", NONFERROUS: "ingot", PLASTIC: "granulate"}
_FIRST_STEP_WORDS = {
    STEEL: "for sheet, hot rolling and then sheet rolling (both); for seamless tube, drawing of pipe; or casting",
    NONFERROUS: "for sheet, sheet rolling; for profiles, section bar extrusion; or casting",
    PLASTIC: "injection moulding, film extrusion or blow moulding",
}

#: (code, message, the activity it is about)
Found = tuple[str, str, Any]


@dataclass(frozen=True)
class Kind:
    """What one background dataset is to this rule."""

    #: "primary" / "shaped" material, "first" / "later" forming step, "unknown" (forming of unclear step),
    #: "unclassified" (no CPC at all).
    role: str
    group: str | None = None
    cpc: str = ""
    cpc_name: str = ""
    #: The forming steps (by reference product) a shaped material's production already consumes.
    embedded: Mapping[str, float] = field(default_factory=dict)


def _cpc(act) -> tuple[str, str]:
    for cls in act.get("classifications") or []:
        if isinstance(cls, (list, tuple)) and len(cls) >= 2 and "CPC" in str(cls[0]).upper():
            code, _, name = str(cls[1]).partition(":")
            return code.strip(), name.strip()
    return "", ""


def _match(code: str, classes: Iterable[tuple[str, str]]) -> str | None:
    return next((group for prefix, group in classes if code.startswith(prefix)), None)


def _material_group(code: str) -> str | None:
    return _match(code, _PRIMARY_CLASSES) or _match(code, _SHAPED_CLASSES)


def _producer(act, hops: int = 2):
    """The dataset that makes what ``act`` sells: a market's largest supplier of its own product, two levels deep."""
    while hops and is_market(act):
        best, best_amount = None, 0.0
        for supplier, amount in same_product_inputs(act, "health_forming"):
            if amount > best_amount:
                best, best_amount = supplier, amount
        if best is None:
            break
        act, hops = best, hops - 1
    return act


def _inputs_per_unit(act) -> list[tuple[Any, float]]:
    """(input dataset, amount per unit of product) of ``act``'s positive technosphere inputs."""
    try:
        production = next((float(e["amount"]) for e in act.production() if float(e["amount"] or 0)), 1.0)
        rows = []
        for e in act.technosphere():
            amount = float(e.get("amount") or 0)
            if amount > 0:
                rows.append((e.input, amount / production))
        return rows
    except Exception as exc:  # noqa: BLE001 - an unreadable producer reads as "nothing known"
        _log.swallowed(exc, "health_forming")
        return []


class Classifier:
    """Kind of each background dataset, read once per health run."""

    def __init__(self) -> None:
        self._seen: dict[tuple, Kind | None] = {}

    def __call__(self, act) -> Kind | None:
        key = tuple(act.key)
        if key not in self._seen:
            self._seen[key] = self._classify(act)
        return self._seen[key]

    def _classify(self, act) -> Kind | None:
        if str(act.get("unit") or "").strip().lower() != "kilogram":
            return None
        code, name = _cpc(act)
        if not code:
            return Kind("unclassified")
        if code[:2] in ("88", "89"):
            return self._service(act, code, name)
        primary = _match(code, _PRIMARY_CLASSES)
        if primary:
            embedded = self._embedded(act)
            return Kind("shaped" if embedded else "primary", primary, code, name, embedded)
        shaped = _match(code, _SHAPED_CLASSES)
        if shaped:
            if self._draws(act).get(shaped, 0.0) < _DRAWS:
                # A product class over a dataset that draws none of its material: a forming step classified as
                # its output (ecoinvent 3.12: `wire drawing, copper` as "Wire of copper"). Its step is unknown.
                return Kind("unknown", shaped, code, name)
            return Kind("shaped", shaped, code, name, self._embedded(act))
        return None

    def _service(self, act, code: str, name: str) -> Kind | None:
        draws = self._draws(act)
        if draws:
            group, amount = max(draws.items(), key=lambda kv: kv[1])
            if amount >= _DRAWS:
                return Kind("shaped" if amount > _SHAPED_YIELD else "primary", group, code, name)
        first = _match(code, _FIRST_STEPS)
        if first:
            return Kind("first", first, code, name)
        if code.startswith(_LATER_STEP_PREFIX):
            return Kind("later", None, code, name)
        return None  # textile, glass, coating, food processing: not forming of these materials

    def _draws(self, act) -> dict[str, float]:
        """kg per kg of each material group — primary, shaped or scrap — the producer behind ``act`` consumes."""
        out: dict[str, float] = {}
        for inp, per_unit in _inputs_per_unit(_producer(act)):
            if str(inp.get("unit") or "").strip().lower() != "kilogram":
                continue
            code = _cpc(inp)[0]
            group = _material_group(code) or _match(code, _SCRAP_CLASSES)
            if group:
                out[group] = out.get(group, 0.0) + per_unit
        return out

    def _embedded(self, act) -> dict[str, float]:
        """Forming steps the producer behind ``act`` already consumes, kg per kg, by reference product.

        An input counts when it is a forming step by the same reading the classifier applies: a service class that
        does not draw its own material, or a product class that draws none. A material bought under a service
        class (`aluminium, wrought alloy`) shapes nothing. Read from the input's own producer only, never further
        down, so no supply-chain loop can recurse."""
        out: dict[str, float] = {}
        for inp, per_unit in _inputs_per_unit(_producer(act)):
            if per_unit < _EMBEDDED or str(inp.get("unit") or "").strip().lower() != "kilogram":
                continue
            if self._is_forming(inp):
                product = str(inp.get("reference product") or inp.get("name") or "")
                out[product] = out.get(product, 0.0) + per_unit
        return out

    def _is_forming(self, act) -> bool:
        code = _cpc(act)[0]
        if code[:2] in ("88", "89"):
            draws = self._draws(act)
            return (max(draws.values()) if draws else 0.0) < _DRAWS and bool(
                _match(code, _FIRST_STEPS) or code.startswith(_LATER_STEP_PREFIX)
            )
        shaped = _match(code, _SHAPED_CLASSES)
        return bool(shaped) and self._draws(act).get(shaped, 0.0) < _DRAWS


@dataclass
class _Line:
    name: str
    product: str
    mass: float
    kind: Kind


@dataclass
class _Process:
    act: Any
    akey: tuple
    lines: list[_Line] = field(default_factory=list)
    unclassified: bool = False
    #: Foreground processes this one takes a positive amount of — the links material can travel along.
    suppliers: set[tuple] = field(default_factory=set)

    def of(self, role: str, group: str | None = None) -> list[_Line]:
        return [ln for ln in self.lines if ln.kind.role == role and (group is None or ln.kind.group == group)]

    def mass(self, role: str, group: str | None = None) -> float:
        return sum(ln.mass for ln in self.of(role, group))


def _collect(
    activities: Iterable[Any], database: str, classify: Classifier, at_end_of_life: Callable[[tuple, Any], bool]
) -> list[_Process]:
    out = []
    for a in activities:
        p = _Process(act=a.act, akey=a.akey)
        for r in a.resolved:
            ex = r.ex
            amount = float(ex.get("amount") or 0)
            if ex.get("type") != "technosphere" or r.inp is None or not r.key:
                continue
            if r.key[0] == database:
                if amount > 0 and tuple(r.key) != tuple(a.akey):
                    p.suppliers.add(tuple(r.key))
                continue
            if amount <= 0 or r.is_treatment is not False:
                continue  # dormant switches, avoided products and treatments are not material bought
            if at_end_of_life(a.akey, ex.get("prism_uid")):
                continue  # nothing is shaped at end of life; recyclate bought there is eol_buys_recyclate's
            kind = classify(r.inp)
            if kind is None:
                continue
            if kind.role == "unclassified":
                p.unclassified = True
                continue
            p.lines.append(
                _Line(str(r.inp.get("name") or ""), str(r.inp.get("reference product") or ""), amount, kind)
            )
        out.append(p)
    return out


def _upstream(start: tuple, adjacency: Mapping[tuple, set]) -> set[tuple]:
    seen: set[tuple] = set()
    stack = list(adjacency.get(start, ()))
    while stack:
        key = stack.pop()
        if key in seen or key == start:
            continue
        seen.add(key)
        stack.extend(adjacency.get(key, ()))
    return seen


def _not_assessed(processes: list[_Process], adjacency: Mapping[tuple, set]) -> dict[tuple, set[str]]:
    """Process -> material groups the rule must not judge there, because forming elsewhere may cover them.
    ``adjacency`` holds the active supplier links only."""
    out: dict[tuple, set[str]] = {}
    for p in processes:
        for group in (STEEL, NONFERROUS, PLASTIC):
            unknown = bool(p.of("unknown", group))
            if unknown:
                out.setdefault(p.akey, set()).add(group)
            if unknown or p.mass("first", group) > _OVERSHOOT * p.mass("primary", group):
                for key in _upstream(p.akey, adjacency):
                    out.setdefault(key, set()).add(group)
    return out


def _kg(mass: float) -> str:
    if mass * 1000 < 999.5:
        return f"{mass * 1000:.3g} g"
    return f"{mass:.3g} kg" if mass < 999.5 else f"{mass:,.0f} kg"


def _class_note(kind: Kind) -> str:
    if kind.cpc[:2] in ("88", "89"):
        # A material under a service class: say why it is read as material, not quote the misleading class.
        return f" (classified CPC {kind.cpc} as a service, but its production draws the metal itself and no forming)"
    return f" (CPC {kind.cpc})"


def _listing(lines: list[_Line], with_cpc: bool = True) -> str:
    parts = [f"{ln.product or ln.name} {_kg(ln.mass)}" + (_class_note(ln.kind) if with_cpc else "") for ln in lines[:4]]
    return "; ".join(parts) + ("; …" if len(lines) > 4 else "")


def _condition(group: str) -> str:
    # "From the slab onwards": electricity for a light later step (roll forming, bending) does not replace rolling.
    return (
        "If the material is a coating, adhesive or binder here rather than a shaped part, this does not apply; if "
        f"this process does the whole shaping from the {_STATE[group]} onwards through its own energy inputs, say so "
        "in the limitations."
    )


def _missing(group: str, primary: list[_Line], first: list[_Line], later: list[_Line], gap: float) -> str:
    total = sum(ln.mass for ln in primary)
    if later and group != PLASTIC and not first:
        steps = _listing(later, with_cpc=False)
        kind = later[0].kind
        return (
            f"Shaping: {_kg(total)} of {group} in primary forms ({_listing(primary)}) is worked here only by "
            f"{steps}, classified as CPC {kind.cpc} \"{kind.cpc_name}\" — a step that starts from metal already "
            f"rolled, extruded or cast to shape. The step before it is missing for {_kg(gap)} — for {group}: "
            f"{_FIRST_STEP_WORDS[group]}. Link it for that mass, or link {group} that is already rolled or "
            f"extruded. {_condition(group)}"
        )
    covered = f" The forming steps linked here ({_listing(first, with_cpc=False)}) cover the rest." if first else ""
    return (
        f"Shaping: {_kg(total)} of {group} in primary forms ({_listing(primary)}) and no forming step for "
        f"{_kg(gap)} of it in this process.{covered} A material dataset ends at the {_STATE[group]}; the step that "
        f"makes the part is a dataset of its own, classified as a manufacturing service (CPC 88/89) — for {group}: "
        f"{_FIRST_STEP_WORDS[group]}. Without it that step is missing from the result: link the one that applies, "
        f"for the mass it shapes, or link the material already shaped. {_condition(group)}"
    )


def _shortfall(p: _Process, group: str) -> Found | None:
    primary = p.of("primary", group)
    total = sum(ln.mass for ln in primary)
    if total <= 0:
        return None
    first = p.of("first", group)
    gap = max(total - sum(ln.mass for ln in first), 0.0)
    smallest = min(ln.mass for ln in primary)
    if gap > _GAP * total or (gap > _LOSS * total and gap >= _WHOLE_INPUT * smallest):
        later = p.of("later") if group != PLASTIC else []
        return ("missing_forming_step", _missing(group, primary, first, later, gap), p.act)
    return None


def _doubled(p: _Process, supplied: set[str]) -> list[Found]:
    """A forming step linked beside a material whose own production already consumes that same step.

    ``supplied``: material groups some process upstream buys in primary forms — the step may be working that
    material, so its group is not judged here."""
    out: list[Found] = []
    steps = p.of("first") + p.of("later")
    reported: set[str] = set()
    for shaped in p.of("shaped"):
        for step in steps:
            per_kg = shaped.kind.embedded.get(step.product)
            if not per_kg or step.product in reported:
                continue
            group = shaped.kind.group or ""
            if group in supplied:
                continue
            linked = sum(s.mass for s in steps if s.product == step.product)
            room = p.mass("primary", group)
            if linked <= _OVERSHOOT * room:
                continue
            reported.add(step.product)
            out.append(
                (
                    "double_forming_step",
                    f"Shaping counted twice: {shaped.product or shaped.name} is already shaped — its production "
                    f"consumes {per_kg:.2g} kg of {step.product} per kg — and this process links {_kg(linked)} of "
                    f"{step.product} on top, more than the {_kg(room)} of {group} in primary forms it could be "
                    "working. Remove the extra step, or link the unshaped material if the forming belongs here.",
                    p.act,
                )
            )
    return out


def forming_findings(
    activities: Iterable[Any], database: str, at_end_of_life: Callable[[tuple, Any], bool]
) -> list[Found]:
    """Every shaping finding of one model, in activity order. ``at_end_of_life(process key, exchange uid)``
    reads the model's phase tags."""
    processes = _collect(activities, database, Classifier(), at_end_of_life)
    adjacency = {p.akey: p.suppliers for p in processes}
    by_key = {p.akey: p for p in processes}
    skip = _not_assessed(processes, adjacency)
    out: list[Found] = []
    for p in processes:
        supplied = {
            group
            for key in _upstream(p.akey, adjacency)
            if key in by_key
            for group in (STEEL, NONFERROUS, PLASTIC)
            if by_key[key].mass("primary", group) > 0
        }
        if p.unclassified:
            continue
        for group in (STEEL, NONFERROUS, PLASTIC):
            if group in skip.get(p.akey, ()):
                continue
            found = _shortfall(p, group)
            if found:
                out.append(found)
        out.extend(_doubled(p, supplied))
    return out
