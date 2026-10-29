"""The report surface: stored definitions, their outputs — and the short report beside them.

The **document** half of the report surface: definitions and their chapters as objects, templates and
appearance, and the outputs — PDF, page preview, Typst sources, the hand-off bundle. The colour sets have a
router of their own (`report_palettes.py`), and everything a *model* touches lives next door in
`report_ai.py`. All three routers are thin: the
pipeline (`engine/report_pipeline`), its caches (`engine/report_snapshot`) and the gate
(`engine/report_gate`) live in the engine, request-free — what stays here is HTTP shape, the
export-gap gate, and the audit lines that need the request's command bus.
"""
from __future__ import annotations

import base64

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from prism_lca import _log
from prism_lca.api.v1.deps import MethodRef, require_token
from prism_lca.engine import (
    report_audit,
    report_pipeline,
    report_short,
    report_snapshot,
    report_typst,
    typst_render,
)
from prism_lca.engine.report_hotspots import best_effort
from prism_lca.engine.report_pipeline import RenderRequest
from prism_lca.engine.report_store import ReportStore
from prism_lca.errors import PrismError

router = APIRouter(prefix="/report", tags=["report"], dependencies=[Depends(require_token)])


# ---- report definitions (stored per model) ----------------------------------
class NewReportRequest(BaseModel):
    database: str
    name: str | None = None
    subtitle: str | None = None
    #: "tag:<dimension>" | "geo" — stored on the report, so every render and every writing brief sees it.
    aggregate_by: str | None = None
    lang: str = "en"
    #: Empty means the project's default theme (`typst_render.DEFAULT_TEMPLATE`), not the id "default" —
    #: that one is a template like any other and only named after the role it used to have.
    template: str = ""
    subjects: list[dict] | None = None
    methods: list[MethodRef] | None = None
    amount: float = 1.0
    #: Omit to start from the project-wide default structure.
    sections: list[dict] | None = None


class UpdateReportRequest(BaseModel):
    name: str | None = None
    subtitle: str | None = None
    aggregate_by: str | None = None
    lang: str | None = None
    template: str | None = None
    #: Id of the colour set the document is typeset in — see GET /report/palettes.
    palette: str | None = None
    #: Accent, deep tone and paper chosen by hand on this report, replacing the set's three:
    #: `{"accent": "#2f4e66", …}`. An empty object clears them and the set applies again.
    palette_colors: dict | None = None
    subjects: list[dict] | None = None
    methods: list[MethodRef] | None = None
    amount: float | None = None
    options: dict | None = None
    #: Cover image as a data URL or bare base64 (PNG/JPEG). Empty string removes it.
    cover_image: str | None = None
    #: The client's logo for this report's cover, same encoding. Empty string removes it.
    client_logo: str | None = None


class IdentityRequest(BaseModel):
    """Only what was sent is applied: a client that knows about one field must not clear the others."""

    author: str | None = None
    organisation: str | None = None
    #: PNG/JPEG as a data URL or bare base64; "" removes it, and then no mark is printed.
    company_logo: str | None = None
    logo_height_mm: float | None = None


class SectionRequest(BaseModel):
    kind: str = "prose"
    #: Appendix only: how many rows its inventory table lists. 0 = every characterised flow.
    inventory_rows: int | None = None
    #: The chapter's figures, in drawing order. Each: kind (bar | stacked_bar | heatmap | radar), and for the
    #: row kinds a source/value from the whitelist plus how it is drawn (horizontal, stacked, rows).
    figures: list[dict] | None = None
    title: str | None = None
    text: str | None = None
    prompt_override: str | None = None
    extra_instructions: str | None = None
    locked: bool | None = None
    #: The `text_version` the client read before editing (GET report / brief). With it, a text write is
    #: refused (409 `report_text_moved`) when another write landed in between — see
    #: `report_store.update_section`. Without it, the write is unconditional, as before.
    expected_text_version: str | None = None
    #: Results chapter only: which way round the comparison matrix is set — "auto" (transpose as soon
    #: as there are more indicators than variants), "indicators" (indicators as rows) or "subjects".
    table_layout: str | None = None
    #: Results chapter only: which indicators get a bar chart of their own — "all", "lead" (only the
    #: report's first) or "none". The heatmap and the radar are report-wide options and stay there.
    per_indicator_charts: str | None = None
    #: Contribution chapter only: indicators this chapter leaves out, by method label. Empty means all.
    hidden_indicators: list[str] | None = None
    #: Inventory chapter only: which parts it shows — any of processes | datasets | parameters | flows.
    inventory_parts: list[str] | None = None
    #: Inventory chapter only: how much of each process note — "full", "short" or "list".
    inventory_detail: str | None = None
    #: Contribution chapter only: the hotspot table under each breakdown, and a breakdown dimension
    #: of the chapter's own (a second contribution chapter by another tag family; "" = the report's).
    hotspots: bool | None = None
    aggregate_by: str | None = None
    #: System-model chapter only: what the figure draws and how it is coloured. Every field the store
    #: accepts has to be declared here — pydantic drops what it does not know before `model_dump`
    #: builds the patch, so an undeclared option answered 200 and changed nothing.
    background_tier: bool | None = None
    per_process: int | None = None
    colour_by: str | None = None
    edge_amounts: bool | None = None
    #: Introduction and interpretation only: whether the writer may search the literature. Absent = it may.
    literature_search: bool | None = None
    #: Insert position; omit to append.
    at: int | None = None


class ReorderRequest(BaseModel):
    order: list[str]


class DefaultSectionsRequest(BaseModel):
    sections: list[dict]


def _store() -> ReportStore:
    # Stateless — constructed on use, like the engine does since the store consolidation.
    return ReportStore()


@router.get("/defaults", summary="Project-wide default section structure for new reports")
def get_defaults(request: Request) -> dict:
    return {"sections": _store().default_sections()}


@router.get("/prompts", summary="Standard prompt per chapter kind")
def get_prompts() -> dict:
    """The built-in prompts, so the author can see what a chapter is being asked to do — and, once they
    override it, what they are deviating from. Without this the override field would be an empty box
    with no way to find out what it replaces."""
    from prism_lca.engine.report_prompts import DEFAULT_PROMPTS

    return {"prompts": dict(DEFAULT_PROMPTS)}


