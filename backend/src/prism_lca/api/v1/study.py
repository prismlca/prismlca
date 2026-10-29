"""ISO study-metadata endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import commands, comparison_brief
from prism_lca.engine.study import StudyMetaStore

router = APIRouter(prefix="/study", tags=["study"], dependencies=[Depends(require_token)])


class StudyRequest(BaseModel):
    database: str  # the foreground model this study describes
    #: The language the study is documented in (one of the report languages, default "en").
    language: str | None = None
    goal: str | None = None
    scope: str | None = None
    functional_unit: str | None = None
    #: Where the product is made and sold or used — the market the datasets have to match.
    geography: str | None = None
    #: The year or period the data should represent.
    reference_year: str | None = None
    system_boundaries: str | None = None
    cutoff_criteria: str | None = None
    #: Process allocation: how a multi-output process is split between its products.
    allocation: str | None = None
    #: System allocation: how end-of-life burdens and credits are handled (cut-off, avoided burden, …).
    system_allocation: str | None = None
    author: str | None = None
    #: The organisation carrying out the study; `commissioner` is who it was carried out for. Both are
    #: printed on the report cover.
    organisation: str | None = None
    commissioner: str | None = None
    #: Who reviewed the study and when — the description. What the report acts on is the answer below.
    critical_review: str | None = None
    #: Whether a critical review was carried out: "yes" | "no". A closed choice, and the only input to
    #: the ISO 14044 §7.3.3 note; the prose above cannot answer it, because its honest content is
    #: usually a negation (V191). An empty string means "not answered", like `language`.
    critical_review_done: str | None = None
    date: str | None = None
    notes: str | None = None
    #: What the modeller could not resolve, as `[{text, kind, subject}]` — kind one of limitation |
    #: assumption | exclusion | data_gap. A list of plain strings is accepted and normalised. The
    #: report's Limitations chapter prints these beside the ones it can check for itself.
    limitations: list | None = None
    #: The LLM behind an assistant edit, sent by the agent's tools alongside source="ai". Recorded
    #: on the study only when the call actually sets content (V128); a user edit never carries it.
    ai_model: str | None = None
    source: str = "user"


@router.get("", summary="Get a model's study metadata (ISO 14040/44)")
async def get_study(request: Request, database: str) -> dict:
    """The stored metadata, plus what the prose itself says about its language.

    `language` is a field somebody has to set, and a model built without touching it reads as English.
    An English report of a thoroughly German study therefore never translated anything and printed a
    page of German under "Declared by the study" (V158). `detected_language` is offered only when the
    field is unset, and only as something to confirm — it is never written to the study by itself.
    """
    from prism_lca.engine.report_translations import detect_language

    study = dict(StudyMetaStore().get(database))
    if not str(study.get("language") or "").strip():
        detected = detect_language(study)
        if detected:
            study["detected_language"] = detected
    return study


@router.post("", summary="Set/merge a model's study metadata")
async def set_study(request: Request, body: StudyRequest) -> dict:
    fields = body.model_dump(exclude={"source", "database", "ai_model"}, exclude_none=True)
    if "language" in fields and not str(fields["language"]).strip():
        fields.pop("language")  # an empty select means "unset", not "the language named ''"
    if "language" in fields:
        from prism_lca.engine.report_i18n import LANGUAGES

        code = str(fields["language"]).replace("_", "-").split("-")[0].lower()
        if code not in LANGUAGES:
            from prism_lca.errors import PrismError

            raise PrismError(
                f"Unknown study language '{fields['language']}'.",
                code="study_language_unknown",
                hint=f"One of: {', '.join(LANGUAGES)}.",
            )
        fields["language"] = code
    if "critical_review_done" in fields:
        from prism_lca.engine.study import CRITICAL_REVIEW_ANSWERS

        answer = str(fields["critical_review_done"]).strip().lower()
        if answer and answer not in CRITICAL_REVIEW_ANSWERS:
            from prism_lca.errors import PrismError

            raise PrismError(
                f"Unknown critical-review answer '{fields['critical_review_done']}'.",
                code="study_critical_review_unknown",
                hint=f"One of: {', '.join(CRITICAL_REVIEW_ANSWERS)}.",
            )
        # Empty is *stored* empty rather than dropped like an empty `language`: "not recorded" is an
        # answer an author can go back to, and it has to be able to take a "yes" back.
        fields["critical_review_done"] = answer
    # Confirming that an independent critical review took place is a statement about the world outside
    # the model, and the one statement that switches off a normative note — so it is the author's to
    # make, never the assistant's. The tool schema does not offer it, and this drops it if it ever
    # arrives anyway: an LLM reading "Keine kritische Prüfung" and answering "yes" to be helpful is
    # exactly the guess V191 was about. The assistant still writes the description beside it.
    if body.source == "ai":
        fields.pop("critical_review_done", None)
    # Which model wrote the study's words is a fact of the study (V128): stamped when the assistant
    # actually sets content, never from a user edit and never as the only change — an AI call that
    # writes nothing must not re-sign someone else's text.
    if body.ai_model and body.source == "ai" and fields:
        fields["ai_model"] = body.ai_model
    cmd = commands.SetStudyMetaCommand(StudyMetaStore(), body.database, fields)
    return request.app.state.command_bus.execute(cmd, source=body.source)


# --- comparison models ---------------------------------------------------------------------------
class LinkRequest(BaseModel):
    database: str  # the model the user is working in
    other: str  # the model it is (no longer) compared with
    source: str = "user"


@router.post("/link", summary="Make two models comparison models of each other (symmetric, undoable)")
async def link_models(request: Request, body: LinkRequest) -> dict:
    cmd = commands.LinkModelsCommand(StudyMetaStore(), body.database, body.other, link=True)
    return request.app.state.command_bus.execute(cmd, source=body.source)


@router.post("/unlink", summary="Stop comparing two models with each other (both sides, undoable)")
async def unlink_models(request: Request, body: LinkRequest) -> dict:
    cmd = commands.LinkModelsCommand(StudyMetaStore(), body.database, body.other, link=False)
    return request.app.state.command_bus.execute(cmd, source=body.source)


@router.get(
    "/comparison-brief",
    summary="What the assistant is told about a model it builds a comparison to (deterministic Markdown)",
)
async def get_comparison_brief(request: Request, database: str) -> dict:
    return comparison_brief.brief(database)
