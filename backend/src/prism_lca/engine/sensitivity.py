"""Sensitivity analysis: one-at-a-time tornado, parameter curve, break-even.

All reuse the parameter apply/restore machinery (M6) + LCIA (M5): set parameter value(s),
recompute the score, restore the baseline. A run may start from a scenario instead of the baseline: its
overrides go in first and stay in for every step, so the bars and curves describe that variant.

**Two ways to score a step.** The tornado and the curve compute their steps from the matrices the model
already has (engine/sensitivity_fast.py): nothing is written, a step takes about a millisecond, and the
LCA lock is held only while the run reads the model. A model that path does not reproduce — or whose
starting point it does not reproduce to rounding — is scored the way every run was before: each step
written into the model, recalculated and solved (:class:`_Session` chooses). The break-even search always
writes.

A run that writes holds ``lca._LCA_LOCK`` across its whole apply→compute→restore span: the apply
mutates GLOBAL bw2data parameter state, and calc endpoints run concurrently in the threadpool —
without the lock a baseline calculation could land between two perturbed applies and silently
return a perturbed score (the RLock is re-entrant, so the nested compute_lcia is fine). Nothing here
takes the command bus or a store: the lock order the rest of the app keeps is LCA → bus → store
(1816eb17), and a sensitivity run holds only the first. The price is that other calculations and
parameter edits wait for a running analysis; the job behind the UI (engine/sensitivity_jobs.py) can be
cancelled between two steps, and every step scores all requested indicators on one factorisation.

Every writing analysis is also a **crash-marked window** (engine/param_window.py). These are the
longest windows in the app — a tornado over twenty parameters is forty solves, a break-even search
fifty — and a process killed inside one leaves the model holding a perturbed value with nothing to
say so. One frame per analysis, re-stamped before each step rather than one frame per step: at any
instant exactly one perturbed set is in the model, and that is the set the marker has to name.

**A step is held to the parameter's rule** (engine/param_rules.py): a recycling rate of 0.97 moved by
+10 % would be 1.067, more bottles back than were sold, and the bar for it was the largest in the chart
and physically meaningless. The step is cut at the rule instead and says so (``limited``).

**A formula-driven parameter** (``b = 2*a``) is varied the way a scenario overrides it: each step goes
through ``scenarios.Plan``, which takes the formula out for the step, the marker names it, and the
restore puts it back. Writing only the number left the formula standing, the recalculation put
``2*a`` straight back, and the sensitivity of ``b`` was silently zero — the defect that survived in
the one path that had not been moved onto the plan. Varying ``b`` on its own is a variation *against*
its formula (``a`` stays where it is), so the answer says so: ``replaces_formula`` names the formula
that was set aside. That is also why the tornado varies only the inputs unless it is asked for others by
name: ``a`` already moves ``b``, and a bar for ``b`` beside it would count the same lever twice. A formula
of numbers alone (``2.5 / 1000``) refers to no other parameter and counts as an input.
"""
from __future__ import annotations

import math
import re
from collections.abc import Callable

from prism_lca.engine import lca, param_rules, param_window, params, scenarios, sensitivity_fast
from prism_lca.errors import PrismError


def _score(database: str, code: str, method, amount: float) -> float:
    return lca.compute_lcia(database, code, method, amount)["score"]


def _unit(method: tuple) -> str:
    from prism_lca.engine.bootstrap import get_bd

    return get_bd().methods[tuple(method)].get("unit", "")


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


#: Called after every solve of a run: ``(done, total, label)``. The job behind the UI's progress bar.
Progress = Callable[[int, int, str], None]
#: Called before every solve: raises :class:`lca.CalcCancelled` to stop, or anything else the caller wants
#: to stop on (the job raises when the model or the workspace changed under it). The window's ``finally``
#: puts the baseline back either way.
Checkpoint = Callable[[], None]

_NAME = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")


def _visible_names(database: str) -> set[str]:
    """Every parameter name a formula of this model can refer to: its own and the workspace's."""
    from bw2data.parameters import ProjectParameter

    return set(params.snapshot_all(database)) | {p.name for p in ProjectParameter.select()}


def _derived(formula: str | None, visible: set[str]) -> bool:
    """A formula over another parameter is *derived*: its drivers already move it, and a bar of its own
    would count the same lever twice. A formula of numbers alone (``2.5 / 1000``) is an input written as
    its arithmetic, and is varied like one."""
    return bool(formula) and bool(set(_NAME.findall(str(formula))) & visible)


def _rules(database: str) -> dict[str, dict]:
    return {p["name"]: (p.get("rule") or {}) for p in params.list_params(database)}


