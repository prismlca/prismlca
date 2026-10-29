"""Result export endpoints — LCIA and contribution as CSV / JSON / XLSX."""
from __future__ import annotations

import base64
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel

from prism_lca.api.v1.deps import MethodRef, require_token
from prism_lca.engine import export, lca

router = APIRouter(prefix="/export", tags=["export"], dependencies=[Depends(require_token)])

_XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

Format = Literal["csv", "json", "xlsx"]


class LciaExportRequest(BaseModel):
    database: str
    code: str
    methods: list[list[str]]
    amount: float = 1.0
    format: Format = "csv"


class ContributionExportRequest(BaseModel):
    database: str
    code: str
    method: MethodRef | None = None
    amount: float = 1.0
    cutoff: float = 0.005
    max_depth: int = 8
    aggregate_by: str | None = None
    format: Format = "csv"


def _safe_stem(stem: str) -> str:
    """Keep the download filename header well-formed: user-controlled codes/names could contain
    quotes or path separators that break Content-Disposition."""
    import re

    return re.sub(r"[^A-Za-z0-9._-]", "_", stem)[:100] or "export"


def _respond(fmt: str, envelope: dict, headers: list[str], rows: list[list], stem: str) -> Response:
    stem = _safe_stem(stem)
    if fmt == "json":
        return JSONResponse(content=envelope)
    if fmt == "xlsx":
        data = export.rows_to_xlsx(headers, rows, stem)
        return Response(
            content=data,
            media_type=_XLSX_MEDIA,
            headers={"Content-Disposition": f'attachment; filename="{stem}.xlsx"'},
        )
    return PlainTextResponse(
        content=export.rows_to_csv(headers, rows),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{stem}.csv"'},
    )


class CompareColumn(BaseModel):
    key: str
    family: str
    label: str
    unit: str | None = None


class CompareSubjectRow(BaseModel):
    label: str
    scores: dict[str, float | None] = {}
    #: The part of the subject this row is — a life-cycle phase, an ISIC section. Set only when the
    #: caller exports a disaggregated sheet; then every row of a subject carries one, and the row
    #: that adds them up carries `total`.
    group: str | None = None
    total: bool = False


class CompareExportRequest(BaseModel):
    columns: list[CompareColumn]
    subjects: list[CompareSubjectRow]
    #: Header for the group column, e.g. "Life-cycle phase". Absent = no such column, one row per
    #: subject, which is what the plain export has always been.
    group_header: str | None = None
    filename: str = "prism-results"


@router.post("/compare-matrix", summary="Export the results matrix as a styled XLSX (base64)")
def export_compare_matrix(body: CompareExportRequest) -> dict:
    data = export.compare_xlsx(
        [c.model_dump() for c in body.columns],
        [s.model_dump() for s in body.subjects],
        group_header=body.group_header,
    )
    stem = (body.filename or "prism-results").strip() or "prism-results"
    return {"filename": f"{stem}.xlsx", "base64": base64.b64encode(data).decode("ascii")}


class FlowExportRow(BaseModel):
    flow: str
    categories: list[str] = []
    impact: float | None = None
    share: float | None = None


class ElementaryFlowsExportRequest(BaseModel):
    scope: str = "Whole system"
    method: list[str] = []
    unit: str | None = None
    total: float | None = None
    flows: list[FlowExportRow]
    filename: str = "prism-elementary-flows"


@router.post("/elementary-flows", summary="Export elementary-flow contributions as XLSX (base64)")
def export_elementary_flows(body: ElementaryFlowsExportRequest) -> dict:
    data = export.flows_xlsx(
        {"scope": body.scope, "method": body.method, "unit": body.unit, "total": body.total},
        [f.model_dump() for f in body.flows],
    )
    stem = _safe_stem((body.filename or "prism-elementary-flows").strip())
    return {"filename": f"{stem}.xlsx", "base64": base64.b64encode(data).decode("ascii")}


class CfMethod(BaseModel):
    method: list[str] = []
    name: str = ""
    unit: str | None = None


class CfFlowRow(BaseModel):
    flow: str
    categories: list[str] = []
    unit: str | None = None
    factors: list[float | None] = []


class LciaFactorsExportRequest(BaseModel):
    methods: list[CfMethod]
    flows: list[CfFlowRow]
    filename: str = "prism-characterization-factors"


@router.post("/lcia-factors", summary="Export characterisation-factor comparison as XLSX (base64)")
def export_lcia_factors(body: LciaFactorsExportRequest) -> dict:
    data = export.lcia_factors_xlsx(
        [m.model_dump() for m in body.methods],
        [f.model_dump() for f in body.flows],
    )
    stem = _safe_stem((body.filename or "prism-characterization-factors").strip())
    return {"filename": f"{stem}.xlsx", "base64": base64.b64encode(data).decode("ascii")}


@router.post("/lcia", summary="Export LCIA scores (csv/json/xlsx)")
def export_lcia(body: LciaExportRequest) -> Response:
    envelope = lca.compute_multi(body.database, body.code, body.methods, body.amount)
    headers, rows = export.lcia_rows(envelope)
    return _respond(body.format, envelope, headers, rows, f"lcia_{body.code}")


@router.post("/contribution", summary="Export contribution tree (csv/json/xlsx)")
def export_contribution(body: ContributionExportRequest) -> Response:
    envelope = lca.contribution(
        body.database, body.code, body.method, body.amount, body.cutoff, body.max_depth,
        body.aggregate_by,
    )
    headers, rows = export.contribution_rows(envelope)
    return _respond(body.format, envelope, headers, rows, f"contribution_{body.code}")