@router.post("/defaults", summary="Set the project-wide default structure (existing reports untouched)")
def set_defaults(request: Request, body: DefaultSectionsRequest) -> dict:
    """Posting an empty list resets to the built-in ISO 14044 structure — the store falls back to it
    whenever no project default is stored, so "reset" and "never set" are deliberately the same state."""
    return _store().set_default_sections(body.sections)


class TemplateRequest(BaseModel):
    name: str
    #: The full `template.typ`. Validated against the fixture before it is stored.
    source: str


@router.get("/templates", summary="Report themes stored in this project")
def list_templates(request: Request) -> dict:
    return {"templates": _store().list_templates()}


@router.post("/templates", summary="Add or replace a report theme (validated first)")
def put_template(request: Request, body: TemplateRequest) -> dict:
    """Compiles the fixture against the template before storing it.

    That check is the whole reason a custom template is safe to allow: a template that does not satisfy
    the contract is refused here, with the compiler's own message, instead of breaking a report at the
    moment someone needs it.
    """
    from prism_lca.engine.report_store import check_template_name

    check_template_name(body.name)  # cheap first: a bad name should not be reported as a compiler error
    typst_render.validate_template(body.source)
    stored = _store().put_template(body.name, body.source)
    # Render its preview now, while the user is still looking at the upload: the picker is then instant, and
    # an imported theme is no different from a shipped one the moment it lands. Best-effort — the fixture
    # already proved it compiles, and a theme must not be refused over its thumbnail.
    try:
        from prism_lca.engine import report_preview

        report_preview.preview_png(body.source)
    except Exception as exc:  # noqa: BLE001 — a preview is a convenience, never a reason to reject a valid theme
        _log.swallowed(exc, "put_template")
    return stored


@router.post("/templates/{name}/delete", summary="Delete a report theme")
def delete_template(request: Request, name: str) -> dict:
    return _store().delete_template(name)


@router.get("/identity", summary="Who carries out the studies in this project")
def get_identity(request: Request) -> dict:
    return _store().get_identity()


@router.post("/identity", summary="Set the name, firm and logo printed on every cover")
def set_identity(request: Request, body: IdentityRequest) -> dict:
    patch = body.model_dump(exclude_unset=True)
    if "company_logo" in patch:
        patch["company_logo"] = report_pipeline.image_b64(patch["company_logo"], what="logo")
    return _store().set_identity(patch)


@router.get("/cover-placeholder", summary="The cover picture shipped with the app")
def cover_placeholder() -> dict:
    """Served so the report card can show a thumbnail of the placeholder. The report itself only stores
    the word "default", so the picture has to come from somewhere."""
    import base64

    return {"base64": base64.b64encode(typst_render.default_cover_bytes()).decode("ascii")}


@router.get("/templates/{name}/preview", summary="A theme's cover, typeset with sample data")
def template_preview(
    request: Request, name: str, palette: str | None = None, colors: str | None = None
) -> dict:
    """The picture the theme picker shows on hover.

    Rendered here rather than shipped as image files: a committed PNG goes stale the moment someone edits a
    cover, and a stale preview is worse than none. Cached by the hash of the template source, so the first
    hover costs one single-page compile and every one after it is free.
    """
    from prism_lca.engine import report_palettes, report_preview

    # `get_template` resolves a built-in, one of this project's own, or a retired id — and raises a 404
    # naming the theme when it is none of those. "default" comes back as None, meaning the shipped file.
    # No special case for "default" any more: it is a retired id, and `get_template` resolves it to the theme
    # the app actually starts on — which is what a preview of it should show.
    source = _store().get_template(name)
    # `colors` is the report's hand-picked accent, deep tone and paper as three hex values in that order,
    # comma-separated — a query string rather than a body because this is a GET the browser caches per URL,
    # and the gallery has to repaint when they change. Blanks mean "the set's own".
    picked = None
    if colors:
        parts = (colors.split(",") + ["", "", ""])[:3]
        picked = report_palettes.check_colors(dict(zip(("accent", "deep", "paper"), parts, strict=True)))
    png = report_preview.preview_png(source, palette=palette, palette_colors=picked)
    return {"name": name, "base64": base64.b64encode(png).decode()}


@router.get("/templates/{name}/source", summary="Any theme's source, to download and adapt")
def template_source(request: Request, name: str) -> dict:
    """Built-in *or* this project's own.

    The retired `/templates/default` only ever served the shipped ones, so a theme someone uploaded could
    never be got back out — which made it uneditable the moment the `.typ` on their disk was gone. This
    route replaced it (and IS now the only way to a template's source).
    """
    if name in typst_render.BUILTIN_TEMPLATES:
        return {"name": name, "source": typst_render.builtin_template_source(name)}
    # Raises a 404 naming the theme if the project does not have it.
    stored = _store().get_template(name)
    return {"name": name, "source": stored or typst_render.default_template_source()}


@router.get("/list/{database}", summary="A model's reports (without their sections)")
def list_reports(request: Request, database: str) -> dict:
    return {"reports": _store().list_reports(database)}


@router.get("/one/{database}/{report_id}", summary="One report with its sections")
def get_report(request: Request, database: str, report_id: str) -> dict:
    from prism_lca.engine.report_store import with_text_versions

    return with_text_versions(_store().get(database, report_id))


@router.get("/one/{database}/{report_id}/progress", summary="Where this report's running study build stands")
def report_progress(database: str, report_id: str) -> dict:
    """Polled by the page while a freshness check is in flight — the check waits for the whole study,
    minutes on a comparison over ecoinvent. Lock-free (see `report_snapshot._build_progress`): the poll
    must not queue behind the build it reports on. `build` is null when no build of this report runs —
    before it has started, after it has finished, or while it waits for another report's build.
    """
    return {"build": report_snapshot.build_progress(database, report_id)}


@router.post("/create", summary="Create a report for a model")
def create_report(request: Request, body: NewReportRequest) -> dict:
    created = _store().create(
        body.database,
        name=body.name,
        subtitle=body.subtitle,
        aggregate_by=body.aggregate_by,
        lang=body.lang,
        template=body.template,
        subjects=body.subjects,
        methods=body.methods,
        amount=body.amount,
        sections=body.sections,
    )
    # In the log so that every later chapter line has something to belong to: a project holds several
    # reports per model, and "who wrote this sentence" is only answerable once the reader knows which
    # document it was written into.
    report_audit.note(
        request,
        "create_report",
        f"Create report '{report_audit.report_label(created)}' for model '{body.database}' "
        f"({len(created.get('sections') or [])} chapter(s))",
        database=body.database,
    )
    return created


