"""The short report: a stored-report definition that is never stored.

The "Short reports (w/o AI)" tab used to run on a second, older foundation — its own HTML assembler
and its own Typst block builders next to the pipeline every full report goes through. It had three
tables and nothing of what the pipeline had meanwhile grown: twelve deterministic chapter kinds, five
languages, themes, palettes, the figures. Now the short report is what its name says: the same
pipeline, fed a definition built from the rail's settings and thrown away afterwards.

Two guarantees this module gives, both structural rather than by convention:

* **No model writes anything.** `definition()` admits only ``DETERMINISTIC_KINDS``; a prose kind in the
  section list is a programming error and fails the assertion below. The pipeline gathers the prose
  extras (the tree for a writer, the model context) only when it sees a prose kind, so the short report
  also does not pay for them.
* **Nothing produced by a model is printed either.** The pipeline reads the research log and the review
  log for every render (they feed References and Limitations). Both are outcomes of assistant runs, so
  the short report blanks them.

Everything else — memo, render token, preview cache — is the stored report's machinery under a fixed id.
The memo key is the definition's own fingerprint (`report_snapshot.snapshot_key` hashes methods,
subjects, amount, breakdown, section kinds and options), so ``"short"`` as the id is only a namespace.
"""
from __future__ import annotations

import copy
from datetime import UTC, datetime
from typing import Any

from pydantic import Field

from prism_lca.engine import (
    report_claims,
    report_graph,
    report_pipeline,
    report_render,
    report_snapshot,
    typst_render,
)
from prism_lca.engine._store import now_iso
from prism_lca.engine.report_kinds import DETERMINISTIC_KINDS, KIND_ORDER, PROSE_KINDS
from prism_lca.engine.report_palettes import DEFAULT_PALETTE
from prism_lca.engine.report_pipeline import RenderRequest
from prism_lca.engine.report_render import LCI_DEFAULT_PARTS
from prism_lca.engine.report_store import DEFAULT_INVENTORY_ROWS, ReportStore
from prism_lca.engine.scenarios import ScenarioStore
from prism_lca.errors import PrismError

MethodRef = str | list[str]

#: The report id every short render runs under. Never stored; see the module docstring.
SHORT_ID = "short"

#: Which chapters a short report carries when the rail says nothing. The reading is ISO 14044's:
#: goal & scope, what was modelled, the methods, the results, the breakdown, the checks, the limits,
#: and where the numbers come from. The annex, the dataset index and the glossary are opt-in — they
#: add pages a quick look does not want.
DEFAULT_CONTENTS: dict[str, bool] = {
    "goal_scope": True,
    "system_model": True,
    "inventory": True,
    "methods": True,
    "lcia": True,
    "contribution": True,
    "interpretation_checks": True,
    "limitations": True,
    "appendix": False,
    "datasets": False,
    "references": True,
    "provenance": True,
}

#: Never in a short report, whatever the rail sends: the glossary is resolved by a model (the Resolve
#: button of a full report), and a chapter that only ever says "No abbreviations resolved yet" is noise.
NEVER_IN_SHORT = frozenset({"abbreviations"})


