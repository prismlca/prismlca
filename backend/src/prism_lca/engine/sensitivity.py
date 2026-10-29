"""Sensitivity analysis: one-at-a-time tornado, parameter sweep, break-even.

All reuse the parameter apply/restore machinery (M6) + LCIA (M5): set parameter value(s),
recompute the score, restore the baseline.

Each analysis holds ``lca._LCA_LOCK`` across its whole apply→compute→restore span: the apply
mutates GLOBAL bw2data parameter state, and calc endpoints run concurrently in the threadpool —
without the lock a baseline calculation could land between two perturbed applies and silently
return a perturbed score (the RLock is re-entrant, so the nested compute_lcia is fine). Nothing here
takes the command bus or a store: the lock order the rest of the app keeps is LCA → bus → store
(1816eb17), and a sensitivity run holds only the first.

Every analysis here is also a **crash-marked window** (engine/param_window.py). These are the
longest windows in the app — a tornado over twenty parameters is forty solves, a break-even search
fifty — and a process killed inside one leaves the model holding a perturbed value with nothing to
say so. One frame per analysis, re-stamped before each step rather than one frame per step: at any
instant exactly one perturbed set is in the model, and that is the set the marker has to name.

**A formula-driven parameter** (``b = 2*a``) is varied the way a scenario overrides it: each step goes
through ``scenarios.Plan``, which takes the formula out for the step, the marker names it, and the
restore puts it back. Writing only the number left the formula standing, the recalculation put
``2*a`` straight back, and the sensitivity of ``b`` was silently zero — the defect that survived in
the one path that had not been moved onto the plan. Varying ``b`` on its own is a variation *against*
its formula (``a`` stays where it is), so the answer says so: ``replaces_formula`` names the formula
that was set aside. That is also why the tornado varies only the inputs — the parameters without a
formula — unless it is asked for others by name: ``a`` already moves ``b``, and a bar for ``b`` beside
it would count the same lever twice.
"""
from __future__ import annotations

import math

from prism_lca.engine import lca, param_window, params, scenarios
from prism_lca.errors import PrismError


def _score(database: str, code: str, method, amount: float) -> float:
    return lca.compute_lcia(database, code, method, amount)["score"]


def _apply(database: str, frame: dict, base_vals: dict, overrides: dict,
           base_formulas: dict[str, str | None]) -> None:
    """One step of a sweep: say what is about to be in the model, then put it there.

    The order is load-bearing — the marker has to be on disk *before* the value is, or the step
    between the two is exactly the unrecorded window this is here to remove.

    The step goes through the same :class:`scenarios.Plan` a scenario does: a number on a parameter
    with a formula takes that formula out for the step (named in the marker, so a crash restores it),
    and the full formula map is written every time, so the step after one on ``b`` sees ``b = 2*a``
    again. ``base_formulas`` is the snapshot taken when the window opened — never re-read inside it,
    where a step may have taken a formula out.
    """
    step = scenarios.Plan(overrides, base_formulas)
    param_window.set_overrides(frame, step.numbers, step.replaced)
    params.apply_values(database, {**base_vals, **step.numbers}, step.formulas)
    # The step is in: the marker stops accepting the previous step's values as ours. Left pending, a
    # crash later in the sweep let the restore take an author's hand edit back to a sweep value it
    # had written earlier.
    param_window.settle(frame)


def _perturbed(database: str, code: str, method, amount: float, frame: dict,
               base_vals: dict, overrides: dict, base_formulas: dict[str, str | None]) -> float:
    _apply(database, frame, base_vals, overrides, base_formulas)
    return _score(database, code, method, amount)


def _require(names: list[str], base_vals: dict) -> None:
    """A parameter the model does not have would be skipped by the write, and every step would score
    the baseline — a flat line that looks like a finding."""
    missing = [n for n in names if n not in base_vals]
    if missing:
        raise PrismError(
            f"Parameter(s) not found in this model: {', '.join(missing)}.",
            code="param_not_found",
            hint="Use the names of this model's own parameters (list_parameters).",
            status_code=404,
        )


