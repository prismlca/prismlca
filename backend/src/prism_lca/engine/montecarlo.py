"""Monte Carlo uncertainty analysis (bw2calc, use_distributions).

Samples the uncertain matrix entries (technosphere/biosphere/CF distributions) and
re-evaluates the score each iteration, then summarises the result distribution.

``run`` writes nothing into the model — it samples the matrices and never touches a parameter — so it
is not a parameter window and carries no crash marker. ``compare_ab`` does write, when a subject
names a scenario, and that window is the longest in the app: two paired runs of up to 100 000
iterations each, minutes of solving with the overrides sitting in the model. It is marked
(engine/param_window.py).
"""
from __future__ import annotations

import math
import statistics

from prism_lca.engine import param_window, params
from prism_lca.engine.bootstrap import get_bd
from prism_lca.engine.lca import _LCA_LOCK, _demand_sign, resolve_method
from prism_lca.engine.model import get_activity


def _percentile(sorted_scores: list[float], p: float) -> float:
    if not sorted_scores:
        return 0.0
    k = (len(sorted_scores) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_scores[int(k)]
    return sorted_scores[f] * (c - k) + sorted_scores[c] * (k - f)


def run(database: str, code: str, method, iterations: int = 1000, amount: float = 1.0) -> dict:
    bd = get_bd()
    m = resolve_method(method)
    act = get_activity(database, code)
    iterations = max(1, min(int(iterations), 100_000))

    from bw2calc import LCA

    # Hold the shared LCA lock: scenario/compare paths mutate GLOBAL parameter state inside
    # their apply→restore windows — an unlocked MC sampling run could otherwise observe another
    # request's perturbed technosphere mid-run.
    with _LCA_LOCK:
        # Demand-sign normalisation for treatment activities (see engine.lca._demand_sign).
        lca = LCA({act.id: amount * _demand_sign(act)}, method=m, use_distributions=True)
        lca.lci()
        lca.lcia()
        scores = [float(lca.score)]
        for _ in range(iterations - 1):
            next(lca)
            scores.append(float(lca.score))

    ordered = sorted(scores)
    mean = statistics.mean(scores)
    std = statistics.pstdev(scores) if len(scores) > 1 else 0.0
    return _summary(database, code, m, bd, amount, scores, ordered, mean, std)


def _summary(database, code, m, bd, amount, scores, ordered, mean, std) -> dict:
    return {
        "database": database,
        "code": code,
        "method": list(m),
        "unit": bd.methods[m].get("unit", ""),
        "amount": amount,
        "iterations": len(scores),
        "mean": mean,
        "std": std,
        "cv": (std / mean) if mean else 0.0,
        "min": ordered[0],
        "p5": _percentile(ordered, 0.05),
        "p50": _percentile(ordered, 0.50),
        "p95": _percentile(ordered, 0.95),
        "max": ordered[-1],
    }


def _mc_scores(act, method_tuple, iterations: int, seed: int, amount: float) -> list[float]:
    from bw2calc import LCA

    lca = LCA(
        {act.id: amount * _demand_sign(act)},
        method=method_tuple, use_distributions=True, seed_override=int(seed),
    )
    lca.lci()
    lca.lcia()
    scores = [float(lca.score)]
    for _ in range(iterations - 1):
        next(lca)
        scores.append(float(lca.score))
    return scores


def compare_ab(store, a: dict, b: dict, method, iterations: int = 1000, seed: int = 1234, amount: float = 1.0) -> dict:
    """Paired Monte Carlo of two subjects with common random numbers (same seed) → P(A<B)."""
    from prism_lca.engine import lca as lca_mod

    bd = get_bd()
    m = resolve_method(method)
    iterations = max(2, min(int(iterations), 100_000))

    # Hold the LCA lock across apply→sample→restore: scenario applies mutate GLOBAL parameter
    # state, and concurrent threadpool calcs would otherwise compute against perturbed values.
    with lca_mod._LCA_LOCK:
        def scores_for(s: dict) -> list[float]:
            # Parameters are model-scoped: snapshot/apply/restore the subject's own database.
            db = s["database"]
            baseline = params.snapshot_all(db)
            if not s.get("scenario"):
                # Nothing is written, so there is no window to mark: the restore below is a
                # recalculation of values that never moved.
                act = get_activity(db, s["code"])
                try:
                    return _mc_scores(act, m, iterations, seed, float(s.get("amount", amount)))
                finally:
                    params.apply_values(db, baseline)
            from prism_lca.engine import scenarios as _scen

            scenario = store.get(s["scenario"], db)
            applied = _scen.plan(scenario, params.snapshot_formulas(db))
            frame = param_window.open_window(
                db, "scenario", scenario["name"], baseline, applied.numbers, applied.replaced
            )
            try:
                params.apply_values(db, {**baseline, **applied.numbers}, applied.formulas)
                _scen.check_applied(db, applied, scenario["name"])
                act = get_activity(db, s["code"])
                return _mc_scores(act, m, iterations, seed, float(s.get("amount", amount)))
            finally:
                param_window.restore_and_close(db, baseline, frame)

        sa = scores_for(a)
        sb = scores_for(b)

    diffs = [x - y for x, y in zip(sa, sb, strict=True)]
    n = len(diffs)
    return {
        "a_label": a.get("label") or a["code"],
        "b_label": b.get("label") or b["code"],
        "iterations": n,
        "seed": int(seed),
        "unit": bd.methods[m].get("unit", ""),
        "mean_a": statistics.mean(sa),
        "mean_b": statistics.mean(sb),
        "mean_diff": statistics.mean(diffs),
        "std_diff": statistics.pstdev(diffs) if n > 1 else 0.0,
        "p_a_lt_b": sum(1 for d in diffs if d < 0) / n,
        "p_b_lt_a": sum(1 for d in diffs if d > 0) / n,
    }
