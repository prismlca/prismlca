"""The report pipeline: everything a stored report's render needs, computed once, request-free.

Moved out of `api/v1/report.py`, where 47 % of the router was this module wearing HTTP
clothes: the pipeline took a Starlette `Request` as its first parameter only to reach
`request.app.state`, and the warm-up thread had to invent a fake request (`_AppOnly`) to call it.
The stores it needs are stateless and constructed on use — the established engine pattern
(`health`, `lca` and the store base itself do the same) — so the explicit dependency is simply
"none": callers pass data, not a web context.

`RenderRequest` lives here because it is the pipeline's input contract; the routers' own request
models subclass it. The caches live next door in `report_snapshot`; this module builds what they
hold. One deliberate deviation from the plan sketch: `analysis_snapshot` and the warm-up sit HERE,
not in `report_snapshot` — they orchestrate builds (this module) over caches (that module), and
putting them beside the caches would import this module back and recreate exactly the cycle shape
an earlier refactor removed elsewhere.
"""

from __future__ import annotations

import base64
import copy
import logging
import re
import threading
import time
from datetime import UTC, datetime

from pydantic import BaseModel

from prism_lca import _log
from prism_lca.config import get_settings
from prism_lca.engine import (
    health,
    lca,
    report_graph,
    report_render,
    report_snapshot,
    report_variants,
    scenarios,
)
from prism_lca.engine import params as params_engine
from prism_lca.engine.report_hotspots import best_effort, hotspots
from prism_lca.engine.report_store import DEFAULT_INVENTORY_ROWS, ReportStore
from prism_lca.engine.research_log import ResearchLogStore
from prism_lca.engine.review_log import ReviewLogStore
from prism_lca.engine.scenarios import ScenarioStore
from prism_lca.engine.study import StudyMetaStore
from prism_lca.errors import PrismError

logger = logging.getLogger(__name__)

#: `MethodRef` as the API declares it — a method as a string or a tuple-as-list. Redeclared here
#: (one alias, no logic) rather than imported from `api/v1/deps`, so the engine does not import the
#: API package.
MethodRef = str | list[str]


class RenderRequest(BaseModel):
    """What a render (or a check, or a brief) may override about a stored report.

    The routers' request models subclass this — it is the shape the pipeline reads, so it lives with
    the pipeline.
    """

    #: Reference process for the results; falls back to the report's first subject.
    code: str | None = None
    #: Staleness only: check just these chapters. The dialog asks per chapter so it can show real
    #: progress ("3 of 10 checked") instead of one long silence — the snapshot is shared, so N small
    #: calls cost what one big one did.
    section_ids: list[str] | None = None
    methods: list[MethodRef] | None = None
    amount: float | None = None
    aggregate_by: str | None = None
    #: Charts as SVG, keyed "lcia" / "contribution". Produced in the renderer, where the charting
    #: library lives — the backend never draws, so report figures and on-screen charts cannot diverge.
    figures: dict[str, str] | None = None
    #: `[{name, url, text}]` for the impact-method families in use. The reference table lives in the
    #: renderer (`lib/methodInfo.ts`) next to the "Method reference ↗" links the user already sees;
    #: duplicating it in Python would give the same facts two homes and one of them would rot.
    method_references: list[dict] | None = None
    #: The token `/sources` returned for the render that produced these figures. With it, this request
    #: reuses that computation instead of repeating it — drawing needs the numbers and typesetting needs
    #: the drawing, so the two halves are one interaction and should cost one study, not two.
    render_token: str | None = None
    #: Deliverables only (PDF, bundle): export although placeholders or references print as gaps. The
    #: default refusal is the export gate — a client document with "[missing: …]" in it should be a
    #: decision, never a surprise on page 26.
    allow_gaps: bool = False
    #: Deliverables only: the author exports before approving every chapter, or with gaps. Every page then
    #: says "Draft" — a document sent round for comments must not pass for the finished one.
    draft: bool = False


def significance(report: dict) -> float:
    """The report's own threshold for "too small a difference to call one variant better".

    Read there rather than defaulted in the checker so an older report — stored before the option
    existed — still gets the standard value instead of zero, which would switch the advice off. The
    normalisation itself lives beside the convention it falls back to, because the staleness
    fingerprint records the same number and the two must not disagree about an unset option (V195).
    """
    from prism_lca.engine import report_claims

    return report_claims.weak_percent(report.get("options"))