@router.post("/one/{database}/{report_id}", summary="Update report-level fields")
def update_report(request: Request, database: str, report_id: str, body: UpdateReportRequest) -> dict:
    # `exclude_unset`, not `exclude_none` — same reasoning as update_section: `null` is a value meaning
    # "clear this field back to its default", and dropping it silently made clearing impossible.
    patch = body.model_dump(exclude_unset=True)
    if "client_logo" in patch:
        patch["client_logo"] = report_pipeline.image_b64(patch["client_logo"], what="logo")
    if "cover_image" in patch:
        # Normalise here so the store holds bare base64: an empty value means "remove the cover", and a
        # browser hands over a data URL, whose prefix would end up inside the PNG bytes.
        patch["cover_image"] = report_pipeline.image_b64(patch["cover_image"])
    updated = _store().update(database, report_id, patch)
    # Whether this mutation can move the staleness verdicts — the backend owns that judgement; the
    # frontend used to keep its own list of field names and guess. The list is exactly what a
    # chapter's record is compared against (`report_staleness.selection_of`), `lang` included: a
    # report switched to another language has chapters written in the old one.
    moves = {"subjects", "methods", "amount", "aggregate_by", "lang"}
    moved = bool(moves & set(patch))
    # `options` is a mixed bag — outlines and figures are how the document is dressed — but the
    # significance threshold is a number the prose quotes, so it belongs to the same comparison. Sent
    # whole by the panel, so this fires for a neighbouring toggle too; a re-check answers from the
    # cached snapshot and is arithmetic on records already stored.
    if isinstance(patch.get("options"), dict) and "significance_percent" in patch["options"]:
        moved = True
    # Logged for exactly the fields that move a verdict, and for no others. A palette, a cover picture
    # or a subtitle is how the document is dressed; these five (plus the threshold the prose quotes)
    # decide what it is *about*, so they are the reason a chapter somebody paid for stops being
    # current — and that is the question this line answers three weeks later. Every mutation here
    # would instead put one entry in the log per toggle click, since options are written through
    # without a Save button.
    if moved:
        changed = sorted(moves & set(patch))
        if isinstance(patch.get("options"), dict) and "significance_percent" in patch["options"]:
            changed.append("significance_percent")
        report_audit.note(
            request,
            "set_report_basis",
            f"Change the basis of report '{report_audit.report_label(updated)}' ({', '.join(changed)})",
            database=database,
        )
    return {**updated, "affects_staleness": moved}


@router.post("/one/{database}/{report_id}/delete", summary="Delete a report")
def delete_report(request: Request, database: str, report_id: str) -> dict:
    # Counted before it is gone, because afterwards nothing can say how much was in it. This is the
    # most destructive action in the module — an afternoon of written, paid-for chapters — and it left
    # no trace at all.
    before = best_effort(lambda: _store().get(database, report_id)) or {}
    result = _store().delete(database, report_id)
    sections = before.get("sections") or []
    written = sum(1 for s in sections if (s.get("text") or "").strip())
    report_audit.note(
        request,
        "delete_report",
        f"Delete report '{report_audit.report_label(before) if before else report_id}' of model "
        f"'{database}' ({len(sections)} chapter(s), {written} of them written)",
        database=database,
    )
    return result


@router.post("/one/{database}/{report_id}/sections", summary="Add a section")
def add_section(request: Request, database: str, report_id: str, body: SectionRequest) -> dict:
    spec = body.model_dump(exclude_none=True)
    at = spec.pop("at", None)
    return _store().add_section(database, report_id, spec, at=at)


@router.post("/one/{database}/{report_id}/sections/{section_id}", summary="Update a section")
def update_section(request: Request, database: str, report_id: str, section_id: str, body: SectionRequest) -> dict:
    # `exclude_unset`, not `exclude_none`: for this endpoint `null` is a value, not an absence. Clearing
    # `prompt_override` is how a chapter goes back to the standard prompt, and `exclude_none` dropped it
    # silently — the request succeeded and changed nothing. Fields the client did not mention are still
    # left alone, which is what a patch has to do.
    patch = body.model_dump(exclude_unset=True)
    patch.pop("at", None)
    # Only for the two fields that get an audit line, so a drag-and-drop or a figure toggle pays
    # nothing for a read it does not need.
    before = _section_before(request, database, report_id, section_id) if {"text", "locked"} & set(patch) else {}
    record = _record_for_prose(request, database, report_id, section_id, patch) if {"text", "figures"} & set(patch) else {}
    patch.update(record)
    updated = _store().update_section(database, report_id, section_id, patch)
    _note_section_edit(request, database, report_id, before, updated, patch)
    from prism_lca.engine.report_store import text_version

    # A text edit is how an author fixes a flagged sentence, so the badge has to follow it — and so does
    # a changed figure caption, which cites like the text; the other section fields are
    # presentation. The backend says so instead of the frontend guessing by key.
    return {
        **updated,
        "text_version": text_version(updated.get("text")),
        "affects_staleness": "text" in patch or "caption_bindings" in record,
    }


def _section_before(request: Request, database: str, report_id: str, section_id: str) -> dict:
    """The chapter as it stands before this write — for the audit line, best-effort.

    Best-effort, and never fatal: this is bookkeeping about the edit, and an unreadable store has to
    fail in the store's own words (`report_store._load` raises a sentence the author can act on), not
    here.
    """
    got = best_effort(lambda: _store().get(database, report_id))
    if not got:
        return {}
    section = next((s for s in got.get("sections") or [] if s.get("id") == section_id), None) or {}
    # The report travels with it: an audit line has to name which of a model's reports it is about.
    return {**section, "_report": got}


