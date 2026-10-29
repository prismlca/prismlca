"""Aggregates all v1 routers under a single include point."""
from __future__ import annotations

from fastapi import APIRouter

from prism_lca.api.v1 import (
    ai,
    bundle,
    calc,
    databases,
    dataimport,
    distances,
    export,
    files,
    interop,
    lcia,
    model,
    params,
    projects,
    provenance,
    report,
    report_ai,
    report_palettes,
    report_review,
    scenarios,
    search,
    setup,
    study,
    system,
    views,
)

api_router = APIRouter()
api_router.include_router(system.router)
api_router.include_router(projects.router)
api_router.include_router(databases.router)
api_router.include_router(model.router)
api_router.include_router(params.router)
api_router.include_router(scenarios.router)
api_router.include_router(study.router)
api_router.include_router(provenance.router)
api_router.include_router(calc.router)
api_router.include_router(lcia.router)
api_router.include_router(report.router)
# Same prefix, second half of the same surface: the chapters a model writes and the checks around
# them. Included after `report` so a shared path prefix keeps the order the two files read in.
api_router.include_router(report_ai.router)
# The second reader's brief for a written chapter (the reader itself runs in the main process).
api_router.include_router(report_review.router)
# The colour sets, built-in and the user's own: the same `/report` prefix, no database in their paths.
api_router.include_router(report_palettes.router)
api_router.include_router(export.router)
api_router.include_router(interop.router)
api_router.include_router(search.router)
api_router.include_router(setup.router)
api_router.include_router(ai.router)
api_router.include_router(files.router)
api_router.include_router(views.router)
api_router.include_router(bundle.router)
api_router.include_router(dataimport.router)
api_router.include_router(distances.router)
