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
from prism_lca.engine import (
    report_audit,
    report_gate,
    report_pipeline,
    report_review,
    report_typed_numbers,
)
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
    #: Why the author keeps it — recorded as the point's resolution.
    reason: str = ""
    #: A typed number's place in its sentence, which tells two numbers in one sentence apart — and which
    #: of several identical sentences it stands in.
    offset: int | None = None
    occurrence: int | None = None


def _addressed(point: dict, quote: str, offset: int | None, occurrence: int | None = None) -> bool:
    return (
        point.get("quote") == quote
        and (offset is None or point.get("offset") == offset)
        and (occurrence is None or int(point.get("occurrence") or 0) == occurrence)
    )


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
    _report, data = report_pipeline.analysis_snapshot(database, report_id, RenderRequest())
    # An open point, or a kept number whose values have moved since: keeping it again confirms it
    # against today's numbers.
    moved = report_typed_numbers.moved(review, data)
    hit = next(
        (
            i
            for i in issues
            if _addressed(i, body.quote, body.offset, body.occurrence)
            and (
                i.get("status") == "open"
                or any(_addressed(m, body.quote, i.get("offset"), int(i.get("occurrence") or 0)) for m in moved)
            )
        ),
        None,
    )
    if hit is None:
        raise PrismError("No open point with this quote.", code="report_point_not_found", status_code=404)
    hit["status"] = "kept"
    hit["resolution"] = body.reason.strip()[:600] or "Kept as written by the author."
    if hit.get("origin") == report_typed_numbers.ORIGIN:
        # The values it was kept against: the out-of-date check names it again once they move.
        hit["kept_results"] = report_typed_numbers.results_fingerprint(data)
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


class ReplaceNumberRequest(BaseModel):
    #: The typed-number point's quote, as the reading stored it.
    quote: str
    #: The placeholder to put in its place — one of the point's candidates.
    path: str
    #: The number's place (`PointRequest.offset`, `PointRequest.occurrence`).
    offset: int | None = None
    occurrence: int | None = None


@router.post(
    "/one/{database}/{report_id}/sections/{section_id}/replace-number",
    summary="Replace a typed number with the placeholder it prints as (no model)",
)
def replace_number(
    request: Request, database: str, report_id: str, section_id: str, body: ReplaceNumberRequest
) -> dict:
    """Put a candidate placeholder where a typed number stands, through the gate like any write.

    Only a candidate the point offers, and only inside the sentence it quotes: this is the author
    carrying out the repair the gate named, not an editor. The write goes through the whole proposal
    transaction — the result must still hold the contract — and keeps the reading: the sentence prints
    what it printed, so what the reader settled stays settled.
    """
    store = ReportStore()
    report = store.get(database, report_id)
    section = _section(report, section_id)
    review = report_review.current_review(section)
    point = next(
        (p for p in report_typed_numbers.typed(review, "open") if _addressed(p, body.quote, body.offset, body.occurrence)), None
    )
    if point is None:
        raise PrismError("No open typed number with this quote.", code="report_point_not_found", status_code=404)
    candidate = next((c for c in point.get("candidates") or [] if c.get("path") == body.path), None)
    if candidate is None:
        raise PrismError(
            f"'{body.path}' is not offered for this number.", code="report_candidate_unknown", status_code=400
        )
    text = str(section.get("text") or "")
    replaced = report_typed_numbers.replace_in(text, point, candidate)
    if replaced is None:
        raise PrismError(
            "The sentence with this number is no longer in the chapter.", code="report_text_moved", status_code=409
        )
    others = [i for i in (review or {}).get("issues") or [] if i.get("origin") != report_typed_numbers.ORIGIN]
    return report_gate.run_section_proposal(
        request,
        database,
        report_id,
        section_id,
        report_gate.ProposalRequest(
            text=replaced,
            store=True,
            keep_numbers=True,
            # The candidates and the chapter's own placeholders are positions in the snapshot the
            # chapter was stored against. Once the numbers have moved, a position may name another
            # member, so the replacement is refused (409) and the chapter wants an update first.
            snapshot_id=point.get("snapshot"),
            lookups=section.get("lookups") or [],
            expected_text_version=text_version(text),
            reviewed_by=(review or {}).get("reviewer"),
            review={**(review or {}), "issues": others},
        ),
    )
