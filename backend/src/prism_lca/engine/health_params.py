"""Health checks on the model's parameters themselves — what a value may be — as opposed to the inventory
checks of ``health``, which turns these into findings."""
from __future__ import annotations

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