def _broken(rules: dict[str, dict], varied: str, now: dict[str, float]) -> list[dict]:
    """The OTHER parameters a step pushed outside their rule: ``now`` is every parameter's value in the step.

    A step is held to the varied parameter's own rule, but it also moves what is calculated from it: a
    landfill share of 0.95 moved +10 % takes a recycling share ``1 - incineration - landfill`` below 0. The
    score of that step describes a model that cannot exist, and the bar has to say so rather than pass for an
    answer."""
    ruled = {n: r for n, r in rules.items() if r and n != varied}
    return [
        {"param": n, "value": now[n], "allowed": param_rules.describe(r)}
        for n, r in sorted(ruled.items())
        if n in now and param_rules.violates(r, now[n])
    ]


def _variant(database: str, scenario_id: str | None, base_formulas: dict[str, str | None]):
    """``(overrides, name, formulas)`` of the variant a run starts from: the scenario's overrides in stored
    form (numbers and formulas), its display name, and the formula each parameter carries under it."""
    if not scenario_id:
        return {}, "Baseline", dict(base_formulas)
    scenario = scenarios.ScenarioStore().get(scenario_id, database)
    applied = scenarios.plan(scenario, base_formulas)
    return {**applied.numbers, **applied.formula_overrides}, scenario["name"], dict(applied.formulas)


def inputs(database: str, scenario_id: str | None = None) -> dict:
    """What a sensitivity run on this model may vary, with the value each has in the chosen variant.

    ``inputs``: the parameters without a formula, and those whose formula is numbers alone — each with its
    value, unit and rule (``allowed`` is the rule in words). ``derived``: the parameters calculated from
    others, which a run does not vary. A scenario's values are evaluated, not applied
    (:func:`params.evaluate_overrides`): the page asks for this on every model edit, and writing the scenario
    into the model and back each time held the LCA lock for two recalculations."""
    with lca._LCA_LOCK:  # read the model as it stands, never in the middle of another run's window
        base_vals = params.snapshot_all(database)
        base_formulas = params.snapshot_formulas(database)
        overrides, _name, formulas = _variant(database, scenario_id, base_formulas)
        # Only overrides of parameters the model still has: applying a scenario skips the others, and
        # evaluating them would list a deleted parameter as one the run could vary.
        live = {k: v for k, v in overrides.items() if k in base_vals}
        values = params.evaluate_overrides(database, live) if live else dict(base_vals)
        visible = _visible_names(database)
        listed = {p["name"]: p for p in params.list_params(database)}
    out_inputs, out_derived = [], []
    for name in sorted(values):
        meta = listed.get(name, {})
        if _derived(formulas.get(name), visible):
            out_derived.append({"name": name, "formula": formulas.get(name), "value": values[name]})
            continue
        row = {"name": name, "value": values[name], "unit": meta.get("unit") or "", "rule": meta.get("rule") or {}}
        if meta.get("allowed"):
            row["allowed"] = meta["allowed"]
        if formulas.get(name):
            row["formula"] = formulas[name]
        out_inputs.append(row)
    return {"inputs": out_inputs, "derived": out_derived}


def span(entry: dict, baseline: float, mi: int = 0) -> float:
    """How far a parameter moves indicator ``mi``: the stretch its two bars cover from the starting point. Not
    the distance between the two ends — when both steps move the result the same way by the same amount, that
    is zero, and the parameter was ranked last and printed as moving nothing."""
    points = (float(entry["low"][mi]), float(entry["high"][mi]), baseline)
    return max(points) - min(points)


def _scores(database: str, code: str, methods: list, amount: float) -> list[float]:
    """Every indicator on the state the model is in now: the first solve factorises, the rest only swap the
    characterisation (``lca.get_lca``), so three indicators cost about one."""
    return [_score(database, code, m, amount) for m in methods]