def image_b64(value: str | None, what: str = "cover image") -> str | None:
    """Validate an uploaded picture and return bare base64 (or None to remove it).

    Checked rather than trusted: the string goes into the store and from there into a Typst project as a
    file, so a truncated upload or a PDF renamed to .png must fail here with a sentence the user can act
    on, not deep inside the compiler with a message about an image it could not decode. `what` names the
    picture in those messages — "the logo is larger than 8 MB" beats a generic complaint.
    """
    from prism_lca.engine import typst_render

    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None
    if raw == typst_render.DEFAULT_COVER:
        return raw  # the shipped picture, stored as a word rather than a copy of its bytes
    if raw.startswith("data:"):
        _, _, raw = raw.partition(",")
    try:
        blob = base64.b64decode(raw, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise PrismError(
            f"The {what} could not be read.",
            code="cover_image_invalid",
            hint="Upload a PNG or JPEG file.",
        ) from exc
    if len(blob) > 8 * 1024 * 1024:
        raise PrismError(
            f"The {what} is larger than 8 MB.",
            code="cover_image_too_large",
            hint="Scale it down — a cover is printed at most 21 cm wide.",
        )
    is_png = blob[:8] == b"\x89PNG\r\n\x1a\n"
    is_jpeg = blob[:3] == b"\xff\xd8\xff"
    if not (is_png or is_jpeg):
        raise PrismError(
            f"The {what} is neither a PNG nor a JPEG.",
            code="cover_image_unsupported",
            hint="Typst can place PNG, JPEG and SVG; export the file as PNG or JPEG.",
        )
    return base64.b64encode(blob).decode("ascii")


def safe_name(stem: str) -> str:
    """A filename that survives every platform we ship on."""
    cleaned = "".join(c if (c.isalnum() or c in " ._-") else "_" for c in stem).strip(" .")
    return (cleaned or "report")[:60]


def render_inputs(database: str, report_id: str, body: RenderRequest) -> tuple[dict, dict]:
    """Everything a stored report needs: the definition (always fresh) and one set of inputs.

    The expensive inputs are memoised under the data fingerprint + model generation (`_INPUTS_MEMO`
    in `report_snapshot`): when nothing that could move a number has moved, the numbers are provably
    the ones already computed, and a palette or theme switch re-typesets in seconds instead of
    re-paying the study (V136). Everything definition-side or per-render is refreshed on a hit — the
    template being the point of the exercise, the "generated" stamp being the honesty of it.
    """
    store = ReportStore()
    report = store.get(database, report_id)
    memo_key = report_snapshot.snapshot_key(database, report_id, report, body)
    # Every expensive path runs through here — a check, a brief, a preview, a PDF — so this is where
    # "somebody is working on this report" is known, whichever endpoint they came in through.
    report_snapshot.remember_target(memo_key[0], database, report_id)

    def from_memo() -> dict | None:
        served = report_snapshot.memo_get(memo_key)
        if served is None:
            return None
        # Definition-side, cheap, or per-render — never served from the memo:
        served["template"] = store.get_template(report.get("template") or "")
        served["identity"] = store.get_identity()
        served["figures"] = body.figures or {}
        served["method_references"] = body.method_references or []
        served["provenance"] = {
            **served["provenance"],
            "generated": datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC"),
        }
        served["web_research"] = ResearchLogStore().list(database)
        served["review"] = ReviewLogStore().for_report(database, lca.model_generation())
        # Deep-copied because the translation layer substitutes INTO these dicts during the render —
        # the memo must keep the untranslated record, or the candidate list would drift render by
        # render. Exactly the four the translation walk touches (engine/report_translations._sites).
        for mutable in ("model_context", "study", "parameters", "scenarios"):
            served[mutable] = copy.deepcopy(served.get(mutable))
        return served

    inputs = from_memo()
    if inputs is not None:
        return report, inputs
    # One build at a time, like the checking snapshot next door: opening the report page kicks off
    # the staleness check, and pressing Preview a breath later used to compute the SAME study a
    # second time in parallel — both serialised on the LCA lock anyway, so the second caller waits
    # here instead and is served from the memo the first one filled (V137).
    with report_snapshot.inputs_build_lock:
        inputs = from_memo()
        if inputs is not None:
            return report, inputs
        return report, _compute_render_inputs(database, report_id, body, report, memo_key)


def _compute_render_inputs(
    database: str, report_id: str, body: RenderRequest, report: dict, memo_key: tuple
) -> dict:
    """The actual study: every subject's LCIA, the breakdowns, the inventory — the expensive half
    of `render_inputs`, always entered under `report_snapshot.inputs_build_lock`.

    Counts its solves as it goes (`report_snapshot.build_progress`), so the page waiting on it can
    draw a bar instead of a clock."""
    progress = report_snapshot.BuildProgress(database, report_id)
    try:
        return _build_render_inputs(database, report_id, body, report, memo_key, progress)
    finally:
        progress.close()


def _build_render_inputs(
    database: str,
    report_id: str,
    body: RenderRequest,
    report: dict,
    memo_key: tuple,
    progress: report_snapshot.BuildProgress,
) -> dict:
    store = ReportStore()
    settings = get_settings()
    scenario_store = ScenarioStore()
    stored_subjects = report.get("subjects") or []
    code = body.code or (stored_subjects[0] if stored_subjects else {}).get("code")
    methods = body.methods or report.get("methods") or []
    if not code or not methods:
        raise PrismError(
            "The report needs a reference process and at least one impact method.",
            code="report_incomplete",
            # Read by people now, not only by a caller: the chapter editor shows this beside the button
            # that hit it, so it names the panel to go to rather than the fields to pass.
            hint="Pick both under “Scope & indicators”.",
        )
    amount = float(body.amount if body.amount is not None else report.get("amount", 1.0))
    background, backgrounds = _referenced_backgrounds(database)
    # ---- everything the numbers need, grouped by PARAMETER STATE (V138) -------------------------
    # Applying a scenario rewrites the model's parameters and drops the factorised matrix, so every
    # apply→restore pair costs a fresh factorisation — seconds each on ecoinvent. The old build
    # opened a fresh window per indicator × per variant and paid ~13 factorisations for 3 states;
    # grouped by state, each distinct parameter state is entered ONCE, and everything that needs it —
    # the subject's LCIA, its breakdown per indicator, and for the reference state the lead
    # breakdowns, the prose tree and the annex inventory — runs inside that one window.
    # `body.code` wins over the stored subject's code — as it already did for `ref_tasks` below. With the
    # stored code winning here, a request with code=B computed the totals for A and the contributions for
    # B, and one document carried two functional systems.
    specs = [
        {"code": body.code or spec.get("code") or code, "scenario": spec.get("scenario") or None, "spec": spec}
        for spec in (stored_subjects or [{"database": database, "code": code}])
    ]
    # The request may override it (the ad-hoc preview does), but the report's own setting is the default.
    aggregate_by = body.aggregate_by or report.get("aggregate_by") or ""
    kinds = {s.get("kind") for s in report.get("sections") or []}
    # Every breakdown dimension the document needs: the report's own first, then each contribution
    # chapter's own (a second chapter split by another tag family — the short report's "breakdowns"
    # list). One traversal per dimension × variant × indicator; `contribution` solves once
    # adjointly and never again inside the traversal, so the extra dimensions cost traversals, not
    # factorisations.
    dimensions: list[str] = []
    for dim in [aggregate_by] + [
        str(sec.get("aggregate_by") or "")
        for sec in report.get("sections") or []
        if sec.get("kind") == "contribution"
    ]:
        if dim and dim not in dimensions:
            dimensions.append(dim)
    wants_prose = bool(kinds & {"prose", "summary"})
    # An indicator every contribution chapter leaves out is not computed. Each one costs a full
    # traversal per variant, and on an ecoinvent-backed comparison that is the most expensive thing
    # in the render. The lead is never skipped: `contribution` is the lead's.
    hidden_everywhere: set[str] = set()
    contribution_sections = [
        s for s in (report.get("sections") or []) if s.get("kind") == "contribution"
    ]
    if contribution_sections:
        hidden_everywhere = set(contribution_sections[0].get("hidden_indicators") or [])
        for sec in contribution_sections[1:]:
            hidden_everywhere &= set(sec.get("hidden_indicators") or [])
    appendix = next((s for s in report.get("sections") or [] if s.get("kind") == "appendix"), None)

    # The reference for every lead breakdown: the first (surviving) subject, or the body override —
    # the results table is computed under its overrides, so the breakdowns must match. Its state's
    # window goes LAST, so the lead work shares the factorisation that window already paid for.
    planned_ref_scenario = (
        next((s["scenario"] for s in specs if s["code"] == body.code), None)
        if body.code
        else specs[0]["scenario"]
    )
    states: list[str | None] = []
    for entry in specs:
        if entry["scenario"] not in states:
            states.append(entry["scenario"])
    if planned_ref_scenario in states:
        states.remove(planned_ref_scenario)
    states.append(planned_ref_scenario)

    subjects_by_spec: dict[int, dict] = {}
    dropped_subjects: list[str] = []
    trees_by: dict[tuple[str, int, int], dict] = {}  # (dimension, spec index, method index) → breakdown
    lead_trees: dict[tuple[str, int], dict] = {}  # (dimension, method index) → the reference's breakdown
    method_labels: list[str] = []
    tree = None
    inventory = None
    ref_tasks_done = False

    def kept_methods() -> list[tuple[int, tuple]]:
        """The indicators whose breakdowns are computed: the lead always, hidden ones never."""
        return [
            (i, m)
            for i, m in enumerate(methods)
            if not (i and i < len(method_labels) and method_labels[i] in hidden_everywhere)
        ]

    def planned_units() -> int:
        """Every solve this build will do, as far as it is known now — one per call below that
        steps the counter. Planned again once the indicator labels are in (they decide which
        indicators are hidden) and whenever a variant drops out."""
        breakdowns = len(dimensions) * len(kept_methods())
        per_variant = 1 + (breakdowns if dimensions and len(specs) > 1 else 0)
        reference = (
            # In a comparison the reference's breakdowns are its variant's (see `ref_tasks`).
            (0 if len(specs) > 1 else breakdowns)
            + (1 if (wants_prose or "system_model" in kinds) and not dimensions else 0)
            + (1 if wants_prose or appendix is not None else 0)
        )
        return (len(specs) - len(dropped_subjects)) * per_variant + reference

    def ref_tasks(ref_code: str, state: str | None) -> None:
        """Lead breakdowns, prose tree and annex inventory — everything only the reference state
        carries. Runs INSIDE that state's window."""
        nonlocal tree, inventory, ref_tasks_done
        # In a comparison the reference is also one of the variants, whose breakdowns were computed
        # in this same state: same process, overrides, indicator and dimension, so the same result.
        # Taken rather than traversed a second time — and the variant's attempt was THE attempt: one it
        # could not compute fails the same way again, and the plan has no step for a retry.
        as_variant = next(
            (i for i in sorted(subjects_by_spec) if specs[i]["code"] == ref_code and specs[i]["scenario"] == state),
            None,
        )
        tried = as_variant is not None and len(specs) > 1
        for dim in dimensions:
            for m_index, method in kept_methods():
                own = trees_by.get((dim, as_variant, m_index)) if as_variant is not None else None
                if own is not None:
                    lead_trees[(dim, m_index)] = own
                    continue
                # The lead indicator of the report's own dimension is the chapter: if its breakdown
                # cannot be computed the render fails and says why, as it always has — so the lead is
                # computed again here, where its failure surfaces. The others are an addition — one
                # indicator the solver cannot handle must not cost the report the chapter it used to have.
                lead = m_index == 0 and dim == dimensions[0]
                if tried and not lead:
                    continue
                if lead:
                    own = lca.contribution(database, ref_code, method, amount, aggregate_by=dim)
                else:
                    own = best_effort(
                        lambda mm=method, d=dim: lca.contribution(
                            database, ref_code, mm, amount, aggregate_by=d
                        )
                    )
                progress.step()
                if own:
                    lead_trees[(dim, m_index)] = own
        # A written chapter needs the tree even when no contribution *chapter* was asked for:
        # without it the writer can only restate the totals. Best-effort — a degenerate model
        # cannot produce a tree at all, and that is not a report error. The system-model figure
        # needs it too, for the shares its nodes carry.
        if (wants_prose or "system_model" in kinds) and not (
            dimensions and lead_trees.get((dimensions[0], 0))
        ):
            tree = best_effort(lambda: lca.contribution(database, ref_code, methods[0], amount))
            progress.step()
        # The annex' inventory table, for the leading indicator only. The LCA is already solved and
        # cached for this demand, so this is cheap. Same reference and overrides as everything above.
        if wants_prose or appendix is not None:
            stored = None if appendix is None else appendix.get("inventory_rows")
            rows = DEFAULT_INVENTORY_ROWS if stored is None else int(stored)  # 0 survives: all rows
            inventory = best_effort(
                lambda: lca.elementary_flows(database, ref_code, methods[0], amount, top_n=rows)
            )
            progress.step()
        ref_tasks_done = True

    def _state_window(state: str | None) -> None:
        """Everything one parameter state carries, inside its one applied window."""
        nonlocal method_labels
        for spec_index, entry in enumerate(specs):
            if entry["scenario"] != state:
                continue
            spec = entry["spec"]
            try:
                computed = lca.compute_multi(database, entry["code"], methods, amount)
            except PrismError as exc:
                # A deleted process used to fail the whole render. The report keeps working
                # without that variant and says so, so the author can fix the list.
                if exc.status_code != 404:
                    raise
                dropped_subjects.append(
                    str(spec.get("label") or spec.get("scenario_name") or entry["code"])
                )
                progress.plan(planned_units())
                continue
            if not method_labels:
                method_labels = [
                    " / ".join(str(p) for p in (r.get("method") or []))
                    for r in (computed.get("results") or [])
                ]
                progress.plan(planned_units())
            progress.step()
            label = spec.get("label") or computed.get("activity", {}).get("name") or entry["code"]
            if state:
                # …unless the caller already said so. Appending blindly produced
                # "Thicker bag (30 g) · Thicker bag (30 g)" in a real comparison report.
                scenario_name = spec.get("scenario_name") or state
                if scenario_name not in label:
                    label = f"{label} · {scenario_name}"
            subjects_by_spec[spec_index] = {
                "label": label,
                "code": entry["code"],
                "scenario": state,
                "lcia": computed,
            }
            # Baseline and every scenario, per indicator: the comparison a reader wants is what
            # the variants do to THIS indicator — computed here, in the state's own window.
            if dimensions and len(specs) > 1:
                for dim in dimensions:
                    for m_index, method in kept_methods():
                        got = best_effort(
                            lambda c=entry["code"], mm=method, d=dim: lca.contribution(
                                database, c, mm, amount, aggregate_by=d
                            )
                        )
                        progress.step()
                        if got:
                            trees_by[(dim, spec_index, m_index)] = got
        # The planned reference state is ordered last: run the lead work in the same window,
        # unless its subject was just dropped — then the fallback window below takes over.
        if state == planned_ref_scenario and subjects_by_spec:
            ordered = [subjects_by_spec[i] for i in sorted(subjects_by_spec)]
            actual_ref_code = body.code or ordered[0]["code"]
            actual_ref_scenario = (
                next((s["scenario"] for s in ordered if s["code"] == body.code), None)
                if body.code
                else ordered[0]["scenario"]
            )
            if actual_ref_scenario == state:
                ref_tasks(actual_ref_code, state)

    progress.plan(planned_units())
    for state in states:
        entered = False
        try:
            with scenarios.applied(scenario_store, database, state):
                entered = True
                _state_window(state)
        except PrismError as exc:
            # A DELETED scenario fails on entry (before `entered`): its subjects drop, the render
            # keeps working — the same tolerance the per-subject loop has for a deleted process.
            # Anything raised inside the window (a lead breakdown that must fail loudly) propagates.
            if entered or exc.status_code != 404:
                raise
            for entry in specs:
                if entry["scenario"] == state:
                    spec = entry["spec"]
                    dropped_subjects.append(
                        str(spec.get("label") or spec.get("scenario_name") or entry["code"])
                    )
            progress.plan(planned_units())

    if not subjects_by_spec:
        raise PrismError(
            "None of this report's variants can be computed any more.",
            code="report_no_subjects",
            hint="The processes or scenarios they point at were deleted — pick them again in the report.",
        )
    # The printed name, derived once and here, before anything reads it: the comparison table, the
    # per-variant breakdown rows, the chart legends drawn from them, `subjects[].label`,
    # `contribution_subjects[].label`, `trade_offs` and the writer's brief all take it from these
    # dicts, so a name made tellable apart in one of them is tellable apart in all of them.
    in_order = sorted(subjects_by_spec)
    printed = [str(subjects_by_spec[i]["label"]) for i in in_order]
    if len(set(printed)) != len(printed):
        # The lookups only now: two variants reading the same is the rare case, and asking every
        # render for every variant's location and product would pay for it on the renders that don't.
        rows = [
            {
                "label": subjects_by_spec[i]["label"],
                "scenario_name": specs[i]["spec"].get("scenario_name")
                or subjects_by_spec[i]["scenario"]
                or "",
                **report_variants.reference_fields(database, str(subjects_by_spec[i]["code"])),
            }
            for i in in_order
        ]
        for i, name in zip(in_order, report_variants.disambiguated_labels(rows), strict=True):
            subjects_by_spec[i]["label"] = name
    subjects = [subjects_by_spec[i] for i in in_order]
    primary = subjects[0]["lcia"]
    ref_code = subjects[0]["code"]
    ref_scenario = subjects[0]["scenario"]
    if body.code:
        ref_code = body.code
        ref_scenario = next((s["scenario"] for s in subjects if s["code"] == body.code), None)
    # The rare fallback: the planned reference dropped mid-window, so the lead work still owes a
    # window under the ACTUAL reference's overrides — one extra factorisation, only on that path.
    if not ref_tasks_done:
        with scenarios.applied(scenario_store, database, ref_scenario):
            ref_tasks(ref_code, ref_scenario)

    # Assembly, in report order — same gate as before: an indicator whose lead breakdown failed is
    # left out entirely, per-subject trees included.
    contribution = None
    subject_contributions: list[dict] = []
    contributions: list[dict] = []
    contributions_by_dimension: dict[str, list[dict]] = {}
    for dim in dimensions:
        computed_methods = [r.get("method", []) for r in (primary.get("results") or [])]
        views: list[dict] = []
        for m_index, method in kept_methods():
            own = lead_trees.get((dim, m_index))
            if not own:
                continue
            per_subject: list[dict] = []
            if len(subjects) > 1:
                for spec_index in sorted(subjects_by_spec):
                    got = trees_by.get((dim, spec_index, m_index))
                    if got:
                        spec = subjects_by_spec[spec_index]
                        per_subject.append(
                            {
                                "label": spec["label"],
                                # What the variant *is*, beside what it is called. The label alone was
                                # its identity in the snapshot, and a variant without a label of its
                                # own falls back to the process name above — so two variants of one
                                # process were called the same thing and a pin on the second resolved
                                # to the first (V223). `report_data` builds the composite key from
                                # these two; they are not printed.
                                "code": spec["code"],
                                "scenario": spec["scenario"],
                                "contribution": got,
                            }
                        )
            # The same label `report_data` builds for `results`, so a chapter can match the two up.
            resolved = computed_methods[m_index] if m_index < len(computed_methods) else method
            label = " / ".join(
                str(p) for p in (resolved if isinstance(resolved, list) else [resolved])
            )
            views.append(
                {
                    "index": m_index,
                    "method_label": label,
                    "contribution": own,
                    "subjects": per_subject,
                    # The datasets behind *this* indicator. `hotspots` at the top level is the lead
                    # indicator's and nothing else, and a chapter told to compare three indicators had
                    # evidence for one — so it filled the gap from its own knowledge and named two
                    # datasets that are not in the model, with shares (V161). Without the
                    # details block: the point is which datasets and how large, and three descriptions
                    # per chapter is a brief nobody reads. The lead indicator keeps its full list
                    # under `hotspots`, details and all.
                    "hotspots": best_effort(
                        lambda t=own: hotspots(t, detail=0, lang=report.get("lang", "en"))
                    )
                    or [],
                }
            )
        contributions_by_dimension[dim] = views
    if dimensions:
        contributions = contributions_by_dimension.get(dimensions[0]) or []
        if contributions:
            contribution = contributions[0]["contribution"]
            subject_contributions = [
                {
                    "label": s["label"],
                    "code": s["code"],
                    "scenario": s["scenario"],
                    "contribution": s["contribution"],
                }
                for s in contributions[0]["subjects"]
            ]
    if tree is None:
        tree = contribution
    # The system-model figure's data: foreground, first background tier, shares from the lead tree.
    # Best-effort like the hotspots — a model without a tree still gets its picture, without shares.
    system_section = next((s for s in report.get("sections") or [] if s.get("kind") == "system_model"), None)
    # `tree` is the whole `lca.contribution` result; the node graph `_shares` walks sits under its
    # "tree" key. Handed the wrapper, it found no shares at all and ranked the background suppliers by
    # exchange amount — the biggest impact could vanish into the "other" group.
    tree_node = tree.get("tree") if isinstance(tree, dict) and "tree" in tree else tree
    system_model = (
        best_effort(
            lambda: report_graph.system_model(
                database,
                tree_node,
                per_process=int(system_section.get("per_process") or report_graph.DEFAULT_PER_PROCESS),
                background=bool(system_section.get("background_tier", True)),
            )
        )
        if system_section is not None
        else None
    )
    inputs = {
        "template": store.get_template(report.get("template") or ""),
        # `for_report`, not `snapshot`: the document sets the functional unit inside its own sentences
        # and supplies their punctuation, so the phrase arrives without a full stop of its own.
        "study": StudyMetaStore().for_report(database),
        "lcia": primary,
        "subjects": subjects,
        "contribution": contribution,
        # One breakdown per indicator, lead first; `contribution` above is `contributions[0]`.
        "contributions": contributions,
        # Every dimension's views, keyed by dimension, and the dimensions in document order — the first
        # is `contributions` above; a contribution chapter with a dimension of its own reads its entry.
        "contributions_by_dimension": contributions_by_dimension,
        "breakdown_dimensions": dimensions,
        "system_model": system_model,
        "app_version": getattr(settings, "app_version", ""),
        "parameters": params_engine.list_params(database),
        "inventory": inventory,
        "hotspots": hotspots(tree, lang=report.get("lang", "en")),
        "subject_contributions": subject_contributions,
        "dropped_subjects": dropped_subjects,
        # The model's own documentation (process descriptions) and the datasets it uses directly. Gathered
        # when a chapter can use them: the dataset index needs the list, and any writer benefits from the
        # descriptions — they are the difference between explaining a hotspot and naming it. Best-effort,
        # because a missing description must never stop a render.
        "model_context": (
            best_effort(lambda: report_variants.context_in_phase_order(database, report))
            if wants_prose or kinds & {"datasets", "appendix", "goal_scope"}
            else None
        ),
        # Only when a chapter actually asks for it: the linter walks every process of the foreground
        # model, and a report without the checks chapter should not pay for that on every render.
        "health": (
            health.lint_database(database)
            if any(s.get("kind") == "interpretation_checks" for s in report.get("sections") or [])
            else None
        ),
        "scenarios": ScenarioStore().list_all(database),
        # Project-wide: the firm carrying out the study, its logo and how tall the marks are printed.
        "identity": store.get_identity(),
        "figures": body.figures or {},
        "method_references": body.method_references or [],
        # Every installed method of the families in play, so an indicator's printed name is decided
        # against its whole family and not against this report's selection (V203). Best-effort: a
        # missing catalogue costs the long names, never the render.
        "method_catalog": best_effort(lambda: lca.methods_in_families(report.get("methods") or []))
        or [],
        "provenance": {
            # The background(s) the model actually draws on — one name, or "a, b" when a model mixes
            # two providers; ``backgrounds`` carries each one's registry entry for the bibliography.
            "background": background,
            "backgrounds": backgrounds,
            "app_version": getattr(settings, "app_version", ""),
            "generated": datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC"),
        },
        # What the build researched and what its internal review concluded — the two kinds of
        # provenance that used to live only in a chat. Cheap file reads, so gathered unconditionally.
        "web_research": ResearchLogStore().list(database),
        "review": ReviewLogStore().for_report(database, lca.model_generation()),
    }
    # Stored with a copy of the mutable pieces: the render about to happen substitutes
    # translations into study/model_context, and the memo must keep the untouched record.
    kept = dict(inputs)
    for mutable in ("model_context", "study", "parameters", "scenarios"):
        kept[mutable] = copy.deepcopy(inputs.get(mutable))
    report_snapshot.memo_put(memo_key, kept)
    return inputs


def as_kwargs(inputs: dict) -> dict:
    return {
        "study": inputs["study"],
        "lcia": inputs["lcia"],
        "contribution": inputs["contribution"],
        "contributions": inputs.get("contributions") or [],
        "contributions_by_dimension": inputs.get("contributions_by_dimension") or {},
        "breakdown_dimensions": inputs.get("breakdown_dimensions") or [],
        "system_model": inputs.get("system_model"),
        "app_version": inputs["app_version"],
        "parameters": inputs["parameters"],
        "scenarios": inputs["scenarios"],
        "figures": inputs["figures"],
        "method_references": inputs["method_references"],
        "method_catalog": inputs.get("method_catalog") or [],
        "subjects": inputs["subjects"],
        "health": inputs["health"],
        "inventory": inputs["inventory"],
        "hotspots": inputs["hotspots"],
        "model_context": inputs["model_context"],
        "subject_contributions": inputs["subject_contributions"],
        "dropped_subjects": inputs["dropped_subjects"],
        "template": inputs["template"],
        "identity": inputs.get("identity"),
        "provenance": inputs["provenance"],
        "web_research": inputs.get("web_research") or [],
        "review": inputs.get("review"),
    }


def document(
    database: str, report_id: str, body: RenderRequest, *, use_token: bool = False
) -> tuple[dict, dict, dict, dict]:
    """The definition, its inputs, the Typst sources and the render info — computed now, for this one.

    The pair of lines this replaces stood in seven endpoints, which is what made the *other* thing
    they all shared invisible: each one of them is a full study. That reading is deliberate and stays
    (`analysis_snapshot` says why documents are never served from the cache); it is worth
    saying once, here, rather than seven times by accident.

    `use_token` spends the render token that `/sources` handed out, so drawing the charts and
    typesetting them is one interaction and costs one study rather than two.
    """
    spent = (
        report_snapshot.spend_render_token(
            report_snapshot.preview_key(database, report_id),
            body.render_token,
            body.figures,
            body.method_references,
        )
        if use_token
        else None
    )
    if (
        use_token
        and spent is None
        and body.figures
        and report_snapshot.render_token_state(report_snapshot.preview_key(database, report_id), body.render_token)
        == "stale"
    ):
        # The figures were drawn from the numbers this token stood for; recomputing the numbers and
        # typesetting those figures beside them made a document of two model states.
        raise PrismError(
            "The model changed since this preview was computed; the charts no longer match the numbers.",
            code="report_preview_stale",
            status_code=409,
            hint="Reload the preview, then export again.",
        )
    # Through the module attribute on purpose: `render_inputs` is the seam the tests replace to
    # count or fake the expensive build, and a direct name here would dodge their patch.
    report, inputs = spent if spent else render_inputs(database, report_id, body)
    sources, info = report_render.render_sources(report, **as_kwargs(inputs), draft=body.draft)
    return report, inputs, sources, info


def snapshot_id_for(database: str, report_id: str, report_def: dict, body: RenderRequest | None = None) -> str:
    """The id of the snapshot `analysis_snapshot` would hand out for this report right now."""
    return report_snapshot.snapshot_id(
        report_snapshot.snapshot_key(database, report_id, report_def, body or RenderRequest())
    )


def require_snapshot(database: str, report_id: str, report_def: dict, claimed: str | None) -> None:
    """Refuse when a client's work rests on a snapshot that is no longer this one.

    A brief carries the id; the proposal or patch built on it hands it back; a mismatch means the
    numbers moved in between — a recalculation, a changed study setting — and the text would be bound
    and judged against figures its writer never saw. The text itself is not lost: the caller keeps it
    as a draft and says why.
    """
    if not claimed:
        return
    current = snapshot_id_for(database, report_id, report_def)
    if claimed != current:
        raise PrismError(
            "The report's numbers have changed since this chapter's brief was fetched — a recalculation "
            "or a changed study setting. The text is kept as a draft and was not stored; write the "
            "chapter again against the new numbers.",
            code="report_snapshot_moved",
            status_code=409,
            hint="Fetch a new brief (it carries the current snapshot_id) and write from that.",
        )


def analysis_snapshot(database: str, report_id: str, body: RenderRequest) -> tuple[dict, dict]:
    """The report definition — always freshly read — and its data, which may be shared.

    One load for the definition, so a caller that reads a section and its numbers cannot be handed two
    different moments: an edit landing between two separate loads made a stored patch carry the stale
    section's kind.

    This is the ONE seam the tests replace to put fake numbers under a report — every judging
    endpoint reaches it through this module attribute, so one `monkeypatch.setattr` covers them all
    (they used to have to patch two routers that each held a bound copy).
    """
    report_def = ReportStore().get(database, report_id)
    key = report_snapshot.snapshot_key(database, report_id, report_def, body)
    report_snapshot.remember_target(key[0], database, report_id)
    data = report_snapshot.snapshot_get(key)
    if data is not None:
        return report_def, _translated_copy(report_def, _current_review(database, data))
    with report_snapshot.snapshot_build_lock:
        # Someone may have built it while we waited for the lock — that is the point of waiting.
        data = report_snapshot.snapshot_get(key)
        if data is not None:
            return report_def, _translated_copy(report_def, _current_review(database, data))
        _fresh, inputs = render_inputs(database, report_id, body)
        # Built WITHOUT the stored translations (V433): the numbers do not depend on them, and a
        # snapshot that carried them had to be rebuilt the moment the translation step before Write
        # all stored its map — a second two-minute study for the same figures. The map is laid over
        # a copy per request below.
        untranslated = {**_fresh, "translations": {}}
        _sources, info = report_render.render_sources(untranslated, **as_kwargs(inputs))
        data = info["data"]
        report_snapshot.snapshot_put(key, data)
        return report_def, _translated_copy(report_def, data)


def _current_review(database: str, data: dict) -> dict:
    """A cached snapshot with the review log as it stands now, and the translation candidates from it.

    The key covers what moves numbers, and the review log moves none: a finding resolved after the build
    stayed open in the snapshot — for the briefs, the checks and the translation step — as long as it was
    used, while `translations/foreign` reads the log itself. The refresh `render_inputs` does on a memo
    hit; a file read and a walk, no calculation. Never written back: the cache keeps its build.
    """
    from prism_lca.engine import report_translations as rtr

    review = ReviewLogStore().for_report(database, lca.model_generation())
    current = dict(review) if review else {}
    if current == (data.get("review") or {}):
        return data
    fresh = {**data, "review": current}
    fresh["translations"] = {**(data.get("translations") or {}), "candidates": rtr.candidates(fresh)}
    return fresh


def _translated_copy(report_def: dict, data: dict) -> dict:
    """The cached, untranslated snapshot with the report's stored translations laid over a copy.

    `report_translations.apply` substitutes in place, so the cache must never see it: a deep copy
    per request (tens of milliseconds on a 16-indicator report, against a two-minute build) keeps
    the cached record the untranslated source every later request needs.
    """
    import copy

    from prism_lca.engine import report_data
    from prism_lca.engine import report_translations as rtr
    from prism_lca.engine.report_i18n import normalise

    stored = report_def.get("translations") or {}
    lang = str(report_def.get("lang") or "en")
    out = copy.deepcopy(data)
    applied = rtr.apply(out, stored, lang) if isinstance(stored, dict) and stored.get("map") else 0
    info = dict(out.get("translations") or {})
    info["applied"] = applied
    info["stored"] = len(stored.get("map") or {}) if isinstance(stored, dict) else 0
    out["translations"] = info
    out["report"] = report_data.report_settings(report_def, normalise(lang))
    return out


# --- building the snapshot before it is asked for ------------------------------------------------
# The freshness check itself is arithmetic on stored records: warm it costs ~0.1 s for a whole report.
# What it waits for is the ONE snapshot behind it, and that snapshot is a complete study — measured on
# a 3-variant / 4-indicator report, 72 s, of which 69 s is solving (V214). Nothing about the check can
# make that cheaper; the only question is who is standing in front of it.
#
# A model change is the moment the cost becomes predictable: it invalidates every snapshot (the
# generation is in the key), and the reports it invalidated are, by definition, reports somebody was
# looking at. So `POST /params/recalculate` schedules the rebuild and returns; the author reads their
# new parameter values while the study is being solved, and the check they run afterwards is warm.
#
# What this deliberately does NOT do:
#   * block the recalculation to warm — the thread is started and the response goes out;
#   * warm speculatively — only reports this process has already computed a study for are candidates,
#     so a project with fifty reports computes at most the two somebody is working in;
#   * announce itself — the page already says "checking what changed…" while the check runs, and it
#     stays true: a warm-up does not change what the check answers, only how long it takes.
#
# And what it cannot do: abort. Once a warm-up is solving it holds the LCA lock to the end — every
# calculation in the process serialises on it, and a scenario window must not be left half-applied —
# so if the model moves again mid-solve, a caller arriving in that window waits behind work that has
# become useless. The delay below plus the generation check keep the window small (a burst of
# recalculations never reaches a solve); closing it entirely needs a cancellation point inside
# `_compute_render_inputs`, which is a change to the shared build path and not worth it until it bites.
#
# Raw daemon threads on purpose, still: `engine/background.py` is the canvas lazy-expand module, not
# a worker pool — there is no background-work machinery in this codebase to hand this to, and a
# daemon thread whose result lives only in memory needs no shutdown handling (see `_warm_snapshot`).
#
#: How long a warm-up waits before starting. The activity editor recalculates on every formula it
#: stores, so recalculations arrive in bursts; waiting lets a burst collapse into one study (the
#: generation check below drops the superseded ones for free). It also costs the author nothing when
#: they are quicker than the delay: then their own check builds the snapshot and the warm-up, arriving
#: at a warm cache, is a lookup.
_WARM_DELAY = 5.0
#: Reports per model a single change may warm. More than one because the author can be alternating
#: between two reports of the same study; not "all of them", because every extra one is another
#: complete study and nobody asked for any of them.
_WARM_REPORTS = 2


def warm_snapshots(database: str) -> list[str]:
    """Rebuild, in the background, the freshness snapshots a model change has just invalidated.

    Call **after** the change is committed and the generation has moved — the warm-up records the
    generation it is for and gives up if another change overtakes it. Returns the report ids it
    scheduled (empty is the normal answer: no report of this model has been opened yet).

    Cannot fail its caller: whoever calls this has just finished the author's actual request, and
    nothing about an unasked-for computation may turn that request into an error. Needs no app and
    no request — the fake `Request` its predecessor carried (`_AppOnly`) existed only because the
    pipeline used to read `request.app.state`.
    """
    try:
        project = str(getattr(lca.get_bd().projects, "current", ""))
        generation = lca.model_generation()
        targets = report_snapshot.warm_targets_for(project, database)
        targets = targets[-_WARM_REPORTS:]
        for report_id in targets:
            threading.Thread(
                target=_warm_snapshot,
                args=(database, report_id, generation),
                name=f"prism-report-warm-{report_id}",
                daemon=True,
            ).start()
        return targets
    except Exception as exc:  # noqa: BLE001 — see the docstring
        logger.warning("Could not schedule a report snapshot warm-up for %s: %s", database, exc)
        return []


def _warm_snapshot(
    database: str, report_id: str, generation: int, delay: float = _WARM_DELAY
) -> bool:
    """One warm-up: wait out the burst, then build exactly the snapshot the next check will ask for.

    Nothing here is allowed to become the next caller's problem:

    * The key is the check's key, because this goes through `analysis_snapshot` like every other
      caller — a warm-up that filled a key of its own would be a second answer to the same question.
    * Two overlapping warm-ups, or a warm-up and a real request, compute once: that is
      `snapshot_build_lock`, already there for the four lanes of a "write all" run.
    * A failure caches nothing and says nothing to the author. It must not: the same call from a real
      caller a moment later fails the same way and hands over the backend's own sentence, which is the
      one thing worth having about that state (V200). Logged, because a silent failure we cannot see
      is how a broken model looks like a slow one.
    * Shutdown needs no handling. The thread is a daemon, the result lives in memory only, and there
      is nothing half-written to find afterwards.
    """
    time.sleep(delay)
    if lca.model_generation() != generation:
        # Overtaken — another change has already scheduled its own warm-up for the state that is now
        # current. Building this one would spend a study on numbers nobody can ask for any more, and
        # (worse) hold the LCA lock while doing it.
        return False
    try:
        analysis_snapshot(database, report_id, RenderRequest())
    except Exception as exc:  # noqa: BLE001 — a warm-up may not turn into a failed request
        logger.warning(
            "Report snapshot warm-up for %s/%s failed (%s: %s); the next check will compute it and "
            "report the reason itself.",
            database,
            report_id,
            type(exc).__name__,
            exc,
        )
        return False
    return True


# ---- hand-off ---------------------------------------------------------------
_BUNDLE_README = """\
# {name}

Typst sources for a PrismLCA report — everything needed to typeset it without PrismLCA. Compile
with:

    typst compile main.typ

## What is yours and what is ours

* `main.typ` — **yours** from here on. The whole document is this one file: the chapters in the order
  the report gave them, one after another. Edit it freely.
* `values.json` — **ours**, and the reason editing is safe: every number in a sentence is a
  `#pval("…")` call that reads this file while compiling, so no figure is written into the prose.
  Replace the file, recompile, and text you have rewritten states the new numbers. A key that is gone
  prints as `[missing: …]` instead of quietly keeping an old value.
* `tables.json` — **ours** too: the cells of every table, already formatted. A table in `main.typ` is a
  `#ptable("…")` call that reads its rows from here, so a refresh brings new tables beside new text. To
  fix a table by hand, replace its `#ptable` call with your own `#lca-table(…)` — then it is yours and
  no refresh touches it. A table that is gone prints as `[missing table: …]`.
* `data.json` — the whole result snapshot behind those values: scores, contributions, provenance, the
  completeness check. Nothing reads it while compiling — it is here so a reviewer can see where a
  number came from, and so you can look up one that has no placeholder yet.{charts}
* `template.typ` and `palette.typ` — the look, and its colours as the named bindings the template
  uses. Change them, or replace the template with your own; PrismLCA validates a template before
  accepting it.{images}

## Keeping the numbers current

Ask whoever sent this for the data on its own rather than for a new export: PrismLCA can hand out
`data.json`, `values.json`, `tables.json`, `figures.json` and the chart files without the prose. Drop those in beside your edited
`main.typ` and recompile — your text stands, the figures move. Type a number in by hand and it stops
being maintained, which is fine as long as you know you did it.

Tables and charts are named by what they show — the indicator's method path and, for a breakdown, its
dimension — never by their place in the method list. If the list has changed since this export, a table
or chart of an indicator that is no longer assessed prints as `[missing table: …]` or
`[missing figure: …]` where it stood, rather than showing another indicator under the old caption; a
newly added indicator appears nowhere until you place it.

Exports made before 29 Sept 2026 name their charts by position; this archive cannot refresh them
safely — export the report again.

## Fonts

Not in the archive. PrismLCA typesets with system fonts switched off, from its own copies of ten
libre families — Noto Sans, Source Sans 3, Source Serif 4, Instrument Sans, IBM Plex Sans, JetBrains
Mono, Montserrat, Open Sans, Libre Franklin and Libre Baskerville, all under SIL OFL 1.1 — plus the
ones the Typst compiler embeds itself; that is what makes its PDF identical on every
machine. Your Typst installation has only what is installed on it, so install the families
`template.typ` asks for (all of them are free) or the compiler substitutes and the document sets
differently than it did here.

Generated by PrismLCA {version}.
"""


def bundle_readme(name: str, version: str, names: list[str]) -> str:
    """The hand-off note, written from the files this archive actually contains.

    Assembled rather than fixed, because the archive varies: a report with no figures has no `charts/`,
    and which images travel depends on the cover and the logos. A fixed text drifts away from the ZIP
    without anything noticing — which is what happened to its predecessor, promising a `chapters/`
    directory in a layout this export has never had. Everything the note names is taken from `names`,
    so the recipient is never sent looking for a file that is not there.
    """
    import textwrap

    # Wrapped like the rest of the note, because the list of images has no fixed length: a report with a
    # cover and two logos would otherwise leave one 160-character line in an otherwise hand-set document.
    def bullet(text: str) -> str:
        return "\n" + textwrap.fill(text, width=100, initial_indent="* ", subsequent_indent="  ")

    images = sorted(
        n for n in names if "/" not in n and n.lower().endswith((".png", ".jpg", ".jpeg", ".svg"))
    )
    charts = ""
    if any(n.startswith("charts/") for n in names):
        charts = bullet(
            "`charts/` and `figures.json` — the figures, as SVG drawn from exactly these numbers, and the "
            "list of them. Ours as well: a figure in `main.typ` is a `#pfigure(\"…\")` call that finds its "
            "file through `figures.json`, so a data refresh brings new ones, and one that is gone prints as "
            "`[missing figure: …]`. To keep a figure of your own, replace its `#pfigure` call with "
            "`#lca-figure(\"your-file.svg\", …)`."
        )
    return _BUNDLE_README.format(
        name=name,
        version=version,
        charts=charts,
        images=(
            bullet(
                ", ".join(f"`{n}`" for n in images)
                + " — the image files the document places. Typst picks "
                "its decoder from the file *name*, so keep the extensions as they are."
            )
            if images
            else ""
        ),
    )


#: A figure key in the old, positional scheme — what a renderer from before content keys sent.
_POSITIONAL_KEY = re.compile(r"lcia-[0-9]+|contribution(-[a-z0-9-]+)?|summary|section-[a-z0-9-]+")


def positional_chart_keys(figures: dict | None) -> list[str]:
    """The keys in `figures` that name a chart by its position (`lcia-1`, `contribution-d1-2`, `section-x-0`).

    A refresh must not accept them: under content keys a chart is placed by what it shows, and an export
    from before 29 Sept 2026 embeds `charts/lcia-1.svg` directly — a chart accepted under that name would
    land exactly where such an export reads it, possibly another indicator's.
    """
    return sorted(k for k in (figures or {}) if isinstance(k, str) and _POSITIONAL_KEY.fullmatch(k))


def _referenced_backgrounds(database: str) -> tuple[str, list[dict]]:
    """Which background databases the model draws on, in registry terms — directly, or through the
    datasets it uses from ``My processes``.

    A project with two backgrounds (ecoinvent and BAFU) must not name the wrong one — the first
    in the list used to win. A model that draws on none gets none: the old fallback to every
    installed background printed "everything upstream comes from bafu, ecoinvent" right above "the
    model references no background datasets", and listed both in the bibliography and under
    reproducibility. A model built from library datasets reaches its
    background through them, so those are followed — and through whatever writable database they
    in turn draw on: a process moved to the library keeps its inputs, which may point into the model
    it came from (Model B → library → Model A → ecoinvent). Read-only
    databases are the end of the walk: a registered background is named, anything else read-only
    (the biosphere) holds no supply chain.
    """
    from prism_lca.engine.backgrounds.common import backgrounds as installed_backgrounds
    from prism_lca.engine.bootstrap import get_bd
    from prism_lca.engine.guardrails import is_read_only

    installed = {name: info for name, info in installed_backgrounds()}
    used: list[str] = []
    try:
        bd = get_bd()
        seen: set[str] = set()
        visited: set[tuple[str, str]] = set()
        writable: dict[str, bool] = {}
        queue = list(bd.Database(database))
        while queue:
            activity = queue.pop()
            if activity.key in visited:
                continue
            visited.add(activity.key)
            for exchange in activity.exchanges():
                target = exchange.input.key if hasattr(exchange.input, "key") else tuple(exchange.input)
                db_name = target[0]
                if db_name in installed:
                    seen.add(db_name)
                    continue
                if db_name not in writable:
                    writable[db_name] = not is_read_only(db_name)
                if writable[db_name] and target not in visited:
                    queue.append(exchange.input)
        used = sorted(seen)
    except Exception as exc:  # noqa: BLE001 - provenance is best-effort
        _log.swallowed(exc, "_referenced_backgrounds")
    names = used
    entries = [
        {"database": name, **(installed[name].as_dict() if installed[name] else {})}
        for name in names
    ]
    return ", ".join(names), entries
