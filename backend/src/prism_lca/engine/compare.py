"""Comparison of n subjects (activities, optionally under a scenario) x m LCIA methods."""
from __future__ import annotations

from prism_lca import _log
from prism_lca.engine import (
    compare_inventory,
    difference_run,
    lca,
    method_lookup,
    param_window,
    params,
)
from prism_lca.errors import PrismError, scenario_calc_error


def compare(
    store,
    subjects: list[dict],
    methods: list,
    should_cancel=None,
    stacked_dimensions: list[str] | None = None,
    partial: bool = False,
    inventory: bool = False,
    difference: dict | None = None,
) -> dict:
    """subjects: [{database, code, label?, scenario?, amount?}]; methods: [[str,...], ...].
    ``should_cancel`` is checked before every (subject, method) solve — cross-database
    comparisons refactorise per subject and can run long.

    ``stacked_dimensions`` adds `lca.compare_stacked`'s split under ``"stacked"``, computed in the same
    pass: a scenario subject is computed inside an applied parameter window (apply, factorise,
    restore), and asked for its scores and its split in two requests it paid two of them.

    ``partial``: the methods are resolved before anything is computed; one that does not resolve is named
    under ``not_computed`` with its way out, and every subject is scored for the others. Only when none
    resolves is it an error. Without it, the first wrong method fails the whole matrix — the Results page
    wants that: it computes what a user picked, and a row quietly missing there would go unnoticed.

    ``inventory`` adds each subject's life cycle inventory (``compare_inventory``) to its row, as amounts keyed
    by flow id, and names the flows once under ``inventory_flows``. It is read in the same pass for the reason
    the stacked split is: a scenario subject's window is paid once.

    ``difference`` (``{run, of, at}``) splits why the subjects differ (``difference_run``), read off the same
    solves: ``of`` is every subject of the run, ``at`` where this request's first subject stands among them, and
    ``run`` the token that keeps the run's sides between its requests. The answer is under ``"difference"``."""
    not_computed: list[dict] = []
    if partial:
        found, not_computed = method_lookup.resolve_methods(methods)
        if not found:
            raise method_lookup.none_resolved(not_computed)
        # The installed names, so the answer says what was computed; two spellings of one indicator are one row.
        methods = list(dict.fromkeys(found))
    units: dict[str, str] = {}
    rows: list[dict] = []
    stacked: list[dict] = []
    flow_names: dict[int, dict] = {}

    def _row(s: dict, k: int) -> dict:
        db, code = s["database"], s["code"]
        amount = float(s.get("amount", 1.0))
        scores: dict[str, float] = {}
        amounts: dict[int, float] = {}
        reading = split.reading(k) if split else None

        def read(system, _method) -> None:
            # Off the last method's solve, while the system holds this subject's demand (and a scenario subject's
            # window): the scores' own calculation, not a second one. The flows are named under the same lock,
            # which a workspace switch waits for, so the names come from the workspace the amounts do.
            amounts.update(compare_inventory.inventory_of(system))
            flow_names.update(compare_inventory.flow_details(amounts.keys() - flow_names.keys()))

        # One subject's methods under one hold of the lock when its side is read: another calculation in between
        # would solve the cached system for its own demand, and the side would mix two.
        with difference_run.held(reading):
            for i, m in enumerate(methods):
                if should_cancel and should_cancel():
                    raise lca.CalcCancelled()
                last = inventory and i == len(methods) - 1
                res = lca.compute_lcia(db, code, list(m), amount, observe=_observer(reading, read if last else None))
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
        row = {"label": s.get("label") or code, "database": db, "code": code,
               "scenario": s.get("scenario"), "scores": scores}
        if inventory:
            row["inventory"] = {str(flow): value for flow, value in amounts.items()}
        return row

    # The run is given back however the request ends: a request that fails before its answer must not keep it
    # from expiring with the sides it holds.
    split = difference_run.join(difference, methods, here=subjects) if difference else None
    try:
        # Only touch parameters (which invalidates the factorisation cache) when a scenario is involved;
        # a plain multi-indicator comparison then reuses one factorisation across all subjects × methods.
        if any(s.get("scenario") for s in subjects):
            # Hold the LCA lock across each apply→compute→restore span: the applies mutate the model's
            # parameter state, and concurrent threadpool calcs would otherwise read it. Parameters are
            # model-scoped, so snapshot/apply/restore per the subject's own database.
            from prism_lca.engine import scenarios as _scen

            with lca._LCA_LOCK:
                for k, s in enumerate(subjects):
                    if not s.get("scenario"):
                        rows.append(_row(s, k))
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
                        row = _row(s, k)
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
            rows = [_row(s, k) for k, s in enumerate(subjects)]

        methods_out = [{"method": list(m), "key": " · ".join(m), "unit": units.get(" · ".join(m), "")} for m in methods]
        out: dict = {"methods": methods_out, "subjects": rows}
        if not_computed:
            out["not_computed"] = not_computed
        if stacked_dimensions:
            out["stacked"] = _merged_stacked(stacked, stacked_dimensions)
        if inventory:
            out["inventory_flows"] = {str(k): v for k, v in flow_names.items()}
        if split:
            # After the windows are closed: the split works on the copies read, and holds no scenario open.
            out["difference"] = split.offer(should_cancel=should_cancel)
        return out
    finally:
        if split:
            split.close()


def _observer(*observers):
    """One ``observe`` hook for every reader given (None: not reading)."""
    given = [o for o in observers if o is not None]
    if len(given) <= 1:
        return given[0] if given else None

    def observe(system, method) -> None:
        for o in given:
            o(system, method)

    return observe

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