class _Session:
    """Where one tornado or curve gets its scores from.

    Entered under the LCA lock, because the run first reads the model's parameters, formulas, rules and
    variants. :meth:`begin` then decides: when the fast path takes the model (engine/sensitivity_fast.py),
    the lock is let go and every step is computed from the run's own copy of the system; otherwise the run
    keeps the lock and writes each step into the model inside a crash-marked window, which the exit
    restores and closes whatever happened in between.
    """

    def __init__(self, database: str, code: str, methods: list, amount: float, label: str) -> None:
        self.database, self.code, self.methods, self.amount, self.label = database, code, methods, amount, label
        self.fast: sensitivity_fast.FastModel | None = None
        self._frame: dict | None = None
        self._held = False
        #: Whether a step has been written: until then the model as it stands IS the baseline.
        self._moved = False

    def __enter__(self) -> _Session:
        lca._LCA_LOCK.acquire()
        self._held = True
        try:
            self.base_vals = params.snapshot_all(self.database)  # only this model's parameters
            self.base_formulas = params.snapshot_formulas(self.database)
        except BaseException:
            self._release()
            raise
        return self

    def begin(self) -> None:
        self.fast = sensitivity_fast.build(self.database, self.code, self.methods, self.amount)
        if self.fast is not None:
            self._release()
        else:
            self._frame = param_window.open_window(self.database, "sensitivity", self.label, self.base_vals, {})

    def scores(self, overrides: dict) -> tuple[list[float], dict[str, float]]:
        """Every indicator, and every parameter's value, with ``overrides`` (and nothing else) changed."""
        if self.fast is not None:
            return self.fast.scores(overrides)
        if overrides or self._moved:  # the baseline is already in the model; writing it again costs a recalculation
            _apply(self.database, self._frame, self.base_vals, overrides, self.base_formulas)
            self._moved = True
        return _scores(self.database, self.code, self.methods, self.amount), params.snapshot_all(self.database)

    def __exit__(self, *_exc) -> None:
        try:
            if self._frame is not None:
                param_window.restore_and_close(self.database, self.base_vals, self._frame)
        finally:
            self._release()

    def _release(self) -> None:
        if self._held:
            self._held = False
            lca._LCA_LOCK.release()


def tornado(database: str, code: str, methods: list, delta: float = 0.1, amount: float = 1.0,
            names: list[str] | None = None, scenario_id: str | None = None,
            progress: Progress | None = None, checkpoint: Checkpoint | None = None) -> dict:
    """Vary each parameter by ±``delta`` on its own, from the chosen variant, and score every indicator.

    ``names`` None: every input (see :func:`inputs`) — a parameter derived from others is varied only when
    named, against its formula (``replaces_formula``). ``scenario_id``: the scenario whose values are the
    starting point; its overrides stay in for every step. Each step is held to the parameter's rule
    (:func:`param_rules.bounded_steps`): a side the rule cut short carries ``limited`` with the rule in
    words, and a parameter the rule leaves no room at all is skipped as ``fixed``. A side that pushes ANOTHER
    parameter outside its rule (a share calculated from this one) carries ``breaks`` (see :func:`_broken`).
    What was left out is listed under ``skipped`` with the reason, so an absent bar is never mistaken for a
    zero one.

    Entries carry one score per indicator, in the order of ``methods``, and come sorted by the :func:`span` of
    the first; a reader showing another indicator sorts again.
    """
    if not 0 < delta < 1:
        raise PrismError(
            f"A sensitivity range of ±{delta * 100:g} % is not possible.",
            code="sensitivity_delta",
            hint="Use a range above 0 and below 100 %; at 100 % a value would reach zero.",
        )
    methods = [lca.resolve_method(m) for m in (methods or [None])]
    note = progress or (lambda *_: None)
    check = checkpoint or (lambda: None)
    with _Session(database, code, methods, amount, "one-at-a-time sensitivity analysis") as run:
        base_vals, base_formulas = run.base_vals, run.base_formulas
        if names is not None:
            _require(list(names), base_vals)
        overrides, variant_name, formulas = _variant(database, scenario_id, base_formulas)
        visible = _visible_names(database)
        rules = _rules(database)
        units = [_unit(m) for m in methods]
        selected = list(dict.fromkeys(names)) if names is not None else sorted(base_vals)
        entries: list[dict] = []
        skipped: list[dict] = []
        note(0, 0, "Preparing the model…")
        run.begin()
        check()
        baseline, start_vals = run.scores(overrides)
        if overrides:
            scenarios.check_applied(database, scenarios.Plan(overrides, base_formulas), variant_name, start_vals)
        plan: list[tuple[str, tuple]] = []
        for name in selected:
            formula = formulas.get(name)
            if _derived(formula, visible) and names is None:
                skipped.append({"param": name, "reason": "has_formula", "formula": formula})
                continue
            val = start_vals[name]
            rule = rules.get(name) or {}
            if not val and rule.get("kind") != "list":
                skipped.append({"param": name, "reason": "zero_value"})
                continue
            steps = param_rules.bounded_steps(rule, val, delta)
            if steps is None:
                skipped.append({"param": name, "reason": "fixed", "allowed": param_rules.describe(rule)})
                continue
            plan.append((name, steps))
        total = 1 + sum(sum(1 for v, _w in steps if v != start_vals[name]) for name, steps in plan)
        done = 1
        note(done, total, "Starting point")
        for name, ((low_v, low_why), (high_v, high_why)) in plan:
            val = start_vals[name]
            sides = []
            breaks: dict[str, list[dict]] = {}
            for v, sign, side in ((low_v, "−", "low"), (high_v, "+", "high")):
                if v == val:  # the rule left this side no room: the starting point is its score
                    sides.append(list(baseline))
                    continue
                check()
                scores, now = run.scores({**overrides, name: v})
                sides.append(scores)
                if broken := _broken(rules, name, now):
                    breaks[side] = broken
                done += 1
                note(done, total, f"{name} {sign}")
            entry = {"param": name, "base": val, "low_value": low_v, "high_value": high_v,
                     "low": sides[0], "high": sides[1]}
            limited = {k: w for k, w in (("low", low_why), ("high", high_why)) if w}
            if limited:
                entry["limited"] = limited
            if breaks:
                entry["breaks"] = breaks
            if _derived(formulas.get(name), visible):
                entry["replaces_formula"] = formulas[name]
            entries.append(entry)
        check()  # an edit during the last step, which no checkpoint before a step would see
    entries.sort(key=lambda e: span(e, baseline[0]), reverse=True)
    out = {"methods": [list(m) for m in methods], "units": units, "baseline": baseline, "delta": delta,
           "scenario": {"id": scenario_id, "name": variant_name} if scenario_id else None,
           "entries": entries}
    if skipped:
        out["skipped"] = skipped
    return out


