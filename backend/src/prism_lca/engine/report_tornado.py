"""The parameter tornado of a report: computed for the reference process, kept in the snapshot under
``checks.tornado``, printed in the Interpretation checks chapter beneath the scenario sensitivity check.

The analysis is the Sensitivity analysis tab's (engine/sensitivity.py), held to the same parameter rules,
always on the reference process at its baseline — never under one of the report's scenarios, so the
figure answers one question however the variants of the report are chosen. Its numbers live in the
snapshot for the reason the scenario spread does (``report_checks.sensitivity_rows``): the figure, the
brief and the placeholders a written comment quotes read one list, and cannot disagree. Each indicator's
parameters are ranked by how far they move it (``report_bindings.MAGNITUDE_RANKED``), so "the largest
lever" is a claim the staleness check can hold to its rank.
"""
from __future__ import annotations

import re
from typing import Any

from prism_lca.engine import report_model as rm
from prism_lca.engine.report_i18n import fmt_column, fmt_number, t
from prism_lca.engine.report_tokens import share_text

#: How many parameters each figure shows, largest effect first — the tab's number.
TOP = 10
DEFAULT_DELTA = 0.1


def option(report: dict[str, Any]) -> dict[str, Any] | None:
    """The report's tornado setting, or None while it is off: the indicators (method paths, those the
    report still has, in the report's order; none chosen → the first) and the range."""
    opt = (report.get("options") or {}).get("tornado") or {}
    methods = [list(m) for m in report.get("methods") or []]
    if not opt.get("enabled") or not methods:
        return None
    chosen = [list(m) for m in opt.get("methods") or []]
    picked = [m for m in methods if m in chosen] or methods[:1]
    delta = float(opt.get("delta") or DEFAULT_DELTA)
    return {"methods": picked, "delta": delta if 0 < delta < 1 else DEFAULT_DELTA}


def compute(database: str, code: str, report: dict[str, Any], amount: float) -> dict[str, Any] | None:
    """The tornado for the report's reference process, or None while the option is off. A failure is kept
    as ``{"error": …}`` rather than raised: the chapter says the check could not run, and the rest of the
    report is not held hostage by one parameter formula that breaks at +25 %."""
    from prism_lca.engine import sensitivity
    from prism_lca.errors import PrismError

    opt = option(report)
    if opt is None:
        return None
    try:
        raw = sensitivity.tornado(database, code, opt["methods"], opt["delta"], amount)
    except PrismError as exc:
        return {"error": exc.message, "delta": opt["delta"]}
    return {**raw, "delta": opt["delta"]}


def chapter_selection(text: str, cited: list[str], report: dict[str, Any], label) -> str | None:
    """What a chapter that cites the tornado was written for — its range and indicators — for the staleness
    record (`report_staleness.components`); None for a chapter that does not cite it. The figures are labelled
    by place (`f-tornado-0`) and their numbers depend on the range, so switching the tornado from one indicator
    to another, or from ±10 % to ±25 %, changes what such a chapter is about while the method list stays."""
    if not (any(p.startswith("checks.tornado") for p in cited) or re.search(r"ref:[ft]-tornado-", text)):
        return None
    opt = option(report)
    return "off" if opt is None else f"±{opt['delta'] * 100:g} % on " + ", ".join(label(m) for m in opt["methods"])


def _change_text(value: float, relative: bool, unit: str, lang: str) -> str:
    sign = "+" if value > 0 else ""
    if relative:
        return f"{sign}{fmt_number(round(value, 1), lang)} %"
    return f"{sign}{fmt_number(value, lang)} {unit}".strip()


def _percent(value: float, lang: str) -> str:
    return f"{fmt_number(round(value * 100, 1), lang)} %"