def _note_section_edit(
    request: Request, database: str, report_id: str, before: dict, updated: dict, patch: dict
) -> None:
    """Audit lines for the two things this endpoint does that a reviewer asks about.

    Both are compared against the stored state rather than taken from the request, because the editor
    saves on blur: clicking into the text box and out again posts the very same text, and an entry
    saying the chapter was edited when it was not is worse than no entry. Everything else this
    endpoint can patch — title, figures, table layout, inventory parts — is presentation, and one line
    per toggle would bury the lines that matter.

    The writing paths do not come through here: `section_proposal`, `section_patch`,
    `section_accepted` and `mark_reviewed` call the store directly and write their own lines, so a
    chapter cannot be logged twice for one change.

    ``before`` is read only when one of the two fields is in the patch, and is empty only if the store
    could not be read at all — in which case the write above has already raised in the store's words.
    """
    if not {"text", "locked"} & set(patch):
        return
    where = f"report '{report_audit.report_label(before.get('_report') or {'id': report_id})}'"
    label = report_audit.chapter_label(updated or before)
    if "locked" in patch and bool(patch["locked"]) != bool(before.get("locked")):
        frozen = bool(patch["locked"])
        report_audit.note(
            request,
            "freeze_report_chapter" if frozen else "unfreeze_report_chapter",
            f"{'Lock' if frozen else 'Unlock'} chapter '{label}' in {where}",
            database=database,
        )
    if "text" in patch and str(patch["text"] or "") != str(before.get("text") or ""):
        report_audit.note(
            request,
            "edit_report_chapter",
            f"Edit chapter '{label}' in {where} by hand "
            f"({report_audit.size(before.get('text'))} → {report_audit.size(patch['text'])})",
            database=database,
        )


def _record_for_prose(request: Request, database: str, report_id: str, section_id: str, patch: dict) -> dict:
    """What this text points at, and what it was written against — the record a hand edit also gets.

    The writing paths have always stored both. This one stored `text` alone, so a chapter the author
    edited by hand kept the bindings of the sentence it no longer contains and got none for the
    sentence it now does. Both directions were wrong and both were silent: an orphaned binding put a
    permanent "out of date" badge on a healthy chapter, and a `{{hotspots.2.name}}` typed by hand
    followed *position* two instead of the process the author meant — which is precisely what the
    bindings exist to prevent.

    It then over-corrected: re-binding *everything* the chapter cites made one hand-fixed typo re-point
    every other sentence at today's ranking (V180). Measured case — a chapter that spelled out two
    incineration datasets by name and cited `{{hotspots.2.share_text}}` for one of them; the process had
    since slipped to rank six, the pin still held the figure to it, and correcting a word three
    paragraphs above would have printed rank three's share under the PET dataset's name, badge and all
    gone green. So the correction path's rule applies here too (`report_ai.section_patch`,
    `report_data.bindings_for`): a pin only moves when the sentence that made the claim is rewritten,
    and `report_patch.surviving_bindings` decides which sentences those are. A placeholder the author
    genuinely types anew is still bound against today's data, and one they delete still takes its
    binding with it — neither needs a pin to survive.

    Figure captions cite like the text but are pinned and recorded in their own namespace
    (`caption_bindings`/`caption_based_on`, `report_gate.caption_record`): a caption edit
    in the figure editor gets the caption half, under the same rule — a caption left word for word
    keeps its pins, a new or reworded one is bound against today's data, and every finding still open
    about the captions stays open. A text edit touches only the text half, so it can neither re-stamp
    a caption's finding nor let a caption pin decide what an index in the new text means. A figures
    patch that changes no caption (a reorder, a toggle) records nothing.

    Best-effort. An incomplete report cannot be rendered, and typing into a chapter has to keep
    working there; then the chapter stays unbound and unrecorded, exactly as it was before. Cheap in
    the normal case because the data snapshot is shared (see `_analysis_snapshot`).
    """
    from prism_lca.engine import (
        report_data,
        report_gate,
        report_patch,
        report_prompts,
        report_staleness,
    )

    after_fields: dict = {}
    if "text" in patch:
        after_fields["text"] = str(patch["text"] or "")
    if "figures" in patch:
        # Normalised as the store will normalise them, so the captions read here are the ones stored.
        # A spec the store refuses is refused there, in its words; nothing to record for it here.
        try:
            after_fields["figures"] = report_prompts.accept_figures(patch["figures"])
        except PrismError:
            return {}
        # The store drops the legacy singular with a list write (`report_store.update_section`).
        after_fields["figure"] = None
    got = best_effort(lambda: report_pipeline.analysis_snapshot(database, report_id, RenderRequest()))
    if got is None:
        return {}
    report, data = got
    # The chapter as it stands *before* this write — the snapshot reads the definition fresh, and this
    # runs ahead of the store, so its text and pins are the ones the edit started from.
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None) or {}
    after = {**section, **after_fields}
    # The caption half: a caption edit records it; any other write that replaces `bindings` still
    # writes out a legacy chapter's caption pins first, or they would go with the text's.
    record = (
        report_gate.caption_record(section, after, report, data)
        if "figures" in patch
        else report_staleness.caption_migration(section)
    )
    if "text" in patch:
        text = after_fields["text"]
        keep = report_patch.surviving_bindings(section.get("text") or "", text, section.get("bindings") or {})
        previous = section.get("previous") or {}
        if text == previous.get("text") and previous.get("bindings"):
            # The earlier wording put back: it means what it meant, under the pins it had.
            keep = previous["bindings"]
        bindings = report_data.bindings_for(text, data, keep=keep)
        record.update(
            # A hand edit is a write: the chapters summarising this one should read it again (V423).
            written_sha=report_staleness.written_fingerprint({"text": text}),
            bindings=bindings,
            based_on=report_staleness.with_sources(
                report_staleness.components(text, bindings, report, data), after, report, data, section.get("lookups")
            ),
        )
    return record


@router.post("/one/{database}/{report_id}/sections/{section_id}/delete", summary="Delete a section")
def delete_section(request: Request, database: str, report_id: str, section_id: str) -> dict:
    # Read first: what a deletion destroyed is exactly what cannot be looked up afterwards.
    before = _section_before(request, database, report_id, section_id)
    result = _store().delete_section(database, report_id, section_id)
    text = str(before.get("text") or "")
    report_audit.note(
        request,
        "delete_report_chapter",
        f"Delete chapter '{report_audit.chapter_label(before)}' from "
        f"report '{report_audit.report_label(before.get('_report') or {'id': report_id})}' "
        + (
            f"({report_audit.size(text)}"
            + (f", written with '{before['model']}'" if before.get("model") else "")
            + ")"
            if text.strip()
            else "(no text)"
        ),
        database=database,
    )
    return result


@router.post("/one/{database}/{report_id}/reorder", summary="Reorder sections (drag & drop)")
def reorder_sections(request: Request, database: str, report_id: str, body: ReorderRequest) -> dict:
    return _store().reorder_sections(database, report_id, body.order)


