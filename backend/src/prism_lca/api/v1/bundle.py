"""Model bundles: export a `.prism` file, look inside one, import it.

Three endpoints, and the middle one is the point. `inspect` runs the whole resolution ladder and
reports what would happen **without writing anything**; `import` then applies exactly that. The dry
run is not a courtesy — it is what makes an import something you can look at before it happens, and it
comes from the same pure function, so the preview cannot drift from the deed.

The import is one command on the bus: one undo, one audit entry, and a rollback if it fails halfway.
"""

from __future__ import annotations

import base64

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import bundle as _bundle
from prism_lca.engine import lca, model_scope
from prism_lca.engine.bundle_backgrounds import installed_backgrounds
from prism_lca.engine.bundle_resolve import Verdict, resolve, summary
from prism_lca.errors import PrismError

router = APIRouter(prefix="/bundle", tags=["bundle"], dependencies=[Depends(require_token)])


class ExportRequest(BaseModel):
    database: str
    #: Section names, or a preset name in `preset`. Explicit names win.
    include: list[str] | None = None
    preset: str = "model"


class InspectRequest(BaseModel):
    #: The file, base64 — the renderer reads it from disk and hands it over the IPC bridge.
    content: str


class ImportRequest(BaseModel):
    content: str
    #: Where to put it. Defaults to the name the bundle carries; a suffix is added if that is taken.
    name: str | None = None
    #: Sections to apply. `None` = everything the bundle holds that this version understands.
    include: list[str] | None = None
    #: `{"<database>/<code>": {"database": …, "code": …}}` for references the ladder left ambiguous.
    choices: dict[str, dict] = Field(default_factory=dict)
    source: str = "user"


def _exists(database: str, code: str) -> bool:
    """Whether a chosen dataset is really there: a choice naming a missing one used to pass, and the import
    then failed halfway through writing the model."""
    from prism_lca.engine.bootstrap import get_bd

    bd = get_bd()
    if database not in bd.databases:
        return False
    try:
        bd.Database(database).get(code)
    except Exception:  # noqa: BLE001 - bw2data raises its own UnknownObject; any failure means "not here"
        return False
    return True


def _decode(content: str) -> bytes:
    try:
        return base64.b64decode(content, validate=True)
    except Exception as exc:  # noqa: BLE001 - any decode failure is the same user-facing problem
        raise PrismError(
            "The uploaded bundle could not be read.",
            code="bundle_unreadable",
            hint="Send the file's bytes as base64.",
        ) from exc


@router.post("/presets", summary="Which sections each export preset covers")
async def presets() -> dict:
    return {
        "presets": _bundle.PRESETS,
        "sections": [
            {"name": s.name, "schema": s.schema, "required": s.required, "preset": s.preset}
            for s in _bundle.SECTIONS
        ],
        "extension": _bundle.EXTENSION,
        "format": _bundle.FORMAT,
    }


# `def`, not `async def`: reading a whole model and walking every installed background twice is
# work for the threadpool. On the event loop it held up every other request — a health poll, a
# calculation abort — for the whole scan.
@router.post("/export", summary="Export a model as a .prism bundle")
def export(payload: ExportRequest) -> dict:
    """`{filename, base64, bytes}` — the same shape the PDF export uses.

    Base64 rather than a binary body because the renderer reaches the backend through the IPC bridge,
    which carries JSON; the renderer decodes and offers the download. One transport for every file the
    app hands to the user beats a second one that only this endpoint speaks.
    """
    include = payload.include
    if include is None:
        preset = payload.preset or "model"
        if preset not in _bundle.PRESETS:
            raise PrismError(
                f"Unknown preset '{preset}'.",
                code="bundle_unknown_preset",
                hint=f"One of: {', '.join(sorted(_bundle.PRESETS))}.",
            )
        include = _bundle.PRESETS[preset]
    # Under the lock scenario windows hold: a scenario calculation writes its overrides into the
    # model's parameters and restores them after, and an export read in between shipped the scenario
    # values as the baseline. The project backup has always taken it.
    with lca._LCA_LOCK:
        data = _bundle.export_bundle(payload.database, include)
    safe = "".join(c for c in payload.database if c not in '\\/:*?"<>|').strip() or "model"
    return {
        "filename": f"{safe}{_bundle.EXTENSION}",
        "base64": base64.b64encode(data).decode("ascii"),
        "bytes": len(data),
    }