def rows(raw: dict[str, Any] | None, data: dict[str, Any], lang: str = "en") -> list[dict[str, Any]] | None:
    """Per indicator: its parameters ranked by how far they move it, with ready-to-print texts. None while
    the option is off; an empty list when it is on and nothing could be varied (``note`` says why)."""
    if raw is None:
        return None
    if raw.get("error") or not raw.get("entries"):
        return []  # `note` says which
    labels = {tuple(r.get("method") or []): r for r in data.get("results") or []}
    units = {str(p.get("name")): str(p.get("unit") or "") for p in data.get("parameters") or []}
    delta = float(raw.get("delta") or DEFAULT_DELTA)
    delta_text = f"±{_percent(delta, lang)}"
    out: list[dict[str, Any]] = []
    for mi, method in enumerate(raw.get("methods") or []):
        result = labels.get(tuple(method)) or {}
        unit = str(result.get("unit") or (raw.get("units") or [""] * (mi + 1))[mi] or "")
        baseline = float(raw["baseline"][mi])
        relative = baseline != 0

        def change(score: float, base: float = baseline, rel: bool = relative) -> float:
            # In percent of the result — unless the result is 0 (burdens and credits cancelling), where a
            # percentage does not exist: then the change itself, in the result's unit.
            return (score - base) / abs(base) * 100.0 if rel else score - base

        ranked = []
        for e in raw.get("entries") or []:
            low, high = change(float(e["low"][mi])), change(float(e["high"][mi]))
            # The stretch the two bars cover from the result (sensitivity.span): both steps raising it by 10 %
            # is a parameter that moves it, though its two ends are the same.
            ranked.append((max(low, high, 0.0) - min(low, high, 0.0), low, high, e))
        ranked.sort(key=lambda x: x[0], reverse=True)
        moving = [x for x in ranked if x[0] > 0]
        params = []
        for swing, low, high, e in moving[:TOP]:
            base = float(e["base"])
            # How far the step moved the parameter: in percent of its value, or — from 0, where a percentage does
            # not exist (a switch of 0 or 1 starting at 0) — the value it reached.
            step = {
                side: _change_text((float(e[f"{side}_value"]) - base) / abs(base) * 100.0, True, "", lang)
                if base else f"= {fmt_number(float(e[f'{side}_value']), lang)}"
                for side in ("low", "high")
            }
            params.append({
                "name": str(e["param"]),
                "unit": units.get(str(e["param"]), ""),
                "base": base,
                "low_value": float(e["low_value"]),
                "high_value": float(e["high_value"]),
                "low": float(e["low"][mi]),
                "high": float(e["high"][mi]),
                "low_change": low,
                "high_change": high,
                "low_text": _change_text(low, relative, unit, lang),
                "high_text": _change_text(high, relative, unit, lang),
                "swing": swing,
                "swing_text": share_text(swing, lang) if relative else _change_text(swing, False, unit, lang),
                "step_low_text": step["low"],
                "step_high_text": step["high"],
                # The marks of the figure: the step stopped at the parameter's allowed values (*), or pushed
                # another parameter out of its own (!). The rule itself is not carried: its wording is the
                # app's English, and the step texts above already say how far the step went.
                "limited": bool(e.get("limited")),
                "breaks": bool(e.get("breaks")),
                "broken": sorted({str(b["param"]) for side in (e.get("breaks") or {}).values() for b in side}),
            })
        skipped = raw.get("skipped") or []
        out.append({
            "method_label": str(result.get("method_label") or " / ".join(method)),
            "unit": unit,
            "reference": str((data.get("activity") or {}).get("name") or ""),
            "baseline": baseline,
            "relative": relative,
            "delta_percent": round(delta * 100, 1),
            "delta_text": delta_text,
            "parameters": params,
            "more": max(0, len(moving) - TOP),
            "unmoved": len(ranked) - len(moving),
            "not_varied": {
                reason: sum(1 for s in skipped if s.get("reason") == reason)
                for reason in ("has_formula", "zero_value", "fixed")
            },
            # The figure's words, in the report's language: the renderer draws it, and takes no strings of
            # its own into a document.
            "labels": {
                "low": t("figure.tornado_low", lang, delta=_percent(delta, lang)),
                "high": t("figure.tornado_high", lang, delta=_percent(delta, lang)),
                "axis": t("figure.tornado_axis", lang) if relative
                else t("figure.tornado_axis_absolute", lang, unit=unit),
            },
        })
    return out