def tornado(database: str, code: str, method, delta: float = 0.1, amount: float = 1.0,
            names: list[str] | None = None) -> dict:
    """Vary each parameter by ±``delta`` on its own and rank them by swing.

    ``names`` None: every parameter *without* a formula — the model's inputs. A parameter with a
    formula is varied only when named; its entry then carries ``replaces_formula``. What was left out
    is listed under ``skipped`` with the reason, so an absent bar is never mistaken for a zero one.
    """
    with lca._LCA_LOCK:
        base_vals = params.snapshot_all(database)  # only this model's parameters
        base_formulas = params.snapshot_formulas(database)
        if names is not None:
            _require(list(names), base_vals)
        selected = list(dict.fromkeys(names)) if names is not None else list(base_vals)
        entries: list[dict] = []
        skipped: list[dict] = []
        baseline = 0.0
        unit = ""
        frame = param_window.open_window(
            database, "sensitivity", "one-at-a-time sensitivity analysis", base_vals, {}
        )
        try:
            res = lca.compute_lcia(database, code, method, amount)
            baseline, unit = res["score"], res["unit"]
            for name in selected:
                val = base_vals[name]
                formula = base_formulas.get(name)
                if formula and names is None:
                    skipped.append({"param": name, "reason": "has_formula", "formula": formula})
                    continue
                if not val:
                    skipped.append({"param": name, "reason": "zero_value"})
                    continue
                low = _perturbed(database, code, method, amount, frame, base_vals,
                                 {name: val * (1 - delta)}, base_formulas)
                high = _perturbed(database, code, method, amount, frame, base_vals,
                                  {name: val * (1 + delta)}, base_formulas)
                entry = {"param": name, "base": val, "low": low, "high": high, "swing": abs(high - low)}
                if formula:
                    entry["replaces_formula"] = formula
                entries.append(entry)
            entries.sort(key=lambda e: e["swing"], reverse=True)
        finally:
            param_window.restore_and_close(database, base_vals, frame)
        out = {"baseline": baseline, "unit": unit, "delta": delta, "entries": entries}
        if skipped:
            out["skipped"] = skipped
        return out


def sweep(database: str, code: str, method, param: str, values: list[float], amount: float = 1.0) -> dict:
    with lca._LCA_LOCK:
        base_vals = params.snapshot_all(database)
        base_formulas = params.snapshot_formulas(database)
        _require([param], base_vals)
        points: list[dict] = []
        frame = param_window.open_window(
            database, "sensitivity", f"sensitivity sweep of '{param}'", base_vals, {}
        )
        try:
            for v in values:
                score = _perturbed(database, code, method, amount, frame, base_vals,
                                   {param: float(v)}, base_formulas)
                points.append({"value": float(v), "score": score})
        finally:
            param_window.restore_and_close(database, base_vals, frame)
        out = {"param": param, "points": points}
        if base_formulas.get(param):
            out["replaces_formula"] = base_formulas[param]
        return out


#: How close the two scores must be at a reported break-even, relative to the largest score of A or B
#: seen anywhere on the bracket (not at the point, where both may be near 0). A sign
#: change the bisection narrows down to a point where the difference is still large is a jump, not a
#: crossing (a step in the model — a threshold, a switch between suppliers).
BREAKEVEN_RTOL = 1e-6


def _sign(x: float) -> int:
    return (x > 0) - (x < 0)


