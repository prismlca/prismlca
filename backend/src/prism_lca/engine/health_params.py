"""Health checks on the model's parameters themselves — what a value may be, and what a formula or a scenario
may name — as opposed to the inventory checks of ``health``, which turns these into findings."""
from __future__ import annotations

from prism_lca import _log

#: Units a share or a rate is written with when it is written with one at all.
_UNITLESS = {"", "-", "1", "fraction", "share", "ratio"}


def unruled_shares(database: str) -> list[tuple[str, float]]:
    """Parameters that look like a share or a rate and carry no rule: a plain value (no formula) strictly
    between 0 and 1, and no unit.

    A rule is what keeps a scenario and a sensitivity step inside the physically possible: a return rate of
    0.97 moved by +10 % was 1.067 — more bottles back than were sold — and its tornado bar was the largest in
    the chart. The parameter's name cannot settle whether it is a share (an efficiency, a loss, a factor of 0.8
    can each be one), so this is a question to the modeller, never a correction: 0 and 1 themselves are left
    out (a switch looks the same), and so is a parameter with a formula (its drivers carry the rules).
    """
    from prism_lca.engine import params

    out: list[tuple[str, float]] = []
    for p in params.list_params(database):
        if p.get("rule") or p.get("formula"):
            continue
        unit = str(p.get("unit") or "").strip().lower()
        value = p.get("amount")
        if unit in _UNITLESS and isinstance(value, (int, float)) and 0 < value < 1:
            out.append((str(p["name"]), float(value)))
    return out


def unruled_message(found: list[tuple[str, float]]) -> str:
    """The finding for :func:`unruled_shares`, addressed to whoever can act on it: the modeller sets a rule,
    and the assistant — which may not touch an existing parameter's rule — passes the question on."""
    if len(found) == 1:
        name, value = found[0]
        what, listed, which = f"'{name}' = {value:g} has", "", "If it is one"
    else:
        what = f"{len(found)} parameters have"
        listed = ": " + ", ".join(f"{name} ({value:g})" for name, value in found)
        which = "For each that is one"
    return (
        f"{what} no unit, no rule and a value between 0 and 1 — the shape of a share or a rate{listed}. "
        f"{which}, set Allowed: Range, at least 0, at most 1 on the Parameters page — the rule of an existing "
        "parameter is the modeller's to set there by hand, not the assistant's. Without it, a scenario or a "
        "sensitivity step can push the value past 1."
    )


def dead_references(database: str) -> list[tuple[str, str, str, tuple | None, str | None]]:
    """Formulas and scenario overrides that name a parameter the model does not have (V499).

    What a deleted parameter leaves behind: every parameter write fails with "variables aren't defined" while the
    values that used it stay frozen, so a formula of a parameter or an exchange naming nothing is an error. A
    scenario naming nothing is a warning: the override cannot take effect, but the baseline still computes.
    Exact — the names the formula reads against the parameters the model has (engine/param_references.py).

    Returns ``(severity, code, message, activity_key, exchange_uid)``; the caller resolves the key.
    """
    from prism_lca.engine import param_references, params

    try:
        found = param_references.uses(database)
        data, project = params.parameter_namespace(database)
    except Exception as exc:  # noqa: BLE001 — an optional signal, never a reason to fail the linter
        _log.swallowed(exc, "dead_references")
        return []
    defined = set(data) | set(project)
    out: list[tuple[str, str, str, tuple | None, str | None]] = []
    for use in found:
        missing = sorted(use.names - defined)
        if not missing:
            continue
        listed = ", ".join(f"'{n}'" for n in missing)
        which = "is not a parameter" if len(missing) == 1 else "are not parameters"
        if use.kind == "scenario":
            out.append(("warning", "scenario_names_missing_parameter",
                        f"{use.label[0].upper()}{use.label[1:]} names {listed}, which {which} of this model, so "
                        "that override cannot take effect. Take it out of the scenario or create the parameter.",
                        None, None))
            continue
        held, tool = (f"'{use.owner}'", "edit_parameter") if use.kind == "parameter" else ("the amount", "edit_exchange")
        out.append(("error", "formula_names_missing_parameter",
                    f"The formula of {use.label} uses {listed}, which {which} of this model: every parameter write "
                    f"fails until it is fixed, and {held} keeps its last value. Give it a formula or value without "
                    f"it ({tool}), or create the parameter.", use.key, use.uid))
    return out
