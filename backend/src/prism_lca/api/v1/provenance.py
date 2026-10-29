"""Provenance logs: what the model build researched, and what its internal review found.

Both are logs, not model state — appended by the AI tools as a side effect of doing the work, read
by the report (bibliography, limitations) and by anyone asking how a study knows what it claims.
Neither goes through the command bus: there is nothing to undo about the fact that a question was
asked or a review was run.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import lca, model_scope
from prism_lca.engine.research_log import ResearchLogStore
from prism_lca.engine.review_log import ReviewLogStore

router = APIRouter(prefix="/provenance", tags=["provenance"], dependencies=[Depends(require_token)])


class ResearchLogRequest(BaseModel):
    database: str
    #: ``[{question, findings: [{text, sources: [url]}]}]`` — the shape research_web returns.
    entries: list[dict]


@router.get("/research", summary="What was researched for this model (questions + sourced findings)")
async def get_research(database: str) -> list[dict]:
    return ResearchLogStore().list(database)


@router.post("/research", summary="Record research results for a model (idempotent per finding)")
async def record_research(body: ResearchLogRequest) -> dict:
    model_scope.assert_model_write(body.database)
    return ResearchLogStore().record(body.database, body.entries)


class ReviewLogRequest(BaseModel):
    database: str
    review: str
    gaps: list[str] = []


class ResolutionsRequest(BaseModel):
    database: str
    #: Omitted = the latest review; the usual case, since resolutions follow the review they answer.
    review_id: str | None = None
    #: ``[{finding, resolution: fixed|rejected|open, reason}]``.
    resolutions: list[dict]


@router.get("/review", summary="A model's internal reviews (latest last)")
async def get_reviews(database: str) -> list[dict]:
    return ReviewLogStore().list(database)


@router.post("/review", summary="Record an internal review, stamped with the current model generation")
async def record_review(body: ReviewLogRequest) -> dict:
    model_scope.assert_model_write(body.database)
    # Stamped HERE, not by the caller: the generation is a backend counter the frontend never sees,
    # and it is what later turns "has the model changed since this review?" into a comparison.
    return ReviewLogStore().record_review(
        body.database, body.review, gaps=body.gaps, generation=lca.model_generation()
    )


@router.post("/review/resolutions", summary="Record the builder's outcome per review finding")
async def record_resolutions(body: ResolutionsRequest) -> dict:
    model_scope.assert_model_write(body.database)
    return ReviewLogStore().record_resolutions(body.database, body.resolutions, review_id=body.review_id)