class ShortSettings(RenderRequest):
    """What the rail sends: the study to compute and how to print it. Extends the render request so the
    second half of the two-step render (figures + token) travels in the same body."""

    database: str
    code: str
    methods: list[MethodRef] = Field(min_length=1)
    amount: float = 1.0
    lang: str = "en"
    #: The cover's title and subtitle. Empty title = the reference process's name, as before; an empty
    #: subtitle lets the cover fall back as it does for a stored report (`report_render._cover_subtitle`).
    title: str = ""
    subtitle: str = ""
    #: Empty = the project's default theme / the default colour set (every theme is available).
    template: str = ""
    palette: str = ""
    palette_colors: dict[str, str] | None = None
    #: The variants beside the reference process: ``{"scenario": id}`` for a parameter scenario of the
    #: same process, ``{"code": other}`` for another process of the model (one model only).
    compare: list[dict[str, str]] = Field(default_factory=list)
    #: Contribution dimensions, ``"tag:<family>"`` or ``"geo"``. The first is the report's own breakdown;
    #: every further one becomes a contribution chapter of its own.
    breakdowns: list[str] = Field(default_factory=list)
    #: Chapter kind → on/off; kinds not named take `DEFAULT_CONTENTS`. Prose kinds are ignored.
    contents: dict[str, bool] = Field(default_factory=dict)
    #: Comparison figures and the contribution chart style — the stored report's `options.figures`.
    heatmap: bool = False
    radar: bool = False
    stacked: bool = False
    #: Results chapter: "all" | "lead" | "none".
    per_indicator_charts: str = "all"
    #: Contribution chapter: print the hotspot table under each breakdown.
    hotspots: bool = True
    #: System model: draw the first background tier, how many datasets per process, colour rule.
    background_tier: bool = True
    per_process: int = Field(default=report_graph.DEFAULT_PER_PROCESS, ge=0, le=report_graph.MAX_PER_PROCESS)
    colour_by: str | None = None
    edge_amounts: bool = False
    #: Annex: rows of the elementary-flow table (0 = all).
    inventory_rows: int | None = None
    significance_percent: float = report_claims.DEFAULT_WEAK_DIFFERENCE_PERCENT


class ShortPreviewRequest(ShortSettings):
    page: int = Field(default=1, ge=1)
    ppi: int = Field(default=96, ge=16, le=384)
    reuse: bool = False


def _scenario_names(database: str) -> dict[str, str]:
    return {
        str(s.get("id")): str(s.get("name") or s.get("id"))
        for s in ScenarioStore().list_all(database)
    }


def _in_model(database: str, code: str) -> bool:
    from prism_lca.engine import model

    try:
        model.get_activity(database, code)
    except PrismError:
        return False
    return True