class PreviewRequest(RenderRequest):
    #: 1-based; clamped to the document, so paging past the end returns the last page rather than 404.
    page: int = Field(default=1, ge=1)
    #: Screen resolution. 96 is a readable thumbnail without making the payload large — the preview
    #: travels base64 over IPC like everything else. Capped: every page of the document is rasterised
    #: and cached at this resolution, so an absurd value is a memory problem, not a sharper preview.
    ppi: int = Field(default=96, ge=16, le=384)
    #: Turning a page rather than asking for a new render. With this set the typeset document from the
    #: last fresh preview of this report is reused, so paging costs a lookup instead of recomputing the
    #: whole study. The client sends it for the page arrows and omits it for the Preview button, which
    #: makes "am I looking at current numbers" the user's decision rather than a hidden timeout.
    reuse: bool = False


@router.post("/one/{database}/{report_id}/pdf", summary="Typeset a stored report (base64 PDF)")
def render_stored_report(request: Request, database: str, report_id: str, body: RenderRequest) -> dict:
    """Render the stored definition: its sections, in their order, in its language.

    Everything the sections need is computed once and handed over as one snapshot, so the numbers in
    the prose and the numbers in the tables come from the same calculation and cannot disagree.
    """
    report, _inputs, sources, info = report_pipeline.document(database, report_id, body, use_token=True)
    _refuse_gaps(info["missing_placeholders"], body)
    pdf = typst_render.compile_pdf(sources)
    stem = report_pipeline.safe_name((report.get("name") or "report")[:60].strip() or "report")
    # The deliverable leaving the app is the event a reviewer dates the document by — and if it left
    # with holes in it, that is the single most important thing the log can say about it. Only the
    # PDF: `/preview` runs on every page turn and every option change, and `/sources` is the first
    # half of *both* of them (the renderer draws the figures from it), so logging either would file
    # dozens of "exports" that never left the machine.
    gaps = info["missing_placeholders"]
    report_audit.note(
        request,
        "typeset_report",
        f"Typeset report '{report_audit.report_label(report)}' as '{stem}.pdf' "
        f"({len(report.get('sections') or [])} chapter(s), {round(len(pdf) / 1024)} kB)"
        + (f" — exported with {len(gaps)} gap(s)" if gaps else "")
        + (" — marked as a draft" if body.draft else ""),
        database=database,
    )
    return {
        "filename": f"{stem}.pdf",
        "base64": base64.b64encode(pdf).decode("ascii"),
        # Named so a hole in the document is visible instead of silent.
        "missing_placeholders": info["missing_placeholders"],
    }


def _refuse_gaps(missing: list[str], body: RenderRequest) -> None:
    """The export gate: a deliverable with "[missing: …]" in it is a decision, not a surprise.

    The preview stays ungated on purpose — it is the working view where gaps are *found*. Only what
    leaves the app as a document refuses, and `allow_gaps` is the explicit way through.
    """
    if not missing or body.allow_gaps:
        return
    shown = ", ".join(missing[:4]) + ("…" if len(missing) > 4 else "")
    raise PrismError(
        f"{len(missing)} placeholder(s) or reference(s) would print as gaps: {shown}",
        code="report_has_gaps",
        hint="Fix the chapters they sit in (the preview shows each gap), or export anyway with allow_gaps.",
    )


@router.post("/one/{database}/{report_id}/preview", summary="One page of a stored report as PNG")
def preview_stored_report(request: Request, database: str, report_id: str, body: PreviewRequest) -> dict:
    """The typeset page, not an HTML lookalike.

    Reordering chapters is the moment this earns its keep: page breaks, table widths and caption
    numbering only exist after typesetting, so an approximation is exactly wrong where it matters. It
    goes through the same renderer as the PDF, so the preview cannot disagree with the output.
    """
    from prism_lca.engine import report_render

    key = report_snapshot.preview_key(database, report_id)
    cached = report_snapshot.preview_get(key) if body.reuse else None
    if cached is not None:
        sources, missing, unexplained = cached
    else:
        # Spelled out rather than going through `document`: this is the one caller that renders with a
        # *different* timestamp, and hiding that behind a flag would bury the reason below.
        spent = report_snapshot.spend_render_token(key, body.render_token, body.figures, body.method_references)
        report, inputs = spent if spent else report_pipeline.render_inputs(database, report_id, body)
        # A fixed timestamp for the preview: the minute-precision "generated" stamp in the colophon is
        # part of the sources, so a page turn crossing a minute boundary used to invalidate the page
        # cache and recompile the whole document. The PDF still stamps the real time.
        sources, info = report_render.render_sources(
            report, **report_pipeline.as_kwargs(inputs), generated=report.get("updated", "")[:16].replace("T", " ")
        )
        missing = info["missing_placeholders"]
        unexplained = info["unexplained_abbreviations"]
        report_snapshot.preview_put(key, (sources, missing, unexplained))
    png, pages = typst_render.compile_png(sources, page=body.page, ppi=body.ppi)
    return {
        "page": max(1, min(body.page, pages)),
        "pages": pages,
        "base64": base64.b64encode(png).decode("ascii"),
        "missing_placeholders": missing,
        "unexplained_abbreviations": unexplained,
    }


@router.post("/one/{database}/{report_id}/sources", summary="The Typst sources of a stored report")
def render_stored_sources(request: Request, database: str, report_id: str, body: RenderRequest) -> dict:
    """The `.typ` project as text — the basis of the hand-off bundle, and useful for debugging a
    template: this is exactly what the compiler was given."""
    key = report_snapshot.preview_key(database, report_id)  # taken before computing — see new_render_token
    report, inputs, sources, info = report_pipeline.document(database, report_id, body)
    token = report_snapshot.new_render_token(key, report, inputs)
    return _sources_response(report, inputs, sources, info, token)


