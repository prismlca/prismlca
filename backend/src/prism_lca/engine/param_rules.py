"""What a parameter's value is allowed to be — Excel's data validation, for parameters.

A rule belongs to the *parameter*, not to a form: an LCA is written over weeks, its numbers arrive from
several people and one of them arrives by Excel import, and "recycling rate = 1.4" is the kind of value that
survives every review because nothing on the page says it cannot be that. So the rule is stored with the
parameter and enforced on every path that writes a value:

  * the parameter's own amount, typed or set by the assistant
  * the amount a formula computes for it (checked after the recalculation, and rolled back if it breaks)
  * a scenario override, typed or imported
  * every cell of a scenario workbook

Four kinds, which is what a modeller actually needs:

  ``positive``   > 0            a mass, a distance, a count
  ``negative``   < 0            a credit, an avoided burden
  ``range``      min ≤ v ≤ max  and with one side left open it *is* the "at least" / "at most" rule
  ``list``       one of these   discrete choices — 0.25, 0.5, 0.75 — shown as chips in the app

Stored shape, in the parameter's own `data` dict beside `unit` and `description`::

    {"kind": "positive"}
    {"kind": "range", "min": 0.0, "max": 1.0}
    {"kind": "range", "max": 1.0}            # ≤ 1, no lower bound
    {"kind": "list", "values": [0.25, 0.5]}

Absent or empty = no rule, which is what every parameter written before this existed has.

Numbers, not text. A parameter's value is a float that formulas compute with — a list of words could not be
one, and a "list" of numbers is what a discrete choice looks like here.
"""
from __future__ import annotations

from prism_lca.errors import PrismError

KINDS = ("positive", "negative", "range", "list")

#: How a rule reads in a message. One place, so the API, the tests and the UI say the same thing.
def describe(rule: dict | None) -> str:
    """The rule as a short phrase, for an error message or a hint under a field."""
    if not rule:
        return "any number"
    kind = rule.get("kind")
    if kind == "positive":
        return "greater than 0"
    if kind == "negative":
        return "less than 0"
    if kind == "range":
        lo, hi = rule.get("min"), rule.get("max")
        if lo is not None and hi is not None:
            return f"between {_num(lo)} and {_num(hi)}"
        if lo is not None:
            return f"at least {_num(lo)}"
        if hi is not None:
            return f"at most {_num(hi)}"
        return "any number"
    if kind == "list":
        return "one of " + ", ".join(_num(v) for v in rule.get("values") or [])
    return "any number"


def _num(v: float) -> str:
    """A number as short as it is exact — `0.5`, not `0.5000000000000001`, and `2` rather than `2.0`."""
    f = float(v)
    return str(int(f)) if f.is_integer() else f"{f:g}"


def check_rule(rule: dict | None) -> dict:
    """Validate a rule itself and return it normalised, or `{}` for "no rule".

    Refused here rather than at the next write: a rule with `min` above `max` accepts nothing, and a
    parameter that cannot be given a value is a worse state than one with no rule at all.
    """
    if not rule:
        return {}
    if not isinstance(rule, dict):
        raise PrismError("A parameter rule must be an object.", code="param_rule_invalid")
    kind = str(rule.get("kind") or "").strip().lower()
    if kind in ("", "none", "any"):
        return {}
    if kind not in KINDS:
        raise PrismError(
            f"Unknown parameter rule '{kind}'.",
            code="param_rule_unknown",
            hint=f"One of: {', '.join(KINDS)}.",
        )
    if kind in ("positive", "negative"):
        return {"kind": kind}
    if kind == "range":
        lo = _as_number(rule.get("min"), "min")
        hi = _as_number(rule.get("max"), "max")
        if lo is None and hi is None:
            raise PrismError(
                "A range needs at least one end.",
                code="param_rule_empty_range",
                hint="Set a minimum, a maximum, or both — one side alone means at least / at most.",
            )
        if lo is not None and hi is not None and lo > hi:
            raise PrismError(
                f"The minimum ({_num(lo)}) is above the maximum ({_num(hi)}).",
                code="param_rule_backwards",
                hint="Swap them, or leave one side empty.",
            )
        out: dict = {"kind": "range"}
        if lo is not None:
            out["min"] = lo
        if hi is not None:
            out["max"] = hi
        return out
    # list
    raw = rule.get("values")
    if isinstance(raw, str):
        raw = [part for part in raw.replace("\n", ";").split(";")]
    values: list[float] = []
    for item in raw or []:
        n = _as_number(item, "value")
        if n is not None and n not in values:
            values.append(n)
    if not values:
        raise PrismError(
            "A list rule needs at least one value.",
            code="param_rule_empty_list",
            hint="Write the allowed values separated by semicolons, for example 0.25; 0.5; 0.75.",
        )
    return {"kind": "list", "values": values}


def _as_number(value: object, what: str) -> float | None:
    """A number, or None for "not given". A comma decimal is accepted — the field is typed by hand."""
    if value is None:
        return None
    text = str(value).strip().replace(",", ".")
    if not text:
        return None
    try:
        return float(text)
    except ValueError as exc:
        raise PrismError(
            f"'{value}' is not a number ({what}).",
            code="param_rule_not_a_number",
            hint="Use a plain number, for example 0.5 or -2.",
        ) from exc


def violates(rule: dict | None, value: float | None) -> str | None:
    """Why `value` breaks `rule`, or None when it does not. Also None for a value that is not there:
    "no value yet" is not a violation, and refusing it would make a parameter uncreatable."""
    if not rule or value is None:
        return None
    kind = rule.get("kind")
    v = float(value)
    if kind == "positive" and not v > 0:
        return "must be greater than 0"
    if kind == "negative" and not v < 0:
        return "must be less than 0"
    if kind == "range":
        lo, hi = rule.get("min"), rule.get("max")
        if lo is not None and v < float(lo) - _EPS:
            return f"must be {describe(rule)}"
        if hi is not None and v > float(hi) + _EPS:
            return f"must be {describe(rule)}"
    if kind == "list":
        allowed = [float(x) for x in rule.get("values") or []]
        if not any(abs(v - a) <= _EPS * max(1.0, abs(a)) for a in allowed):
            return f"must be {describe(rule)}"
    return None


#: Floats do not compare exactly: a range of 0…1 has to accept the 1 that came back from a formula as
#: 0.9999999999999999, and a list of 0.1 the 0.1 that a workbook stored as 0.1000000000000000055.
_EPS = 1e-9


def check_value(rule: dict | None, value: float | None, *, name: str, where: str = "") -> None:
    """Raise unless `value` satisfies `rule`. `where` names the place for the message ("in scenario X")."""
    why = violates(rule, value)
    if why is None:
        return
    place = f" {where}" if where else ""
    raise PrismError(
        f"{_num(value)} is not allowed for '{name}'{place}: it {why}.",
        code="param_value_refused",
        hint=f"The rule on this parameter says the value must be {describe(rule)}.",
    )
