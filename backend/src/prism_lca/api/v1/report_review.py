"""The second reader and what the author answers it: briefs for reading and updating, and the replies.

The reader itself is a model call in the main process; these routes assemble what it reads — from the
same snapshot the gate judges against, so the reader and the gate see one set of numbers — and keep
what the author decides about its questions and its open points. The rules about which findings a
reader may decide live in `engine/report_review`.
"""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import report_audit, report_pipeline, report_review
from prism_lca.engine.report_pipeline import RenderRequest
from prism_lca.engine.report_store import ReportStore, text_version
from prism_lca.errors import PrismError

router = APIRouter(prefix="/report", tags=["report"], dependencies=[Depends(require_token)])


def _section(report: dict, section_id: str) -> dict:
    section = next((s for s in report.get("sections", []) if s.get("id") == section_id), None)
    if section is None:
        raise PrismError(f"No section '{section_id}'.", code="report_section_not_found", status_code=404)
    return section


class ReviewBriefRequest(BaseModel):
    #: The proposed chapter, with its placeholders.
    text: str
    #: What the writer looked up — part of the evidence a quoted fact may rest on.
    lookups: list[dict] | None = None
    #: The snapshot the chapter was written from; a moved one is refused like at the gate.
    snapshot_id: str | None = None


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/review-brief",
    summary="What the second reader judges a proposed chapter against (no model)",
)
def section_review_brief(database: str, report_id: str, section_id: str, body: ReviewBriefRequest) -> dict:
    report, data = report_pipeline.analysis_snapshot(database, report_id, RenderRequest())
    section = _section(report, section_id)
    report_pipeline.require_snapshot(database, report_id, report, body.snapshot_id)
    return report_review.review_brief(section, report, data, body.text, body.lookups)


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/update-brief",
    summary="The writer's brief for bringing a written chapter up to date (no model)",
)
def section_update_brief(database: str, report_id: str, section_id: str) -> dict:
    report, data = report_pipeline.analysis_snapshot(database, report_id, RenderRequest())
    section = _section(report, section_id)
    if not str(section.get("text") or "").strip():
        raise PrismError(
            f"Section '{section_id}' has no text to update — write it instead.",
            code="report_section_empty",
            status_code=409,
        )
    brief = report_review.update_brief(section, report, data)
    brief["snapshot_id"] = report_pipeline.snapshot_id_for(database, report_id, report)
    brief["text_version"] = text_version(section.get("text"))
    return brief


class AnswerRequest(BaseModel):
    #: The question's id as the reading gave it (`q-…`).
    question_id: str
    #: The question, kept beside the answer so a brief can say what was asked.
    question: str = ""
    #: Empty withdraws the answer.
    answer: str = ""


@router.post("/one/{database}/{report_id}/answers", summary="Answer a question the writer asked")
def answer_question(request: Request, database: str, report_id: str, body: AnswerRequest) -> dict:
    store = ReportStore()
    report = store.get(database, report_id)
    answers = dict(report.get("answers") or {})
    if body.answer.strip():
        answers[body.question_id] = {
            "question": body.question.strip()[:600],
            "answer": body.answer.strip()[:2000],
            "at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
    else:
        answers.pop(body.question_id, None)
    store.update(database, report_id, {"answers": answers})
    report_audit.note(
        request,
        "answer_report_question",
        f"Answer a writer's question in report '{report_audit.report_label(report)}'",
        database=database,
    )
    return {"answers": answers}


class PointRequest(BaseModel):
    #: The open point's quote, as the reading stored it.
    quote: str


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/keep-point",
    summary="Keep a sentence the second reader still doubts, as written (no model)",
)
def keep_point(request: Request, database: str, report_id: str, section_id: str, body: PointRequest) -> dict:
    store = ReportStore()
    report = store.get(database, report_id)
    section = _section(report, section_id)
    review = report_review.current_review(section)
    if review is None:
        raise PrismError(
            "This chapter has changed since the second reader read it — there is no point to keep.",
            code="report_review_stale",
            status_code=409,
        )
    issues = [dict(i) for i in review.get("issues") or []]
    hit = next((i for i in issues if i.get("status") == "open" and i.get("quote") == body.quote), None)
    if hit is None:
        raise PrismError("No open point with this quote.", code="report_point_not_found", status_code=404)
    hit["status"] = "kept"
    hit["resolution"] = "Kept as written by the author."
    review = {
        **review,
        "issues": issues,
        "verdict": "accepted" if not any(i.get("status") == "open" for i in issues) else "open_points",
    }
    store.update_section(database, report_id, section_id, {"kind": section.get("kind", "prose"), "ai_review": review})
    report_audit.note(
        request,
        "keep_report_sentence",
        f"Keep a sentence the second reader doubted in chapter '{report_audit.chapter_label(section)}' of "
        f"report '{report_audit.report_label(report)}'",
        database=database,
    )
    return {"ai_review": review}