def _sources_response(report: dict, inputs: dict, sources: dict, info: dict, token: str) -> dict:
    """What the renderer needs to draw the figures — for a stored report and for the short report alike."""
    return {
        # The data snapshot rides along so the renderer can draw the figures from the very numbers
        # this render used, then post them back for the PDF.
        "data": info["data"],
        # Hand this back with the figures and the second render skips the recomputation entirely.
        "render_token": token,
        # The report's own options, so the renderer knows which comparison figures were asked for.
        "options": report.get("options") or {},
        # The report's language. The renderer draws the figures, and one of them carries a word of its
        # own — the "Total" group at the end of the contribution chart — which has to be in the
        # document's language like every other label around it.
        "language": report.get("lang", "en"),
        # The colour set, because the renderer draws the figures: a document typeset in Steel & ink with
        # lime-green bars in it would be two designs in one report. The chart colours are derived from these
        # three the same way in every figure — see the renderer's `reportColors`.
        "palette": report.get("palette") or "",
        # And the three a report may override by hand, for the same reason: a figure drawn in the set's lime
        # inside a document typeset in someone's own blue is the one case where the charts and the page
        # disagree about what colour the report is.
        "palette_colors": report.get("palette_colors") or {},
        # Whether this report's theme typesets on dark paper. The renderer draws the figures, so it needs to
        # know: axis text and grid lines that read on white are invisible on near-black, which is exactly what
        # a dark theme produced before this flag existed.
        "dark": bool(
            (typst_render.BUILTIN_TEMPLATES.get(report.get("template") or "") or {}).get("dark", False)
        ),
        # The faces the theme typesets in, so the figures are lettered in them too. A default for the themes
        # that predate the field and for a theme the project uploaded — an uploaded one declares its fonts in
        # Typst, which we cannot read, so its charts stay in the app's own face rather than guessing.
        "fonts": (typst_render.BUILTIN_TEMPLATES.get(report.get("template") or "") or {}).get("fonts")
        or {"body": "Noto Sans", "mono": "DejaVu Sans Mono"},
        # Which chapters asked for figures, and what they asked for — plus every chapter's kind, because one
        # kind (the executive summary) has a standard figure of its own that no spec describes. `figures` is
        # the list a chapter now owns; `figure` is the writer's single proposal, still sent so a report
        # written before the list existed draws exactly what it drew yesterday.
        "sections": [
            {
                "id": s.get("id"),
                "kind": s.get("kind"),
                "figure": s.get("figure"),
                "figures": s.get("figures") or [],
                # The system-model chapter's drawing options — how the renderer colours and labels it.
                "colour_by": s.get("colour_by"),
                "edge_amounts": bool(s.get("edge_amounts", False)),
            }
            for s in report.get("sections") or []
            if s.get("figure") or s.get("figures") or s.get("kind") in ("summary", "system_model")
        ],
        "files": {name: content for name, content in sources.items() if isinstance(content, str)},
        "binary": sorted(name for name, content in sources.items() if isinstance(content, bytes)),
        "missing_placeholders": info["missing_placeholders"],
    }


# ---- the short report: the same pipeline, a definition that is never stored -------------------
@router.post("/short/sources", summary="Short report — the data snapshot and a render token")
def short_sources(request: Request, body: report_short.ShortSettings) -> dict:
    """First half of the short report's two-step render: the study is computed from the
    rail's settings, the renderer draws the figures from the snapshot returned here and posts them back
    with the token to `/short/preview` or `/short/pdf`."""
    key = report_short.preview_key(body)  # taken before computing — see new_render_token
    report, inputs, sources, info = report_short.document(body)
    token = report_snapshot.new_render_token(key, report, inputs)
    return _sources_response(report, inputs, sources, info, token)


@router.post("/short/preview", summary="Short report — one typeset page as PNG")
def short_preview(request: Request, body: report_short.ShortPreviewRequest) -> dict:
    sources, missing, unexplained = report_short.preview_sources(body)
    png, pages = typst_render.compile_png(sources, page=body.page, ppi=body.ppi)
    return {
        "page": max(1, min(body.page, pages)),
        "pages": pages,
        "base64": base64.b64encode(png).decode("ascii"),
        "missing_placeholders": missing,
        "unexplained_abbreviations": unexplained,
    }


@router.post("/short/pdf", summary="Short report — typeset (base64 PDF)")
def short_pdf(request: Request, body: report_short.ShortSettings) -> dict:
    """No export gate: a short report has no placeholders — nothing in it was written."""
    report, inputs, sources, _info = report_short.document(body, use_token=True)
    pdf = typst_render.compile_pdf(sources)
    stem = report_short.pdf_stem(report, inputs)
    # Logged like the stored one: what makes an export worth recording is that a document left the
    # app, not which of the two routes typeset it.
    report_audit.note(
        request,
        "typeset_short_report",
        f"Typeset a short report of model '{body.database}' as '{stem} — LCA report.pdf' "
        f"({len(body.methods)} indicator(s), {len(report.get('sections') or [])} chapter(s), "
        f"{round(len(pdf) / 1024)} kB)",
        database=body.database,
    )
    return {"filename": f"{stem} — LCA report.pdf", "base64": base64.b64encode(pdf).decode("ascii")}


@router.post("/one/{database}/{report_id}/bundle", summary="The report as a Typst project (base64 ZIP)")
def report_bundle(request: Request, database: str, report_id: str, body: RenderRequest) -> dict:
    """Everything needed to carry on without PrismLCA: sources, template, data, charts and a README.

    This is the reason Typst was chosen over printing a PDF — a PDF is an endpoint, these files are a
    working state. The split matters: `main.typ` becomes the author's, while `values.json`, `data.json`
    and `charts/` stay ours to regenerate, so edited prose can still pick up new numbers. It is a split
    of ownership, not of files — the document is one `main.typ`, and the numbers in it are lookups.
    """
    import io
    import json as _json
    import zipfile

    report, _inputs, sources, info = report_pipeline.document(database, report_id, body, use_token=True)
    _refuse_gaps(info["missing_placeholders"], body)

    name = (report.get("name") or "report").strip() or "report"
    version = getattr(request.app.state.settings, "app_version", "")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for path, content in sources.items():
            zf.writestr(path, content if isinstance(content, bytes) else content.encode("utf-8"))
        zf.writestr("data.json", _json.dumps(info["data"], indent=1, ensure_ascii=False))
        zf.writestr("README.md", report_pipeline.bundle_readme(name, version, zf.namelist()))
    # The hand-off is a copy of the study leaving the building, so it belongs in the trail as much as
    # the PDF does — with the file count, because what travelled is what the recipient will ask about.
    report_audit.note(
        request,
        "export_report_bundle",
        f"Export report '{report_audit.report_label(report)}' as a Typst project "
        f"('{report_pipeline.safe_name(name)}.zip', {len(sources) + 2} file(s))",
        database=database,
    )
    return {
        "filename": f"{report_pipeline.safe_name(name)}.zip",
        "base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
        "missing_placeholders": info["missing_placeholders"],
    }