def breakeven(database: str, code_a: str, code_b: str, method, param: str,
              lo: float, hi: float, amount: float = 1.0, iterations: int = 48, samples: int = 8) -> dict:
    """Where the scores of A and B are equal as ``param`` moves across [lo, hi].

    The bracket is scanned at ``samples`` equal sub-intervals first, and each sub-interval whose ends
    differ in sign is bisected on its own — so two crossings inside the bracket are both found, where
    testing only the two ends saw the same sign twice and answered "none". A bisected point counts as a
    break-even only if the scores there are finite and equal within :data:`BREAKEVEN_RTOL` of the
    largest score seen on the bracket, or the bisection converged with both sides that close; otherwise
    the sign change was a jump, reported as ``discontinuities``. A root that only touches zero, or two
    inside one sub-interval, is not seen — ``samples`` is the lever.

    Answer: ``found``, ``value`` (the first break-even), ``roots`` (all), and when nothing is found a
    ``reason`` — ``"no_sign_change"`` or ``"discontinuity"`` — with ``best``, the scanned or bisected
    point where the two scores came closest.
    """
    samples = max(1, int(samples))
    with lca._LCA_LOCK:
        base_vals = params.snapshot_all(database)
        base_formulas = params.snapshot_formulas(database)
        _require([param], base_vals)
        frame = param_window.open_window(
            database, "sensitivity", f"break-even search on '{param}'", base_vals, {}
        )

        scale = 0.0  # the largest |score| of A or B seen anywhere on the bracket

        def diff(x: float) -> float:
            nonlocal scale
            _apply(database, frame, base_vals, {param: x}, base_formulas)
            sa = _score(database, code_a, method, amount)
            sb = _score(database, code_b, method, amount)
            for v in (sa, sb):
                if math.isfinite(v):
                    scale = max(scale, abs(v))
            return sa - sb

        roots: list[float] = []
        jumps: list[dict] = []
        seen: list[tuple[float, float]] = []  # (x, difference) of every finite evaluation

        def at(x: float) -> float:
            d = diff(x)
            if math.isfinite(d):
                seen.append((x, d))
            return d

        try:
            grid = [lo + (hi - lo) * i / samples for i in range(samples)] + [hi]
            values = [at(x) for x in grid]
            for i, (x, d) in enumerate(zip(grid, values, strict=True)):
                if d == 0:
                    roots.append(x)
                    continue
                if i == len(grid) - 1:
                    break
                d_next = values[i + 1]
                # By the signs, never by the product: 1e-200 * 1e-200 underflows to 0 and two values of
                # the same sign looked like a crossing.
                if not (math.isfinite(d) and math.isfinite(d_next)) or _sign(d) * _sign(d_next) != -1:
                    continue
                a, b, f_a, f_b = x, grid[i + 1], d, d_next
                fm = d
                x_star: float | None = None
                converged = False
                for _ in range(iterations):
                    mid = (a + b) / 2
                    fm = at(mid)
                    if not math.isfinite(fm):
                        x_star = mid
                        break
                    if fm == 0:
                        x_star, converged = mid, True
                        break
                    if _sign(f_a) * _sign(fm) == -1:
                        b, f_b = mid, fm
                    else:
                        a, f_a = mid, fm
                    if abs(b - a) <= 1e-12 * max(1.0, abs(a), abs(b)):
                        converged = True
                        break
                if x_star is None:
                    x_star = (a + b) / 2
                    fm = at(x_star)
                # Equal within the tolerance of the scores over the WHOLE bracket — at the crossing
                # itself both may be near 0 (A = x − 0.3 against B = 0), and a tolerance relative to them
                # there asked for exact equality. A bisection that converged onto a point where the two
                # sides differ by no more than that is a crossing too; one where they still differ by
                # the jump is not.
                tol = BREAKEVEN_RTOL * scale
                continuous = converged and abs(f_a - f_b) <= tol
                if math.isfinite(fm) and (abs(fm) <= tol or continuous):
                    roots.append(x_star)
                else:
                    jumps.append({"value": x_star, "difference": fm if math.isfinite(fm) else None})
        finally:
            param_window.restore_and_close(database, base_vals, frame)
        roots = sorted(dict.fromkeys(roots))
        out: dict = {"param": param, "value": roots[0] if roots else None, "found": bool(roots),
                     "roots": roots}
        if jumps:
            out["discontinuities"] = jumps
        if not roots:
            out["reason"] = "discontinuity" if jumps else "no_sign_change"
            if seen:
                x, d = min(seen, key=lambda p: abs(p[1]))
                out["best"] = {"value": x, "difference": d}
        if base_formulas.get(param):
            out["replaces_formula"] = base_formulas[param]
        return out