def note(raw: dict[str, Any] | None, data: dict[str, Any], lang: str) -> str:
    """What the chapter says instead of figures: the check failed, or the model has nothing to vary."""
    if raw is None:
        return ""
    if raw.get("error"):
        return t("checks.tornado_failed", lang, error=str(raw["error"]))
    reference = str((data.get("activity") or {}).get("name") or "")
    if not any(e for e in raw.get("entries") or []):
        return t("checks.tornado_none", lang, reference=reference)
    return ""


def blocks(data: dict[str, Any], figures: dict[str, str], lang: str,
           labels: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """The section under the scenario sensitivity check: heading, what was done, one figure per indicator
    (a table where no figure was drawn), and what the marks and the absent parameters mean. ``labels``: the
    indicator names the rest of the document prints (``report_typst.short_method``)."""
    from prism_lca.engine.report_typst import short_method

    checks = data.get("checks") or {}
    tornado = checks.get("tornado")
    if tornado is None:
        return []
    out: list[dict[str, Any]] = [rm.heading(t("checks.tornado", lang), 3)]
    if not tornado:
        out.append(rm.note(str(checks.get("tornado_note") or "")))
        return out
    first = tornado[0]
    out.append(rm.prose(rm.esc(t("checks.tornado_intro", lang, reference=first["reference"],
                                  delta=first["delta_text"]))))
    for i, row in enumerate(tornado):
        indicator = short_method(row["method_label"], labels) or row["method_label"]
        if not row["parameters"]:
            out.append(rm.note(t("checks.tornado_no_effect", lang, indicator=indicator)))
            continue
        key = rm.chart_key("tornado", row["method_label"])
        caption = t("caption.figure_tornado", lang, indicator=indicator, delta=row["delta_text"])
        if figures.get(key):
            out.append(rm.figure(rm.chart_path(key), caption=caption, label=f"f-tornado-{i}", key=key))
        else:
            out.append(_table(row, caption, f"t-tornado-{i}", lang))
        if row["more"]:
            out.append(rm.note(t("checks.tornado_more", lang, count=fmt_number(float(row["more"]), lang),
                                 indicator=indicator)))
    out += _notes(tornado, lang)
    return out


def _table(row: dict[str, Any], caption: str, label: str, lang: str) -> dict[str, Any]:
    params = row["parameters"]
    bases = fmt_column([p["base"] for p in params], lang)
    return rm.table(
        [t("table.parameter", lang), t("table.value", lang), row["labels"]["low"], row["labels"]["high"]],
        [
            [p["name"] + ("*" if p["limited"] else "") + ("!" if p["breaks"] else ""),
             f"{base} {p['unit']}".strip(), p["low_text"], p["high_text"]]
            for p, base in zip(params, bases, strict=True)
        ],
        caption=caption,
        align_right=[1, 2, 3],
        label=label,
    )


def _notes(tornado: list[dict[str, Any]], lang: str) -> list[dict[str, Any]]:
    """The marks explained once for all indicators, and what was not varied at all."""
    seen: dict[str, dict[str, Any]] = {}
    for row in tornado:
        for p in row["parameters"]:
            seen.setdefault(p["name"], p)
    out: list[dict[str, Any]] = []
    limited = [p for p in seen.values() if p["limited"]]
    if limited:
        items = ", ".join(
            t("checks.tornado_limited_item", lang, name=p["name"], low=p["step_low_text"], high=p["step_high_text"])
            for p in limited
        )
        out.append(rm.note(t("checks.tornado_limited", lang, items=items)))
    breaking = [p for p in seen.values() if p["breaks"]]
    if breaking:
        items = ", ".join(f"{p['name']} → {', '.join(p['broken'])}" for p in breaking)
        out.append(rm.note(t("checks.tornado_breaks", lang, items=items)))
    counts = tornado[0]["not_varied"]
    parts = [
        t(f"checks.tornado_{key}", lang, count=fmt_number(float(counts[reason]), lang))
        for reason, key in (("has_formula", "derived"), ("zero_value", "zero"), ("fixed", "fixed"))
        if counts.get(reason)
    ]
    if parts:
        out.append(rm.note(t("checks.tornado_not_varied", lang, items="; ".join(parts))))
    return out
