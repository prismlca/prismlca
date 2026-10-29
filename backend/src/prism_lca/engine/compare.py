"""Comparison of n subjects (activities, optionally under a scenario) x m LCIA methods."""
from __future__ import annotations

from prism_lca import _log
from prism_lca.engine import lca, param_window, params
from prism_lca.errors import PrismError, scenario_calc_error


def compare(
    store, subjects: list[dict], methods: list, should_cancel=None, stacked_dimensions: list[str] | None = None
) -> dict:
    """subjects: [{database, code, label?, scenario?, amount?}]; methods: [[str,...], ...].
    ``should_cancel`` is checked before every (subject, method) solve — cross-database
    comparisons refactorise per subject and can run long.

    ``stacked_dimensions`` adds `lca.compare_stacked`'s split under ``"stacked"``, computed in the same
    pass: a scenario subject is computed inside an applied parameter window (apply, factorise,
    restore), and asked for its scores and its split in two requests it paid two of them."""
    units: dict[str, str] = {}
    rows: list[dict] = []
    stacked: list[dict] = []

    def _row(s: dict) -> dict:
        db, code = s["database"], s["code"]
        amount = float(s.get("amount", 1.0))
        scores: dict[str, float] = {}
        for m in methods:
            if should_cancel and should_cancel():
                raise lca.CalcCancelled()
            res = lca.compute_lcia(db, code, list(m), amount)
            key = " · ".join(m)
            scores[key] = res["score"]
            units[key] = res["unit"]
        if stacked_dimensions:
            # No store: a scenario subject's window is the one this row is computed in. A split that
            # cannot be computed must not cost the scores: it is left out, and the caller asks
            # `compare-stacked` for it, which says why — after the scores, as before the two came together.
            try:
                stacked.append(
                    lca.compare_stacked([s], methods, stacked_dimensions, should_cancel=should_cancel)
                )
            except lca.CalcCancelled:
                raise
            except Exception as exc:  # noqa: BLE001 — any failure means "ask for this split on its own"
                _log.swallowed(exc, "compare: stacked split")
        return {"label": s.get("label") or code, "database": db, "code": code,
                "scenario": s.get("scenario"), "scores": scores}

    # Only touch parameters (which invalidates the factorisation cache) when a scenario is involved;
    # a plain multi-indicator comparison then reuses one factorisation across all subjects × methods.
    if any(s.get("scenario") for s in subjects):
        # Hold the LCA lock across each apply→compute→restore span: the applies mutate the model's
        # parameter state, and concurrent threadpool calcs would otherwise read it. Parameters are
        # model-scoped, so snapshot/apply/restore per the subject's own database.
        from prism_lca.engine import scenarios as _scen

        with lca._LCA_LOCK:
            for s in subjects:
                if not s.get("scenario"):
                    rows.append(_row(s))
                    continue
                db = s["database"]
                baseline = params.snapshot_all(db)
                scen = store.get(s["scenario"], db)
                applied = _scen.plan(scen, params.snapshot_formulas(db))
                # Marked like every other window: n subjects x m indicators is a long span, and it
                # runs inside a report render, where nobody is watching it (engine/param_window.py).
                frame = param_window.open_window(
                    db, "scenario", scen["name"], baseline, applied.numbers, applied.replaced
                )
                try:
                    params.apply_values(db, {**baseline, **applied.numbers}, applied.formulas)
                    _scen.check_applied(db, applied, scen["name"])
                    row = _row(s)
                    # The override stood in for a formula of the parameter's own — see scenarios.compare_many.
                    if applied.replaces_formula():
                        row["replaces_formula"] = applied.replaces_formula()
                    rows.append(row)
                except lca.CalcCancelled:
                    raise
                except PrismError:
                    raise
                except Exception as exc:  # noqa: BLE001 - clear message instead of an opaque 500
                    raise scenario_calc_error(s.get("label") or s.get("scenario") or "?", exc) from exc
                finally:
                    param_window.restore_and_close(db, baseline, frame)
    else:
        rows = [_row(s) for s in subjects]

    methods_out = [{"method": list(m), "key": " · ".join(m), "unit": units.get(" · ".join(m), "")} for m in methods]
    out: dict = {"methods": methods_out, "subjects": rows}
    if stacked_dimensions:
        out["stacked"] = _merged_stacked(stacked, stacked_dimensions)
    return out


def _merged_stacked(parts: list[dict], dimensions: list[str]) -> dict:
    """Per-subject `compare_stacked` answers as the one answer a request for all of them gives."""
    merged: dict = {"subjects": [], "keys": {d: [] for d in dimensions}, "labels": {d: {} for d in dimensions},
                    "dimensions": dimensions}
    for part in parts:
        merged["subjects"] += part["subjects"]
        for d in dimensions:
            seen = merged["keys"][d]
            seen += [k for k in part["keys"].get(d, []) if k not in seen]
            labels = merged["labels"][d]
            for k, label in part["labels"].get(d, {}).items():
                # The first name wins, as in one traversal of all subjects; a bare key gives way to one.
                if labels.get(k, k) == k:
                    labels[k] = label
    return merged
