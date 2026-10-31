"""What every value of a report's snapshot prints as — the index the brief and the gate share.

A writer that types a figure out where a placeholder belongs got a refusal saying "reference it as a
placeholder" and nothing else, although the figure was very often exactly what one placeholder prints.
Knowing which one turns the refusal into a repair the gate can carry out itself (`report_numbers`), and
a near miss — a rounded figure, a raw fraction, a dropped sign — into a refusal that names the
placeholder the writer probably meant. The brief is the other half: a writer shown `0.548` writes
"55 %", a writer shown what the document prints copies that, and that the gate can match.

Only what a placeholder can print is indexed: plain numbers as `render_value` formats them, and the
ready-made `…_text` values verbatim. Derivations are not — `percent(a, b)` over every pair of paths would
be guessing which two things a sentence compares.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any

from prism_lca.engine import prose_numbers as pn
from prism_lca.engine import report_data as rd
from prism_lca.engine import report_tokens
from prism_lca.engine.report_i18n import SEPARATORS, fmt_number, normalise

#: Data that is no placeholder material (`report_prompts.placeholder_paths` leaves the same out): the
#: research log, the lookups and the review renumber, the figure data and the translation bookkeeping
#: are nothing a sentence cites, and individual linter findings renumber with every edit. Parameters are
#: left out for another reason: their own rule matches every written form of their value, in their own
#: unit family (`report_numbers._parameter_number_keys`), which a printed form alone cannot.
_SKIP_ROOTS = frozenset(
    {
        "looked_up",
        "web_research",
        "review",
        "translations",
        "system_model",
        "method_references",
        "provenance",
        "parameters",
    }
)
_SKIP_PATHS = frozenset({"health.findings"})
#: Positions and free text: an index is where a member stands, not a figure about it.
_SKIP_KEYS = frozenset({"index", "order", "rank", "description", "classification", "comment"})

#: Where the gate may put a placeholder in place of a typed figure by itself: the results and the
#: shares of the breakdowns. Everything else — the checks, the trade-offs, the model's own inventory —
#: is named in the refusal and left to the writer.
_REPLACEABLE_ROOTS = frozenset(
    {
        "results",
        "first_result",
        "subjects",
        "contribution",
        "contributions",
        "contributions_by_dimension",
        "contribution_subjects",
        "hotspots",
    }
)

#: More than this many values is not a report a sentence can be matched against meaningfully; the
#: index stops rather than slowing every check down.
_MAX_ENTRIES = 20_000

#: How far a typed figure may be from a value and still be named to the writer as the one it probably
#: meant: a rounding ("23" for 22.6), a raw value ("102795" for "1.03e+05"), a dropped sign. Never
#: substituted — only named, because a figure that close may still be a different quantity.
_NEAR = 0.05

#: A ready-made percentage as `share_text` prints it: sign, number, a space and the percent sign.
_PERCENT_TEXT = re.compile(r"^([+\-−]?)(\d[\d.,   ]*)\s?%$")


@dataclass(frozen=True)
class Printed:
    """One placeholder and what it prints today."""

    path: str
    #: Exactly what the placeholder prints, sign included, without a percent sign it carries itself.
    prints: str
    #: The value on the printed scale — 54.8 for a share printed "54.8 %", the score for a score.
    value: float
    #: The unit symbol the figure is written with in prose: "%" for any percentage, the leading symbol
    #: of the indicator or parameter unit otherwise ("kg", "mj"), None when the data does not say.
    symbol: str | None
    #: The placeholder prints its own "%" (`…_text`), so a repair replaces the typed sign as well.
    own_percent: bool
    #: A 0–1 fraction (`share`): printed bare, so prose never shows it as it stands.
    fraction: bool
    #: The unit is an impact ("kg CO2-Eq"): a figure written as one is never a mass of something.
    characterised: bool
    #: The unit as the data states it ("kg CO2-Eq"), for the full comparison a substitution needs.
    unit: str | None
    #: What the member is called, for naming it to the writer.
    label: str
    #: One quantity, however many paths lead to it: `results.0.score` and `subjects.0.results.0.score`
    #: are the same figure, and two paths to one figure are no ambiguity.
    identity: tuple
    replaceable: bool


def _characterised(unit: str | None, extra: frozenset[str]) -> bool:
    head = (unit or "").split("/")[0].strip()
    lead = pn.unit_prefix(head.split(" ", 1)[0], extra) if head else None
    return bool(lead) and bool(pn.CHARACTERISED.search(head[len(lead or "") :]))


def _symbol(unit: str | None, extra: frozenset[str]) -> str | None:
    if not unit:
        return None
    if unit == "%":
        return "%"
    head = unit.split("/")[0].strip().split(" ", 1)[0]
    lead = pn.unit_prefix(head, extra) if head else None
    return pn.UNIT_ALIASES.get(lead, lead) if lead else None


def _member(path: str, data: dict[str, Any]) -> str:
    """The path of the member a value belongs to, under one spelling for the copies `build_data` makes.

    `first_result` is `results.0`, `contribution` is `contributions.0` (and `contribution_subjects`
    its subjects), the first breakdown dimension is `contributions`, and the report's own activity
    assessed as a variant is `results` — and its groups in a breakdown per variant the breakdown's own. Anything else is its own member — two different members that
    print the same figure are two candidates, never one: a variant that happens to equal the baseline
    today must not be bound to the baseline.
    """
    parent = path.rsplit(".", 1)[0]
    for alias, canonical in (
        ("first_result", "results.0"),
        ("contribution_subjects", "contributions.0.subjects"),
        ("contribution", "contributions.0"),
        ("hotspots", "contributions.0.hotspots"),
    ):
        if parent == alias or parent.startswith(f"{alias}."):
            parent = canonical + parent[len(alias) :]
            break
    dims = data.get("breakdown_dimensions") or []
    if dims and parent.startswith(f"contributions_by_dimension.{dims[0]}."):
        parent = "contributions." + parent[len(f"contributions_by_dimension.{dims[0]}.") :]
    activity = data.get("activity") or {}
    m = re.match(r"subjects\.(\d+)\.results\.(.*)$", parent)
    if m:
        subjects = data.get("subjects") or []
        subject = subjects[int(m.group(1))] if int(m.group(1)) < len(subjects) else {}
        if subject.get("code") and subject.get("code") == activity.get("code") and not subject.get("scenario"):
            parent = f"results.{m.group(2)}"
    # …and the same in a breakdown per variant: the baseline's groups are the breakdown's own.
    m = re.match(r"(contributions\.\d+)\.subjects\.(\d+)\.(.*)$", parent)
    if m and activity.get("code"):
        entry = report_tokens.lookup(f"{m.group(1)}.subjects.{m.group(2)}", data)
        if isinstance(entry, dict) and entry.get("variant") == rd.variant_key(activity.get("code"), ""):
            parent = f"{m.group(1)}.{m.group(3)}"
    return parent


#: The forms one measure is printed in: a share as a fraction, a percentage and a text.
_MEASURES = {"share_percent": "share", "share_text": "share", "spread_percent": "spread", "spread_text": "spread"}


def _identity(path: str, value: float, label: str, data: dict[str, Any]) -> tuple:
    """Which quantity a value is: its member (`_member`), its measure, its name and its value.

    The name and the value guard the aliases: a copy that is not one — a breakdown ordered differently,
    a member renamed — differs in one of them and stays a quantity of its own.
    """
    leaf = path.rsplit(".", 1)[-1]
    return (_member(path, data), _MEASURES.get(leaf, leaf), label, round(value, 6))


def unit_key(unit: str) -> str:
    """A unit reduced to what tells it apart: "kg CO2-Eq", "kg CO₂-Äq." and "kg CO2e" are one key
    ("kgco2eq"), "kg SO2-Eq" another, a plain "kg" a third."""
    key = unit.lower().replace("₂", "2").replace("₃", "3")
    key = re.sub(r"äquivalente?|equivalents?|äq|eq", "eq", key)
    key = re.sub(r"co2e(?!q)", "co2eq", key)
    return re.sub(r"[\s\-‑.·_]", "", key)


def same_unit(written: str, e: Printed) -> bool:
    """Whether the words after a typed figure begin with the value's own unit, in full — not only its
    leading symbol: "1.23 kg" (a mass) and "1.23 kg SO2-Eq" are not a 1.23 kg CO2-Eq result."""
    if e.unit is None:
        return False
    want = unit_key(e.unit)
    have = unit_key(written[: len(e.unit) + 16])
    # A denominator the value does not have is another quantity: "kg CO2-Eq/kg" is not "kg CO2-Eq".
    return bool(want) and have.startswith(want) and not have[len(want) : len(want) + 1] == "/"


def _label(parent: Any) -> str:
    if not isinstance(parent, dict):
        return ""
    for key in ("label", "method_label", "name", "key", "flow"):
        if isinstance(parent.get(key), str) and parent[key].strip():
            return parent[key].strip()
    return ""


def parse(number: str, lang: str) -> float | None:
    """A number as typed in prose of this language, or None when it does not read as one."""
    dec, thou = SEPARATORS[normalise(lang)]
    cleaned = number.strip().replace(" ", "").replace(" ", "")
    if thou.strip():
        cleaned = cleaned.replace(thou, "")
    else:
        cleaned = cleaned.replace(" ", "")
    cleaned = cleaned.replace(dec, ".").replace("−", "-")
    try:
        return float(cleaned)
    except ValueError:
        return None


def index(data: dict[str, Any], lang: str) -> list[Printed]:
    """Every value a placeholder can print, with its path, its printed form and its unit."""
    lang = normalise(lang)
    extra = pn.method_units(data)
    out: list[Printed] = []

    def add(path: str, value: Any, parent: Any) -> None:
        leaf = path.rsplit(".", 1)[-1]
        replaceable = path.split(".", 1)[0] in _REPLACEABLE_ROOTS
        label = _label(parent)
        if isinstance(value, str):
            if not leaf.endswith("_text"):
                return
            m = _PERCENT_TEXT.match(value.strip())
            if not m:
                return
            parsed = parse(m.group(2), lang)
            if parsed is None:
                return
            signed = -parsed if m.group(1) in ("-", "\u2212") else parsed
            out.append(
                Printed(
                    path, f"{m.group(1)}{m.group(2).strip()}", signed, "%", True, False, False, "%", label,
                    _identity(path, round(signed, 1), label, data), replaceable,
                )
            )
            return
        unit = report_tokens.unit_of(path, data)
        fraction = unit == "share"
        symbol = None if fraction else _symbol(unit, extra)
        number = float(value)
        # A share is one quantity in all its forms: compared on the printed scale, one decimal.
        scaled = round(number * 100.0, 1) if fraction else round(number, 1) if symbol == "%" else number
        printed = report_tokens.render_value(value, lang, raw=True)
        out.append(
            Printed(
                path, printed, number, symbol, False, fraction, _characterised(unit, extra), unit, label,
                _identity(path, scaled, label, data), replaceable,
            )
        )

    def walk(node: Any, prefix: str, parent: Any) -> None:
        if len(out) >= _MAX_ENTRIES or prefix in _SKIP_PATHS:
            return
        if isinstance(node, dict):
            for key, value in node.items():
                if key in _SKIP_KEYS or (not prefix and key in _SKIP_ROOTS):
                    continue
                walk(value, f"{prefix}.{key}" if prefix else str(key), node)
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{prefix}.{i}", parent)
        elif isinstance(node, bool) or node is None or not prefix:
            return
        elif isinstance(node, (int, float)):
            if math.isfinite(float(node)):
                add(prefix, node, parent)
        elif isinstance(node, str):
            add(prefix, node, parent)

    walk(data, "", None)
    return out


def _preference(e: Printed) -> tuple:
    """Which path to name for a quantity: one that prints its own percent sign, never a bare fraction,
    and otherwise the shortest — `results.0.score` rather than `subjects.0.results.0.score`."""
    return (not e.own_percent, e.fraction, len(e.path), e.path)


def _canonical(entries: list[Printed]) -> list[Printed]:
    """One entry per quantity, under the path a writer would write."""
    best: dict[tuple, Printed] = {}
    for e in entries:
        have = best.get(e.identity)
        if have is None or _preference(e) < _preference(have):
            best[e.identity] = e
    return list(best.values())


@dataclass(frozen=True)
class Claim:
    """What the index says about one figure typed in prose."""

    #: Placeholders that print exactly what was typed, in a unit that fits — one per quantity.
    exact: list[Printed]
    #: Placeholders close to it (rounded, raw, unsigned, a fraction for a percentage), closest first.
    near: list[Printed]


def _fits(e: Printed, symbol: str | None, characterised: bool) -> bool:
    """Whether the unit written after the figure is this value's own.

    Characterised is read one way only: "2 kg CO2-Eq" is never the 2 kg of an inventory flow, while a
    result's "kg CO2-Eq" written as plain "kg" — or as a German "kg CO2-Äq", which the reading does not
    recognise as an impact — is still the result.
    """
    if characterised and not e.characterised and e.symbol not in (None, "%"):
        return False
    if e.fraction:
        return symbol is None
    if e.symbol is None or symbol is None:
        # Unknown on either side is a claimant all the same: it could be meant, so it makes a match
        # ambiguous — it never makes one.
        return True
    return e.symbol == symbol


def claim(
    entries: list[Printed], typed: str, sign: str, symbol: str | None, lang: str, characterised: bool = False
) -> Claim:
    """Which values a typed figure could be: exactly, or nearly.

    `typed` is the figure as written, `sign` the character right before it ("-", "−", "+" or ""),
    `symbol` the unit written after it (as `Printed.symbol`), None when none follows, and
    `characterised` whether that unit is written as an impact.
    """
    sign = "-" if sign == "−" else sign
    written = f"{sign}{typed}"
    exact = [
        e
        for e in entries
        if e.prints.replace("−", "-") in (written, written.lstrip("+")) and _fits(e, symbol, characterised)
        and (not e.own_percent or symbol == "%")
    ]
    exact = _canonical(exact)
    taken = {e.identity for e in exact}
    value = parse(typed, lang)
    gaps: dict[tuple, float] = {}
    members: dict[tuple, list[Printed]] = {}
    if value:
        for e in entries:
            if e.identity in taken:
                continue
            # A fraction stands for a percentage: never near a figure written in kilograms.
            want = "%" if e.fraction else e.symbol
            if symbol is not None and want is not None and want != symbol:
                continue
            if not _fits(e, e.symbol if not e.fraction else None, characterised):
                continue
            # A fraction is compared on both scales: "0.55" and "55 %" are both 0.548 rounded.
            targets = (abs(e.value), abs(e.value) * 100.0) if e.fraction else (abs(e.value),)
            gap = min((abs(value - t) / t for t in targets if t), default=None)
            if gap is None or gap > _NEAR:
                continue
            gaps[e.identity] = min(gap, gaps.get(e.identity, gap))
            members.setdefault(e.identity, []).append(e)
    chosen = {k: _canonical(members[k])[0] for k in gaps}
    near = [chosen[k] for k in sorted(gaps, key=lambda k: (gaps[k], _preference(chosen[k])))]
    return Claim(exact, near)


def describe(e: Printed) -> str:
    """A placeholder and what it prints, for a refusal: `{{path}}` (label) prints “12.3 %”."""
    shown = f"{e.prints} %" if e.own_percent else e.prints
    return f"{{{{{e.path}}}}}" + (f" ({e.label})" if e.label else "") + f" prints “{shown}”"


def as_printed(facts: Any, lang: str) -> Any:
    """The writer's facts with every decimal figure shown as a placeholder prints it.

    A writer copies what it is shown: handed `0.548` it wrote "55" or "54.8 %", handed `102795.3` it
    wrote "102795" — each typed out, each refused. Shown "0.548" in the report's own notation, or the
    "1.03e+05" the document prints, it copies a form the gate can match to its placeholder. Integers
    stay as they are: they are counts and positions.
    """
    if isinstance(facts, dict):
        return {k: as_printed(v, lang) for k, v in facts.items()}
    if isinstance(facts, list):
        return [as_printed(v, lang) for v in facts]
    if isinstance(facts, float) and math.isfinite(facts):
        return fmt_number(facts, lang)
    return facts