def definition(s: ShortSettings) -> dict[str, Any]:
    """The report dict the pipeline reads — the same shape `ReportStore.create` would store."""
    names = _scenario_names(s.database)
    subjects: list[dict[str, Any]] = [{"database": s.database, "code": s.code}]
    for entry in s.compare:
        scenario = (entry.get("scenario") or "").strip()
        code = (entry.get("code") or "").strip()
        # The variants are what the rail shows ticked, and it lists only this model's scenarios and
        # processes — an entry for anything else has no checkbox, so nobody could untick it. Left out
        # rather than reported: another model's scenario applied to this one computes a variant nobody
        # defined (a parameter of the same name takes its value, the rest are skipped) under its bare id,
        # and a process deleted since was announced on every render as one that "could not be computed".
        if scenario and scenario not in names:
            continue
        if scenario:
            subjects.append(
                {
                    "database": s.database,
                    "code": code or s.code,
                    "scenario": scenario,
                    "scenario_name": names.get(scenario, scenario),
                }
            )
        elif code and code != s.code and _in_model(s.database, code):
            subjects.append({"database": s.database, "code": code})

    contents = {**DEFAULT_CONTENTS, **{k: bool(v) for k, v in s.contents.items()}}
    breakdowns = [d for d in dict.fromkeys(b.strip() for b in s.breakdowns) if d]
    sections: list[dict[str, Any]] = []
    order = 0
    for kind in KIND_ORDER:
        if kind not in DETERMINISTIC_KINDS or kind in NEVER_IN_SHORT or not contents.get(kind):
            continue
        if kind == "contribution":
            if not breakdowns:
                continue
            # One chapter per dimension, the first being the report's own breakdown.
            for n, dim in enumerate(breakdowns):
                sections.append(
                    {
                        **_section(kind, order),
                        "hidden_indicators": [],
                        "hotspots": s.hotspots,
                        **({"aggregate_by": dim} if n else {}),
                    }
                )
                order += 1
            continue
        section = _section(kind, order)
        if kind == "lcia":
            section["per_indicator_charts"] = s.per_indicator_charts
        elif kind == "appendix":
            section["inventory_rows"] = (
                DEFAULT_INVENTORY_ROWS if s.inventory_rows is None else int(s.inventory_rows)
            )
        elif kind == "inventory":
            # The datasets table once: with a "Background datasets" chapter ticked, the inventory keeps
            # its processes and leaves the datasets to that chapter (they printed twice).
            section["inventory_parts"] = (
                [part for part in LCI_DEFAULT_PARTS if part != "datasets"]
                if contents.get("datasets")
                else list(LCI_DEFAULT_PARTS)
            )
            # The tables, not the notes: the default detail is "written" — a description a model writes
            # under the process table — and without one it prints "This section has no text yet", which
            # in a report nobody writes is a false gap (seen in the first visual check).
            section["inventory_detail"] = "list"
        elif kind == "system_model":
            section.update(
                background_tier=s.background_tier,
                per_process=s.per_process,
                colour_by=s.colour_by,
                edge_amounts=s.edge_amounts,
            )
        sections.append(section)
        order += 1
    assert not {sec["kind"] for sec in sections} & set(PROSE_KINDS), "a short report never carries prose"

    if s.template:
        # Same rule as the store: a theme has to exist when it is named, not on the next render.
        ReportStore().get_template(s.template)
    return {
        "id": SHORT_ID,
        # The author's own title, else the reference process. Empty, the cover once fell back to the
        # study's GOAL — a whole sentence as the title, on a cover built for four words.
        "name": s.title.strip() or _reference_name(s.database, s.code),
        "subtitle": s.subtitle.strip(),
        "created": now_iso(),
        # The preview pins its "generated" stamp to this; a new Generate is a new document.
        "updated": now_iso(),
        "lang": s.lang or "en",
        "template": s.template or typst_render.DEFAULT_TEMPLATE,
        "palette": s.palette or DEFAULT_PALETTE,
        "palette_colors": dict(s.palette_colors or {}),
        "amount": float(s.amount or 1.0),
        "aggregate_by": breakdowns[0] if breakdowns else "",
        "cover_image": typst_render.DEFAULT_COVER,
        "client_logo": "",
        "subjects": subjects,
        "methods": [m if isinstance(m, list) else [m] for m in s.methods],
        "options": {
            "intended_public": False,
            "figures": {"heatmap": s.heatmap, "radar": s.radar, "stacked": s.stacked},
            "outlines": {"contents": True, "figures": True, "tables": True},
            "significance_percent": float(s.significance_percent),
        },
        "sections": sections,
    }


def _reference_name(database: str, code: str) -> str:
    """The reference process's name — the cover title. Best-effort: a name is not worth a failed render."""
    try:
        from prism_lca.engine import model as model_engine

        return str(model_engine.get_activity(database, code).get("name") or "")
    except Exception:  # noqa: BLE001 — any lookup failure means "no title of our own"
        return ""


def _section(kind: str, order: int) -> dict[str, Any]:
    return {
        "id": f"short-{kind}-{order}",
        "kind": kind,
        "title": "",
        "order": order,
        "locked": False,
        "text": "",
        "prompt_override": None,
        "extra_instructions": "",
        "source": None,
        "model": None,
        "generated_at": None,
        "based_on": None,
    }


def _body(s: ShortSettings) -> RenderRequest:
    """The pipeline's request shape: only what a render may override. `code` stays unset — the
    definition's first subject IS the reference, and the results table is computed under its state."""
    return RenderRequest(
        figures=s.figures, method_references=s.method_references, render_token=s.render_token
    )


def _without_model_output(inputs: dict[str, Any]) -> dict[str, Any]:
    """Nothing a model produced reaches the short report."""
    inputs = dict(inputs)
    inputs["web_research"] = []
    inputs["review"] = {}
    return inputs


