"""What a scenario does to the rules of the parameters it does not set.

A scenario's own values are held to their parameters' rules where they are stored (``check_overrides``). A
parameter computed from them is not: "Steel 100 % recycling" set the recycling share to 1, and the landfill
remainder ``1 - recycling - incineration`` came out at -0.15 % — a small credit nobody asked for, under a
rule of 0 to 1 the modeller had set for exactly this case. Here the model is evaluated under the scenario and
every parameter with a rule that the scenario does not set is held to it; only a rule the scenario breaks
counts, a rule the model already breaks without it is the model's finding.

Creating or rewriting a scenario refuses such a set. Setting one value into an existing scenario only warns:
a sequence of single values passes through states that are not the intended end, and the share that brings
the remainder back may be the next call.
"""
from __future__ import annotations

from prism_lca.engine import param_references, param_rules, params
from prism_lca.engine.scenarios import as_override
from prism_lca.errors import PrismError


def dependent_violations(database: str, overrides: dict) -> list[dict]:
    """The parameters not set by ``overrides`` whose rule the set breaks through their formulas, each as
    ``{name, value, why, allowed, formula, inputs}`` — ``inputs``: the parameters the formula reads that the
    scenario does not set, the ones that could bring the value back. Empty when the set cannot be
    evaluated; ``check_overrides`` says why."""
    if not database or not overrides:
        return []
    listed = params.list_params(database)
    rules = {p["name"]: p.get("rule") or {} for p in listed}
    if not any(rules.values()):
        return []
    try:
        normalised = {str(k): as_override(v) for k, v in overrides.items()}
        namespace = params.parameter_namespace(database)
        after = params.evaluate_overrides(database, normalised, namespace)
        before = params.evaluate_overrides(database, {}, namespace)
    except (ValueError, PrismError):
        return []
    formulas = {p["name"]: p.get("formula") or "" for p in listed}
    found = param_rules.newly_violated(rules, before, after, skip=set(normalised))
    for f in found:
        formula = formulas.get(f["name"]) or ""
        f["formula"] = formula
        f["inputs"] = sorted(param_references.names_in(formula) - set(normalised) - {f["name"]}) if formula else []
    return found


def _sentence(f: dict, where: str) -> str:
    value = param_rules._num(f["value"])
    via = f" — its formula {f['formula']} gives that" if f["formula"] else ""
    return f"'{f['name']}' would be {value} {where}{via}, and its rule says it {f['why']}"


def refuse(database: str, overrides: dict, *, scenario: str = "") -> None:
    """Refuse a scenario under which a parameter it does not set breaks its rule. Raises, or returns quietly."""
    found = dependent_violations(database, overrides)
    if not found:
        return
    where = f"in scenario '{scenario}'" if scenario else "in this scenario"
    others = sorted({name for f in found for name in f["inputs"]})
    raise PrismError(
        "; ".join(_sentence(f, where) for f in found) + ".",
        code="scenario_breaks_dependent_rule",
        hint=(
            f"Set the other inputs in the same scenario as well ({', '.join(repr(n) for n in others)}), so the "
            "computed value stays within its rule — or choose values that leave room for it."
            if others
            else "Choose values that keep the computed parameter within its rule."
        ),
        details={"violations": found},
    )


def warnings(database: str, overrides: dict, *, scenario: str = "") -> list[str]:
    """The same finding as :func:`refuse`, worded as warnings — for one value set into an existing scenario."""
    where = f"in scenario '{scenario}'" if scenario else "in this scenario"
    out = []
    for f in dependent_violations(database, overrides):
        others = f" Set {', '.join(repr(n) for n in f['inputs'])} in the same scenario too." if f["inputs"] else ""
        out.append(_sentence(f, where) + "." + others)
    return out