def curve(database: str, code: str, method, param: str, values: list[float], scenario_ids: list[str | None] | None = None,
          amount: float = 1.0, progress: Progress | None = None, checkpoint: Checkpoint | None = None) -> dict:
    """One indicator against one parameter across ``values``, once per variant (None = the baseline).

    Each curve also carries its ``origin``: the parameter's own value in that variant and the score there,
    which is the point a reader looks for first. A value the parameter's rule does not allow is refused
    before anything is computed — a curve through impossible values is the picture of a model that does not
    exist.
    """
    if not values:
        raise PrismError("A curve needs at least one value.", code="sensitivity_no_values",
                         hint="Give the values to compute, for example from 10 to 30 in 11 points.")
    m = lca.resolve_method(method)
    variants = list(dict.fromkeys(scenario_ids or [None]))
    note = progress or (lambda *_: None)
    check = checkpoint or (lambda: None)
    with _Session(database, code, [m], amount, f"parameter curve of '{param}'") as run:
        base_formulas = run.base_formulas
        _require([param], run.base_vals)
        rules = _rules(database)
        rule = rules.get(param) or {}
        bad = [v for v in values if param_rules.violates(rule, float(v))]
        if bad:
            raise PrismError(
                f"{', '.join(param_rules._num(v) for v in bad)} not allowed for '{param}': "
                f"it must be {param_rules.describe(rule)}.",
                code="param_value_refused",
                hint="Keep the curve inside the values the parameter's rule allows.",
            )
        resolved = [_variant(database, sid, base_formulas) for sid in variants]
        unit = _unit(m)
        total, done = len(variants) * (len(values) + 1), 0
        curves: list[dict] = []
        replaced: str | None = None
        note(0, 0, "Preparing the model…")
        run.begin()
        for sid, (overrides, name, formulas) in zip(variants, resolved, strict=True):
            check()
            start, start_vals = run.scores(overrides)
            if sid:
                scenarios.check_applied(database, scenarios.Plan(overrides, base_formulas), name, start_vals)
            origin = {"value": start_vals[param], "score": start[0]}
            done += 1
            note(done, total, f"{name} · starting point")
            scores = []
            breaks: list[dict] = []
            for i, v in enumerate(values, start=1):
                check()
                step, now = run.scores({**overrides, param: float(v)})
                scores.append(step[0])
                breaks += [{"at": float(v), **b} for b in _broken(rules, param, now)]
                done += 1
                note(done, total, f"{name} · point {i} of {len(values)}")
            curve_out = {"scenario": sid, "name": name, "origin": origin, "scores": scores}
            if breaks:
                curve_out["breaks"] = breaks
            curves.append(curve_out)
            replaced = replaced or formulas.get(param)
        check()  # an edit during the last step, which no checkpoint before a step would see
    out = {"param": param, "method": list(m), "unit": unit, "values": [float(v) for v in values],
           "curves": curves}
    if replaced:
        out["replaces_formula"] = replaced
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