@router.post(
    "/one/{database}/{report_id}/data", summary="The data, the values and the charts, to refresh an exported bundle"
)
def report_data_only(request: Request, database: str, report_id: str, body: RenderRequest) -> dict:
    """The "update data only" half of the hand-off: current numbers and diagrams, no prose.

    Dropping these into an exported bundle updates every figure in text the author has since rewritten,
    because the text references the values instead of containing them.
    """
    import json as _json

    _refuse_positional_charts(body)
    _report, _inputs, sources, info = report_pipeline.document(database, report_id, body)
    charts = {path: content for path, content in sources.items() if path.startswith("charts/")}
    return {
        "data_json": _json.dumps(info["data"], indent=1, ensure_ascii=False),
        # The file the prose actually reads. `data.json` is the snapshot a person consults; the sentences
        # resolve their figures through `#pval()` against `values.json`, so a refresh without it moved
        # the tables and the charts and left every rewritten paragraph quoting last month's result —
        # which is the one thing this endpoint exists to prevent.
        "values_json": str(sources.get("values.json", "")),
        # And the file the tables read: without it a refresh moved the sentences and left the table beside
        # them on the export's numbers.
        "tables_json": str(sources.get("tables.json", "")),
        # And the charts' manifest: a `#pfigure` finds its file through it, and a chart it no longer lists
        # prints as a gap — dropped in without it, the old file under `charts/` would keep printing.
        "figures_json": str(sources.get("figures.json", "")),
        "charts": {path: content for path, content in charts.items() if isinstance(content, str)},
        "missing_placeholders": info["missing_placeholders"],
    }


def _refuse_positional_charts(body: RenderRequest) -> None:
    """A refresh takes charts keyed by what they show, never by their position (`lcia-1`).

    An export from before 29 Sept 2026 embeds the positional names directly; a chart accepted under one
    would stand in such a document under another chart's caption — possibly another indicator's.
    """
    stale = report_pipeline.positional_chart_keys(body.figures)
    if stale:
        raise PrismError(
            f"Figures named by position cannot refresh an export: {', '.join(stale[:5])}"
            + (" …" if len(stale) > 5 else ""),
            code="positional_figure_keys",
            hint="Charts are keyed by what they show (e.g. 'lcia:<method path>'); redraw them with the current app.",
        )


def _refreshable(path: str) -> bool:
    """What a data refresh may overwrite in an exported project: the lookups and the charts.

    `tables.json` is one of them since the tables are read from it — leaving it out would bring
    back exactly the split this archive exists to prevent, new text beside an old table. `figures.json`
    likewise for the charts: it is the list a `#pfigure` call looks its file up in.
    """
    return path in ("values.json", "tables.json", "figures.json") or path.startswith("charts/")


@router.post(
    "/one/{database}/{report_id}/data/archive",
    summary="The data, the values and the charts as a ZIP — the 'update data only' hand-out",
)
def report_data_archive(request: Request, database: str, report_id: str, body: RenderRequest) -> dict:
    """The same three things `/data` returns, packed so a person can actually use them.

    The endpoint above hands the files back as strings, which is right for a caller that writes them
    itself and wrong for the case the README describes: somebody who edited `main.typ` and wants today's
    numbers under their own prose. They need files, in the layout the export already has.

    No gap gate here, deliberately. `/pdf` and `/bundle` refuse a document with holes because the hole
    would be printed and handed to a client. This archive contains no prose at all — and a recipient
    whose text quotes a key that has since gone needs this hand-out to find that out. Refusing it would
    lock the door to the room where the problem is. The gaps are reported, and the caller says so.
    """
    import io
    import json as _json
    import zipfile

    _refuse_positional_charts(body)
    report, _inputs, sources, info = report_pipeline.document(database, report_id, body, use_token=True)
    name = (report.get("name") or "report").strip() or "report"
    refreshed = [p for p in sources if _refreshable(p)]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("data.json", _json.dumps(info["data"], indent=1, ensure_ascii=False))
        # Only what a refresh may overwrite. `main.typ`, `template.typ` and `palette.typ` are the
        # recipient's from the moment they were exported; shipping them here would let a data update
        # quietly revert an afternoon of editing.
        for path in refreshed:
            content = sources[path]
            zf.writestr(path, content if isinstance(content, bytes) else content.encode("utf-8"))
    report_audit.note(
        request,
        "export_report_data",
        f"Export the numbers behind report '{report_audit.report_label(report)}' "
        f"('{report_pipeline.safe_name(name)} — data.zip', "
        f"{1 + len(refreshed)} file(s))",
        database=database,
    )
    return {
        "filename": f"{report_pipeline.safe_name(name)} — data.zip",
        "base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
        "missing_placeholders": info["missing_placeholders"],
    }


class AbbreviationsRequest(BaseModel):
    #: Proposed expansions. Keys that are not candidates are dropped, which is what makes asking a
    #: model for these safe.
    resolved: dict[str, str] = {}
    code: str | None = None
    methods: list[MethodRef] | None = None
    amount: float | None = None
    aggregate_by: str | None = None


@router.post("/one/{database}/{report_id}/abbreviations", summary="Acronyms the document actually uses")
def abbreviations(request: Request, database: str, report_id: str, body: RenderRequest) -> dict:
    """Extract the candidates from the rendered document, deterministically.

    Finding and explaining are different jobs and only one of them needs a model: asked to *find* the
    abbreviations a model invents ones the text never used, while asked to explain a fixed list it can
    only be wrong about a meaning — which a reader can check.
    """
    from prism_lca.engine import report_abbreviations

    report, _inputs, sources, info = report_pipeline.document(database, report_id, body)
    main = report_typst.document_text(sources)
    units = [r.get("unit", "") for r in info["data"].get("results", [])]
    candidates = report_abbreviations.abbreviation_candidates(main, extra=[u for u in units if u])
    return {
        "candidates": candidates,
        "resolved": report.get("abbreviations") or {},
        "language": report.get("lang", "en"),
        # Where each one stands in the text. Without it the model explained the lorry class EURO 6 as
        # "Euro (currency)" and the brand LUX-TOOLS as Luxembourg (V410): a list of bare
        # tokens has no way to tell which EURO is meant. One window per abbreviation, around its first
        # occurrence, with the Typst commands stripped.
        "contexts": report_abbreviations.abbreviation_contexts(main, candidates),
    }