@router.post("/inspect", summary="What a bundle holds and what would happen (writes nothing)")
def inspect(request: Request, payload: InspectRequest) -> dict:
    del request
    opened = _bundle.read_bundle(_decode(payload.content))
    graph = opened["sections"].get("graph") or {}
    wanted = (opened["manifest"].get("model") or {}).get("name") or ""
    refs = _bundle.bundle_references(opened)
    resolutions = resolve(refs, _bundle.installed_for_bundle(opened))
    return {
        # The user's own datasets travelling with the model — landed in "My processes" on import, counted
        # by the rule the import applies (a dataset here under the same code but another name is new).
        "library": _bundle.library_preview(opened["sections"].get("library")),
        "manifest": opened["manifest"],
        "sections": sorted(opened["sections"]),
        # Named, not silently dropped: the user should see that a newer PrismLCA wrote something
        # here. The first are kept with the model; the second, newer shapes of parts this version
        # knows, cannot be read and are not imported.
        "unreadable_sections": sorted(opened["unknown"]),
        "newer_sections": opened["newer"],
        "model": {
            "name": wanted,
            # What the import will actually call it, and whether that differs — the sheet used to
            # prefill `wanted`, so a collision was invisible until afterwards.
            "suggested_name": _bundle.free_model_name(wanted),
            "name_taken": _bundle.free_model_name(wanted) != wanted,
            "activities": len(graph.get("activities") or []),
            "exchanges": len(graph.get("exchanges") or []),
        },
        "references": [
            {
                "database": r.reference.database,
                "code": r.reference.code,
                "name": r.reference.name,
                "verdict": r.verdict.value,
                "detail": r.detail,
                "target": {"database": r.database, "code": r.code} if r.resolved else None,
                "candidates": r.candidates,
            }
            for r in resolutions
        ],
        "summary": summary(resolutions),
    }


@router.post("/import", summary="Import a bundle (atomic, undoable, refuses on an unresolved link)")
async def import_bundle(request: Request, payload: ImportRequest) -> dict:
    from prism_lca.engine.commands import ImportBundleCommand

    model_scope.assert_no_new_model("import a model")
    opened = _bundle.read_bundle(_decode(payload.content))
    unknown = sorted(set(payload.include or []) - set(_bundle.SECTION_BY_NAME))
    if unknown:
        # The export refuses an unknown name; the import took it in silence and brought the graph alone.
        raise PrismError(
            f"Unknown section(s): {', '.join(unknown)}.",
            code="bundle_unknown_section",
            hint=f"Known sections: {', '.join(s.name for s in _bundle.SECTIONS)}. Nothing has been written.",
        )
    if payload.include is not None and "library" not in payload.include:
        # Without its library section the bundle brings none of its own datasets, so a link into
        # "My processes" resolves only against what is already here — or the import stops before writing.
        refs = _bundle.graph_references(opened["sections"].get("graph") or {})
        resolutions = resolve(refs, installed_backgrounds())
    else:
        resolutions = resolve(_bundle.bundle_references(opened), _bundle.installed_for_bundle(opened))

    # The user's answers for whatever the ladder could not decide alone.
    mapping: dict[tuple[str, str], tuple[str, str]] = {}
    unresolved: list[dict] = []
    for r in resolutions:
        key = f"{r.reference.database}/{r.reference.code}"
        picked = payload.choices.get(key)
        if r.resolved:
            mapping[(r.reference.database, r.reference.code)] = (r.database, r.code)
        elif picked and picked.get("database") and picked.get("code") and _exists(picked["database"], picked["code"]):
            mapping[(r.reference.database, r.reference.code)] = (picked["database"], picked["code"])
        else:
            unresolved.append(
                {
                    "database": r.reference.database,
                    "code": r.reference.code,
                    "name": r.reference.name,
                    "verdict": r.verdict.value,
                    "detail": r.detail,
                    "candidates": r.candidates,
                }
            )

    if unresolved:
        # Nothing is written. The same rule interop.py has: resolve everything first or refuse — a
        # half-linked model is worse than no model, and harder to notice.
        raise PrismError(
            f"{len(unresolved)} background reference(s) could not be resolved.",
            code="bundle_unresolved",
            status_code=409,
            hint="Choose a dataset for each, or import into a workspace that has the right background "
            "database. Nothing has been written.",
        )
    if any(r.verdict is Verdict.version for r in resolutions):
        raise PrismError(
            "The bundle needs a different ecoinvent version than the one installed.",
            code="bundle_version_mismatch",
            status_code=409,
            hint="Import it into a workspace with the matching version. Relinking across "
            "versions changes the numbers, so PrismLCA does not do it silently.",
        )

    command = ImportBundleCommand(
        opened=opened,
        mapping=mapping,
        name=payload.name,
        include=payload.include,
    )
    result = request.app.state.command_bus.execute(command, source=payload.source)
    request.app.state.search.invalidate(result.get("database", ""))
    return result