def render_inputs(s: ShortSettings) -> tuple[dict, dict]:
    """The definition and one set of render inputs — `report_pipeline.render_inputs` without the store.

    Mirrors the stored path's memo discipline (a hit refreshes what is cheap or definition-side and
    reuses the study) and its build lock; skips `remember_target`, because a report that does not
    exist must not be kept warm on every model change.
    """
    if not s.methods:
        raise PrismError(
            "The short report needs at least one impact indicator.",
            code="report_incomplete",
            hint="Pick one under “Indicators”.",
        )
    report = definition(s)
    body = _body(s)
    memo_key = report_snapshot.snapshot_key(s.database, SHORT_ID, report, body)
    store = ReportStore()

    def from_memo() -> dict | None:
        served = report_snapshot.memo_get(memo_key)
        if served is None:
            return None
        served["template"] = store.get_template(report.get("template") or "")
        served["identity"] = store.get_identity()
        served["figures"] = body.figures or {}
        served["method_references"] = body.method_references or []
        served["provenance"] = {
            **served["provenance"],
            "generated": datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC"),
        }
        for mutable in ("model_context", "study", "parameters", "scenarios"):
            served[mutable] = copy.deepcopy(served.get(mutable))
        return _without_model_output(served)

    inputs = from_memo()
    if inputs is not None:
        return report, inputs
    with report_snapshot.inputs_build_lock:
        inputs = from_memo()
        if inputs is not None:
            return report, inputs
        computed = report_pipeline._compute_render_inputs(s.database, SHORT_ID, body, report, memo_key)
        return report, _without_model_output(computed)


def preview_key(s: ShortSettings) -> str:
    return report_snapshot.preview_key(s.database, SHORT_ID)


def document(s: ShortSettings, *, use_token: bool = False) -> tuple[dict, dict, dict, dict]:
    """Definition, inputs, Typst sources and render info — the short report's `report_pipeline.document`."""
    spent = (
        report_snapshot.spend_render_token(preview_key(s), s.render_token, s.figures, s.method_references)
        if use_token
        else None
    )
    report, inputs = spent if spent else render_inputs(s)
    if spent:
        # A token carries the inputs as minted; the blanking is idempotent and cheap.
        inputs = _without_model_output(inputs)
    sources, info = report_render.render_sources(report, **report_pipeline.as_kwargs(inputs))
    return report, inputs, sources, info


def preview_sources(s: ShortPreviewRequest) -> tuple[dict, list[str], list[str]]:
    """The typeset sources for one preview — reused across page turns, like the stored report's."""
    key = preview_key(s)
    cached = report_snapshot.preview_get(key) if s.reuse else None
    if cached is not None:
        return cached
    spent = report_snapshot.spend_render_token(key, s.render_token, s.figures, s.method_references)
    report, inputs = spent if spent else render_inputs(s)
    inputs = _without_model_output(inputs)
    sources, info = report_render.render_sources(
        report,
        **report_pipeline.as_kwargs(inputs),
        generated=report.get("updated", "")[:16].replace("T", " "),
    )
    entry = (sources, info["missing_placeholders"], info["unexplained_abbreviations"])
    report_snapshot.preview_put(key, entry)
    return entry


def pdf_stem(report: dict, inputs: dict) -> str:
    study = inputs.get("study") or {}
    activity = (inputs.get("lcia") or {}).get("activity") or {}
    return report_pipeline.safe_name(
        (study.get("goal") or activity.get("name") or "report")[:60].strip() or "report"
    )


__all__ = [
    "DEFAULT_CONTENTS",
    "SHORT_ID",
    "ShortPreviewRequest",
    "ShortSettings",
    "definition",
    "document",
    "pdf_stem",
    "preview_key",
    "preview_sources",
    "render_inputs",
]