@router.post("/one/{database}/{report_id}/translations", summary="Study texts a translation could cover")
def translations(request: Request, database: str, report_id: str, body: RenderRequest) -> dict:
    """The candidates, from the checking snapshot — collecting is deterministic, translating is not.

    Same division of labour as the abbreviations: this endpoint walks, a model (called by the
    client) translates the fixed list, and `translations/set` refuses keys that were never
    candidates. Reads the snapshot cache, so after a brief or a staleness check it costs nothing.
    """
    from prism_lca.engine import report_translations as rtr

    report, data = report_pipeline.analysis_snapshot(database, report_id, body)
    candidates = (data.get("translations") or {}).get("candidates") or []
    lang = report.get("lang", "en")
    mapping = rtr.stored_map(report)
    # The client hands these lists to a model; the `origin` marker is bookkeeping for `foreign` below.
    plain = [{"key": c["key"], "text": c["text"]} for c in candidates]
    return {
        # What has no stored answer yet — new sources, or sources whose text changed (new key).
        "open": [c for c in plain if c["key"] not in mapping],
        # Sources whose stored answer IS the source: either genuinely already in the report
        # language, or a lazy model kept them unchanged — short scenario names, in a real run.
        # Returned so the client can ask again with a better prompt; a truly-English text just
        # comes back unchanged once more and costs a few tokens.
        "unchanged": [c for c in plain if mapping.get(c["key"]) == c["text"]],
        # Review findings still printed in another language than the report's (V425). Independent of
        # the study's language: the reviewer writes English, so a German study in a German report still
        # needs these translated — and only these, which is why they are listed on their own.
        "foreign": rtr.foreign_open(candidates, report),
        "total": len(candidates),
        "stored": len(mapping),
        "language": lang,
    }


@router.post(
    "/one/{database}/{report_id}/translations/foreign",
    summary="Review findings the report would print in another language",
)
def translations_foreign(request: Request, database: str, report_id: str) -> dict:
    """`foreign` of the endpoint above, without its snapshot.

    The review findings come from the review log, a file read, so whether a run needs that translation
    step is known before anything is calculated. "Write all" asks this before it writes: on a report with
    nothing written the full endpoint built the snapshot just to answer it — every indicator of every
    variant, minutes on a cold cache, behind a dialog that had nothing to check.
    """
    from prism_lca.engine import lca
    from prism_lca.engine import report_translations as rtr
    from prism_lca.engine.review_log import ReviewLogStore

    report = _store().get(database, report_id)
    review = ReviewLogStore().for_report(database, lca.model_generation())
    return {"foreign": rtr.foreign_open(rtr.candidates({"review": review}), report)}


class TranslationsRequest(BaseModel):
    #: Proposed translations, keyed by the candidate's `key`. Unknown keys are dropped — that is
    #: what makes handing the list to a model safe.
    resolved: dict[str, str] = {}
    code: str | None = None
    methods: list[MethodRef] | None = None
    amount: float | None = None
    aggregate_by: str | None = None


@router.post("/one/{database}/{report_id}/translations/set", summary="Store translations (non-candidates dropped)")
def set_translations(request: Request, database: str, report_id: str, body: TranslationsRequest) -> dict:
    from prism_lca.engine import report_translations as rtr

    report, data = report_pipeline.analysis_snapshot(
        database,
        report_id,
        RenderRequest(code=body.code, methods=body.methods, amount=body.amount, aggregate_by=body.aggregate_by),
    )
    known = {c["key"]: c["text"] for c in (data.get("translations") or {}).get("candidates") or []}
    accepted, refused = rtr.accept_with_reasons(known, body.resolved)
    dropped = sorted(set(body.resolved) - set(accepted) - set(refused))
    lang = report.get("lang", "en")
    stored = report.get("translations") or {}
    # Merge only within the language the map was made for — a language switch starts a fresh map,
    # because the old entries are not stale, they are in the wrong language.
    merged = dict(stored.get("map") or {}) if isinstance(stored, dict) and stored.get("lang") == lang else {}
    merged.update(accepted)
    _store().update(database, report_id, {"translations": {"lang": lang, "map": merged}})
    translated = sum(1 for key, text in accepted.items() if text != known[key].strip())
    # `ai` without a model id, and that is a statement about the path rather than a guess: this
    # endpoint exists only to store what a model translated (the candidates are collected
    # deterministically next door, the translating is not), and the request carries no model name to
    # record. Which model did it is answerable from Settings → Usage & costs for the same month; a
    # made-up id here would be worse than none.
    report_audit.note(
        request,
        "translate_report_texts",
        f"Translate the study texts of report '{report_audit.report_label(report)}' into '{lang}' "
        f"({translated} translated, {len(accepted) - translated} left unchanged, "
        f"{len(merged)} stored in total)",
        database=database,
        source="ai",
    )
    return {
        "stored": len(merged),
        "translated": translated,
        "identical": len(accepted) - translated,
        "dropped": dropped,
        # Known candidates whose translation changed a figure — not stored, and said so: a stored
        # translation becomes a quotable source for the gate.
        "rejected": [{"key": k, "text": known[k], "reason": r} for k, r in refused.items()],
    }


@router.post("/one/{database}/{report_id}/abbreviations/set", summary="Store expansions (non-candidates dropped)")
def set_abbreviations(request: Request, database: str, report_id: str, body: AbbreviationsRequest) -> dict:
    from prism_lca.engine import report_abbreviations

    report, _inputs, sources, info = report_pipeline.document(
        database,
        report_id,
        RenderRequest(code=body.code, methods=body.methods, amount=body.amount, aggregate_by=body.aggregate_by),
    )
    units = [r.get("unit", "") for r in info["data"].get("results", [])]
    candidates = report_abbreviations.abbreviation_candidates(
        report_typst.document_text(sources), extra=[u for u in units if u]
    )
    accepted = report_abbreviations.accept_abbreviations(candidates, body.resolved)
    dropped = sorted(set(body.resolved) - set(accepted))
    _store().update(database, report_id, {"abbreviations": accepted})
    # Same division of labour as the translations, so the same `source` for the same reason.
    report_audit.note(
        request,
        "set_report_abbreviations",
        f"Explain {len(accepted)} abbreviation(s) in report '{report_audit.report_label(report)}'"
        + (f" ({len(dropped)} dropped as no candidate)" if dropped else ""),
        database=database,
        source="ai",
    )
    return {"resolved": accepted, "dropped": dropped}
